import type { ToolContext } from "./types.ts"

/**
 * URL admission for outbound connector requests.
 *
 * Connector endpoints are fixed, but their path segments carry identifiers that
 * originate from model output or user text. This rejects non-HTTP schemes and
 * hosts that resolve into loopback, link-local, or private ranges, so a crafted
 * identifier cannot redirect a read-only database lookup at internal services.
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "instance-data",
])

const BLOCKED_IPV4 = [
  { test: /^0\./, label: "this-network" },
  { test: /^10\./, label: "private" },
  { test: /^127\./, label: "loopback" },
  { test: /^169\.254\./, label: "link-local" },
  { test: /^172\.(1[6-9]|2\d|3[01])\./, label: "private" },
  { test: /^192\.168\./, label: "private" },
  { test: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, label: "carrier-grade NAT" },
  { test: /^198\.(18|19)\./, label: "benchmarking" },
  { test: /^192\.0\.0\./, label: "IETF protocol assignments" },
  { test: /^192\.0\.2\./, label: "documentation" },
  { test: /^198\.51\.100\./, label: "documentation" },
  { test: /^203\.0\.113\./, label: "documentation" },
  { test: /^(224|240)\./, label: "multicast/reserved" },
]

function isBlockedIpv4(host: string): string | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return undefined
  for (const rule of BLOCKED_IPV4) {
    if (rule.test.test(host)) return rule.label
  }
  return undefined
}

function isBlockedIpv6(host: string): string | undefined {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (bare === "::1" || bare === "::") return "loopback"
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return "unique-local"
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return "link-local"
  // IPv4-mapped addresses inherit the IPv4 verdict.
  const mapped = bare.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (mapped) return isBlockedIpv4(mapped[1]) ? `IPv4-mapped ${mapped[1]}` : undefined
  return undefined
}

/** Throws when a URL is not an admissible public HTTP(S) endpoint. */
export function assertAdmissibleUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not an absolute URL: ${raw.slice(0, 120)}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Refusing non-HTTP(S) scheme: ${url.protocol}`)
  }
  const host = url.hostname.toLowerCase()
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error(`Refusing blocked hostname: ${host}`)
  const ipv4 = isBlockedIpv4(host)
  if (ipv4) throw new Error(`Refusing ${ipv4} IPv4 address: ${host}`)
  const ipv6 = isBlockedIpv6(host)
  if (ipv6) throw new Error(`Refusing ${ipv6} IPv6 address: ${host}`)
  return url
}

/** Default whole-request deadline, matching the upstream connector engine. */
const DEFAULT_TIMEOUT_MS = 30_000
/** Default response budget; a few connectors raise this via `maxBytes`. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

export type HttpOptions = {
  accept?: string
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  /** Statuses to treat as success in addition to 2xx. */
  allowStatuses?: number[]
}

/** Performs an admissible request and returns the raw text body. */
export async function httpText(url: string, options: HttpOptions = {}): Promise<string> {
  const target = assertAdmissibleUrl(url)
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  options.signal?.addEventListener("abort", onAbort, { once: true })

  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "opencode-science/0.1 (+https://opencode.ai)",
        accept: options.accept ?? "application/json",
        ...options.headers,
      },
    })
    const allowed = options.allowStatuses?.includes(response.status) ?? false
    if (!response.ok && !allowed) {
      const detail = (await response.text().catch(() => "")).slice(0, 200)
      throw new Error(`${target.hostname} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      throw new Error(`Response from ${target.hostname} exceeded the ${maxBytes} byte budget`)
    }
    return new TextDecoder().decode(buffer)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener("abort", onAbort)
  }
}

/** Performs an admissible request and parses JSON, with a short error excerpt. */
export async function httpJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const text = await httpText(url, { ...options, accept: options.accept ?? "application/json" })
  if (!text.trim()) return undefined as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${new URL(url).hostname} returned a non-JSON body: ${text.slice(0, 160)}`)
  }
}

/**
 * Performs an admissible request and returns the raw body.
 *
 * Used for documents, which are not text. Redirects are followed by hand rather
 * than by the fetch implementation, because the host that answers the first
 * request chooses where to go next: a redirect to a private address would
 * otherwise reach a service that the URL admission check exists to keep out of
 * reach. Every hop is re-checked.
 *
 * The timeout applies to each hop rather than to the whole chain. A document
 * often travels through two or three hosts on its way, and the slow one is
 * usually the last — the one that serves the bytes. A single deadline for the
 * entire chain is spent by the hops before it, and the request is then
 * abandoned with nothing to show.
 */
export async function httpBuffer(
  url: string,
  options: HttpOptions & { maxRedirects?: number; totalTimeoutMs?: number } = {},
): Promise<{ buffer: Buffer; contentType: string | null; finalUrl: string }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = options.maxRedirects ?? 5
  const perHopTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const totalTimeout = options.totalTimeoutMs ?? perHopTimeout * 2
  const deadline = Date.now() + totalTimeout

  let current = assertAdmissibleUrl(url)

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`The request to ${url.slice(0, 120)} ran out of time after ${totalTimeout} ms`)
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), Math.min(perHopTimeout, remaining))
    const onAbort = () => controller.abort()
    options.signal?.addEventListener("abort", onAbort, { once: true })

    try {
      const response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "opencode-science/0.1 (+https://opencode.ai)",
          accept: options.accept ?? "*/*",
          ...options.headers,
        },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        // The body of a redirect is discarded, and the connection released:
        // leaving it unread holds the socket open for the next hop.
        await response.body?.cancel().catch(() => {})
        if (!location) {
          throw new Error(`${current.hostname} returned HTTP ${response.status} with no redirect target`)
        }
        // The next hop is a host the first one chose, so it is admitted on the
        // same terms as the original: a redirect cannot widen the access.
        current = assertAdmissibleUrl(new URL(location, current).toString())
        continue
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200)
        throw new Error(`${current.hostname} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`)
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.byteLength > maxBytes) {
        throw new Error(`Response from ${current.hostname} exceeded the ${maxBytes} byte budget`)
      }
      return { buffer, contentType: response.headers.get("content-type"), finalUrl: current.toString() }
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", onAbort)
    }
  }
  throw new Error(`More than ${maxRedirects} redirects while fetching ${url.slice(0, 120)}`)
}

/** Encodes a path segment so identifiers cannot alter the request path. */
export function seg(value: string | number): string {
  return encodeURIComponent(String(value))
}

/** Serializes a query object, dropping empty values. */
export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

/** Renders tool output compactly, staying within the tool-output budget. */
export function render(value: unknown, maxChars = 40_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[truncated at ${maxChars} of ${text.length} characters]`
}

/**
 * Reads an optional credential.
 *
 * Every credential this plugin accepts improves a request rather than unlocking
 * one: an NCBI key raises the rate limit from 3 to 10 requests a second, an
 * OpenAlex key moves a caller into the keyed pool, and an email puts a request
 * in Crossref's polite pool. So none of them is required, and a connector that
 * has none still works — it just works more slowly, or is identified as an
 * anonymous caller.
 *
 * This replaces `requireCredential`, which nothing called. The three documented
 * options were read into `ctx.credentials` and then never read again, which made
 * setting them look effective while changing nothing.
 */
export function credential(ctx: ToolContext, key: string): string | undefined {
  const value = ctx.credentials[key]
  return value?.trim() ? value.trim() : undefined
}

/**
 * Builds the query parameters an optional credential set contributes.
 *
 * Used for `api_key`, `email` and `mailto`, which the three services spell
 * differently but all accept in the same place.
 */
export function credentialParams(pairs: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [name, value] of Object.entries(pairs)) {
    if (value) params.set(name, value)
  }
  const text = params.toString()
  return text ? `&${text}` : ""
}

/** Caps a returned record list so a broad query cannot flood the context. */
export function limit<T>(items: T[], max: number, label: string): T[] {
  if (items.length <= max) return items
  throw new Error(
    `${label} returned ${items.length} records, above the ${max} record limit. Narrow the query.`,
  )
}