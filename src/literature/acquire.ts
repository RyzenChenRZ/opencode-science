/**
 * Open-access document acquisition.
 *
 * The library could hold a paper's abstract but not the paper itself, so a
 * full-text screening pass was only reachable if the user happened to have the
 * PDF already. This module finds an open-access copy of a record's paper and
 * downloads it.
 *
 * What it learned from the live services:
 *
 *   - Unpaywall indexes every OA copy and needs only a contact email, but it
 *     has no entry for a paper that is not OA at all.
 *   - OpenAlex carries a `best_oa_location` and a per-location list, and needs
 *     no key, so it is the fallback when Unpaywall has nothing.
 *   - Europe PMC holds the full text of its OA corpus and serves it as JATS
 *     XML, which is the one full-text source that never bot-blocks.
 *   - arXiv serves PDFs directly and never blocks.
 *
 * The publishers themselves mostly do block: Nature, Europe PMC's renderer,
 * bioRxiv and PMC all answer a request for a PDF with an HTML page. So a
 * download is verified by its bytes rather than by its content type, and the
 * attempts that failed are reported with the reason.
 */

import { httpBuffer, httpJson, httpText, credential } from "../http.ts"
import { writeFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { ToolContext } from "../types.ts"

/** How large a downloaded document may be before it is refused. */
const MAX_DOCUMENT_BYTES = 60 * 1024 * 1024

/** Where downloaded documents are kept, inside the workspace. */
const PDF_DIR = ".opencode-science/pdfs"

/** One candidate location for a document. */
export type DocumentCandidate = {
  url: string
  /** Which service offered this location. */
  source: string
  /** Human description of where it came from. */
  label: string
  /** Set when the service says the copy is not the published version. */
  version?: string
}

export type AcquisitionResult = {
  ok: boolean
  url?: string
  source?: string
  label?: string
  bytes?: number
  path?: string
  contentType?: string
  reason?: string
  /** Every location that was tried, with why it did not work. */
  attempts?: { url: string; source: string; reason: string }[]
}

/** True when the bytes are a PDF rather than an HTML page served as one. */
export function looksLikePdf(buffer: Buffer): boolean {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-"
}

/**
 * The contact address Unpaywall requires.
 *
 * Unpaywall refuses a request with no email, and the address is used only to
 * identify the caller. The NCBI contact email is reused when it is configured,
 * since it is already an address the user has given this plugin for exactly
 * this kind of request.
 */
function contactEmail(ctx: ToolContext): string | undefined {
  return credential(ctx, "ncbiEmail") ?? credential(ctx, "contactEmail")
}

/** The DOI of a record, if it has one. */
function doiOf(identifiers: readonly { scheme: string; value: string }[]): string | undefined {
  const doi = identifiers.find((identifier) => identifier.scheme === "doi")
  return doi ? doi.value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : undefined
}

/** The PMID of a record, if it has one. */
function pmidOf(identifiers: readonly { scheme: string; value: string }[]): string | undefined {
  const pmid = identifiers.find((identifier) => identifier.scheme === "pmid")
  return pmid ? pmid.value : undefined
}

/**
 * Every open-access location Unpaywall knows for a DOI.
 *
 * Unpaywall asks for an email and answers 422 without one, so the request is
 * only made when there is an address to give it. The caller is told when it
 * was skipped, because Unpaywall indexes the most open-access copies and its
 * absence is why fewer papers are reachable.
 */
export async function unpaywallLocations(
  doi: string,
  ctx: ToolContext,
): Promise<{ candidates: DocumentCandidate[]; skipped?: string }> {
  const email = contactEmail(ctx)
  if (!doi) return { candidates: [], skipped: "The record has no DOI, so Unpaywall cannot be asked for it." }
  if (!email) {
    return {
      candidates: [],
      skipped:
        "Unpaywall needs a contact email and none is configured, so it was not asked. Set ncbiEmail in " +
        "the plugin options to reach it — it indexes the most open-access copies of any source.",
    }
  }
  const data = await httpJson<any>(
    `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(email)}`,
    { signal: ctx.signal },
  )
  const out: DocumentCandidate[] = []
  const seen = new Set<string>()
  const locations = [data?.best_oa_location, ...(data?.oa_locations ?? [])].filter(Boolean)
  for (const location of locations) {
    const url = location?.url_for_pdf
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({
      url,
      source: "unpaywall",
      label: location?.host_type === "repository" ? "repository copy" : "publisher copy",
      version: location?.version,
    })
  }
  return { candidates: out }
}

/**
 * Every open-access location OpenAlex knows for a DOI or PMID.
 *
 * OpenAlex needs no key, so it covers the case where Unpaywall has no entry.
 * Its `locations` list distinguishes copies that are openly readable from ones
 * that are only a landing page, so only the former are offered.
 */
export async function openAlexLocations(
  identifiers: readonly { scheme: string; value: string }[],
  ctx: ToolContext,
): Promise<DocumentCandidate[]> {
  const doi = doiOf(identifiers)
  const pmid = pmidOf(identifiers)
  const key = doi ? `doi:${doi}` : pmid ? `pmid:${pmid}` : undefined
  if (!key) return []

  const data = await httpJson<any>(
    `https://api.openalex.org/works/${encodeURIComponent(key)}?select=id,title,open_access,best_oa_location,locations`,
    { signal: ctx.signal },
  )
  const out: DocumentCandidate[] = []
  const seen = new Set<string>()
  const locations = [data?.best_oa_location, ...(data?.locations ?? [])].filter(Boolean)
  for (const location of locations) {
    const url = location?.pdf_url
    if (!url || seen.has(url)) continue
    // A location with no PDF is a landing page, and fetching it yields HTML
    // rather than a document.
    if (location?.is_oa === false && !location?.pdf_url) continue
    seen.add(url)
    out.push({
      url,
      source: "openalex",
      label: location?.source?.display_name ?? "open-access copy",
      version: location?.version,
    })
  }
  return out
}

/** An arXiv PDF for a record, when it has an arXiv identifier. */
export function arxivLocation(identifiers: readonly { scheme: string; value: string }[]): DocumentCandidate | undefined {
  const arxiv = identifiers.find((identifier) => identifier.scheme === "arxiv")
  if (!arxiv) return undefined
  // The id may carry a version suffix, which the PDF endpoint does not want.
  const id = arxiv.value.replace(/^arxiv:/i, "").replace(/v\d+$/, "")
  return { url: `https://arxiv.org/pdf/${encodeURIComponent(id)}`, source: "arxiv", label: "arXiv preprint" }
}

/**
 * Downloads a document from the first location that yields real PDF bytes.
 *
 * A location that answers with an HTML page — which is what a publisher's
 * bot-block looks like — is recorded as a failed attempt rather than being
 * saved as the paper. The bytes are what decide, not the content type.
 */
export async function downloadDocument(
  candidates: DocumentCandidate[],
  destination: string,
  ctx: ToolContext,
): Promise<AcquisitionResult> {
  const attempts: { url: string; source: string; reason: string }[] = []

  for (const candidate of candidates) {
    try {
      const { buffer, contentType, finalUrl } = await httpBuffer(candidate.url, {
        signal: ctx.signal,
        maxBytes: MAX_DOCUMENT_BYTES,
        // A document travels through two or three hosts, and the last one is
        // usually the slowest: it serves the megabytes. A single 30 second
        // budget for the whole chain is spent before the bytes arrive.
        timeoutMs: 90_000,
        totalTimeoutMs: 180_000,
        headers: { accept: "application/pdf,*/*" },
      })

      if (!looksLikePdf(buffer)) {
        // The common failure: the host served a page, not a document.
        const kind = contentType?.split(";")[0] ?? "an unknown type"
        attempts.push({
          url: candidate.url,
          source: candidate.source,
          reason: `served ${kind} rather than a PDF (${buffer.byteLength} bytes)`,
        })
        continue
      }

      await mkdir(join(ctx.workspace, PDF_DIR), { recursive: true })
      await writeFile(destination, buffer)

      return {
        ok: true,
        url: finalUrl,
        source: candidate.source,
        label: candidate.label,
        bytes: buffer.byteLength,
        path: destination,
        contentType: contentType ?? undefined,
        attempts: attempts.length ? attempts : undefined,
      }
    } catch (error) {
      attempts.push({
        url: candidate.url,
        source: candidate.source,
        reason: (error as Error).message,
      })
    }
  }

  return {
    ok: false,
    reason: candidates.length
      ? "No open-access location served a PDF. Each attempt is listed."
      : "No open-access copy of this paper is known to Unpaywall or OpenAlex.",
    attempts: attempts.length ? attempts : undefined,
  }
}

/**
 * The Europe PMC full text of a paper, as plain text.
 *
 * Some papers have no downloadable PDF at all — the publisher blocks it, and
 * the repository copy needs a request Europe PMC refuses. Its JATS XML is
 * public and complete, so it serves as the full text of last resort.
 */
export async function downloadEuropePmcText(
  pmcid: string,
  destination: string,
  ctx: ToolContext,
): Promise<{ ok: boolean; reason?: string; characters?: number; path?: string }> {
  try {
    const xml = await httpText(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(pmcid)}/fullTextXML`,
      { signal: ctx.signal, accept: "application/xml,text/xml", maxBytes: 20 * 1024 * 1024, timeoutMs: 60_000 },
    )
    const text = jatsToText(xml)
    if (text.trim().length < 500) {
      return { ok: false, reason: `Europe PMC returned only ${text.trim().length} characters of text for ${pmcid}.` }
    }
    await mkdir(join(ctx.workspace, PDF_DIR), { recursive: true })
    await writeFile(destination, text, "utf8")
    return { ok: true, characters: text.length, path: destination }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }
}

/**
 * The Europe PMC identifier of a paper, found by its DOI or PMID.
 *
 * A record collected from PubMed or OpenAlex usually carries no PMCID, but
 * Europe PMC indexes the same paper and can say which of its records it is.
 * Without this, the one full-text source that never bot-blocks would only be
 * reachable for a record that happened to arrive carrying a PMCID.
 */
export async function europePmcIdentifier(
  identifiers: readonly { scheme: string; value: string }[],
  ctx: ToolContext,
): Promise<{ pmcid: string; source: "pmcid" | "doi" | "pmid" } | undefined> {
  const existing = identifiers.find((i) => i.scheme === "pmcid")
  if (existing) return { pmcid: existing.value, source: "pmcid" }

  const doi = identifiers.find((i) => i.scheme === "doi")?.value
  const pmid = identifiers.find((i) => i.scheme === "pmid")?.value
  const query = doi ? `DOI:${doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}` : pmid ? `EXT_ID:${pmid}` : undefined
  if (!query) return undefined

  const data = await httpJson<any>(
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(query)}&resultType=core&format=json&pageSize=1`,
    { signal: ctx.signal },
  )
  const result = data?.resultList?.result?.[0]
  if (!result?.pmcid) return undefined
  // Only an open-access record has a full-text XML to serve.
  if (result.isOpenAccess !== "Y" && !result.inEPMC) return undefined
  return { pmcid: result.pmcid, source: doi ? "doi" : "pmid" }
}

/**
 * Flattens JATS XML into readable plain text.
 *
 * The body is a tree of `<sec>` elements, each with a `<title>` and paragraphs
 * of `<p>`. Section headings are kept on their own lines so the result reads
 * like a paper rather than like a wall of text, and the tags that carry no
 * meaning for a reader are dropped.
 */
export function jatsToText(xml: string): string {
  const body = xml.match(/<body\b[\s\S]*?<\/body>/i)?.[0] ?? xml
  const parts: string[] = []
  for (const match of body.matchAll(/<sec\b[\s\S]*?<\/sec>/gi)) {
    // Only the outermost section of a match is used, so a nested subsection is
    // not repeated.
    const section = match[0]
    const heading = section.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""
    const paragraphs = [...section.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((paragraph) => stripMarkup(paragraph[1]))
      .filter((paragraph) => paragraph.length > 0)
    if (!paragraphs.length) continue
    if (heading) parts.push(stripMarkup(heading))
    parts.push(paragraphs.join("\n\n"))
  }
  if (!parts.length) {
    // A record with no <body> still has an abstract, and the abstract is
    // better than nothing.
    const abstract = xml.match(/<abstract\b[\s\S]*?<\/abstract>/i)?.[0] ?? ""
    if (abstract) parts.push(stripMarkup(abstract))
  }
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Removes markup and entities, leaving the readable text. */
function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

export { PDF_DIR }
