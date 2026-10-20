/**
 * Literature identifiers.
 *
 * Everything downstream — deduplication, citation lookup, screening history —
 * keys on identifiers, so they have to be normalized to one canonical form
 * before anything else runs. A DOI pasted as a URL, wrapped in `doi:` and
 * trailed by a citation comma is one identifier, and treating it as four is
 * how a library ends up with duplicate entries for the same paper.
 *
 * Adapted from the upstream literature-citations contracts (Apache-2.0). The
 * per-scheme normalization, the URL builders, and the preference ordering are
 * preserved; the Zod schemas are replaced with structural types.
 */

/** Schemes that can identify a work on its own. */
export const IDENTITY_SCHEMES = ["doi", "pmid", "pmcid", "arxiv"] as const

/** Schemes that can appear on a record without identifying it alone. */
export const IDENTIFIER_SCHEMES = [...IDENTITY_SCHEMES, "isbn", "issn", "other"] as const

export type IdentityScheme = (typeof IDENTITY_SCHEMES)[number]
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number]

export type Identifier = {
  scheme: IdentifierScheme
  value: string
  isPrimary: boolean
}

export type Creator =
  | { nameMode: "person"; givenName: string; familyName: string; creatorType: string }
  | { nameMode: "organization"; literalName: string; creatorType: string }

export type ItemType =
  | "journalArticle"
  | "review"
  | "preprint"
  | "conferencePaper"
  | "book"
  | "bookSection"
  | "thesis"
  | "report"
  | "dataset"
  | "standard"
  | "patent"
  | "webpage"
  | "document"

/** One work, in the shape the whole library shares. */
export type BibliographicRecord = {
  itemType: ItemType
  title: string
  abstract: string
  /** Date as written by the source, e.g. "2021-07-15" or "Summer 2021". */
  issuedText: string
  issuedYear?: number
  containerTitle: string
  shortTitle: string
  language: string
  rights: string
  url: string
  citationKey?: string
  extra: string
  typeFields: Record<string, unknown>
  creators: Creator[]
  identifiers: Identifier[]
  /**
   * The work's own text, when it has been read.
   *
   * Carries its provenance rather than being a bare string: a screening decision
   * made from full text has to be traceable to the extraction that produced it,
   * the same way a decision from an abstract is traceable to the source that
   * supplied the abstract.
   */
  fullText?: FullText
}

/** Extracted body text, with the provenance of the extraction. */
export type FullText = {
  /** Page count of the source document. */
  pages: number
  /** Characters of text extracted. */
  characters: number
  /** Which extractor produced this, e.g. "pymupdf". */
  extractor: string
  /** Where the document came from. */
  source: string
  retrievedAt: string
  /** Section headings detected in the text, in order. */
  sections: { title: string; page: number }[]
  /**
   * The text itself.
   *
   * Held in the workspace store rather than inlined into the tool response, so a
   * screening pass over a long paper does not push the whole article through
   * the context on every call.
   */
  path: string
  /**
   * How the document was tied to this record when it was attached.
   *
   * Absent on text attached before the check existed, and on text attached with
   * `allowMismatch`: those carry no claim that the PDF is the right paper.
   */
  identity?: {
    confirmedBy?: "doi" | "title"
    titleOverlap?: number
    /** Set when the check failed and the caller attached it anyway. */
    overridden?: boolean
  }
}

/**
 * Index of the last line break.
 *
 * Suffix matching must not retry an unbounded tail at every possible starting
 * point, so stripping only ever looks at the final line of the value. This is
 * upstream's rule, kept because a scanned citation list puts the junk that
 * needs stripping on its own last line.
 */
function lastLineBreak(value: string): number {
  return Math.max(
    value.lastIndexOf("\n"),
    value.lastIndexOf("\r"),
    value.lastIndexOf("\u2028"),
    value.lastIndexOf("\u2029"),
  )
}

/**
 * Removes a trailing "Copyright ..." block.
 *
 * A publisher's rights line often survives pasting. The search starts one line
 * up so that the separator itself may be the final line break.
 */
function stripDoiCopyright(value: string): string {
  const start = Math.max(0, lastLineBreak(value) - "Copyright".length)
  const suffix = /Copyright(?:\s|$)/iu.exec(value.slice(start))
  return suffix ? value.slice(0, start + suffix.index) : value
}

/**
 * Normalizes one identifier to its canonical form.
 *
 * Each scheme is handled separately because the junk that accumulates differs:
 * a DOI picks up URL prefixes and trailing punctuation, a PMID picks up a
 * browser URL, a PMCID may arrive with or without its `PMC` prefix, and an
 * arXiv id carries a version suffix and sometimes a `.pdf`.
 */
export function normalizeIdentifierValue(scheme: IdentifierScheme, value: string): string {
  const trimmed = value.trim()

  if (scheme === "doi") {
    const candidate = stripDoiCopyright(
      trimmed.replace(/^doi:\s*/iu, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, ""),
    )
    let end = candidate.length
    // Trailing punctuation is almost always citation syntax, not part of the DOI.
    while (end > 0 && ".,;:)}]".includes(candidate[end - 1])) end--
    return candidate.slice(0, end).trim()
  }

  if (scheme === "pmid") {
    const candidate = trimmed.replace(/^PMID\s*:\s*/iu, "")
    return (
      /^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)\/?(?:[?#].*)?$/iu.exec(candidate)?.[1] ??
      candidate
    )
  }

  if (scheme === "pmcid") {
    const candidate = trimmed.replace(/^PMCID\s*:\s*/iu, "")
    const fromUrl =
      /^https?:\/\/(?:pmc\.ncbi\.nlm\.nih\.gov\/articles\/(PMC\d+)|(?:www\.)?ncbi\.ncbi\.nlm\.nih\.gov\/pmc\/articles\/(PMC\d+))\/?(?:[?#].*)?$/iu.exec(
        candidate,
      )
    const withoutUrl = fromUrl?.[1] ?? fromUrl?.[2] ?? candidate
    const digits = /^(?:PMC)?(\d+)$/iu.exec(withoutUrl)?.[1]
    return digits ? `PMC${digits}` : withoutUrl.toUpperCase()
  }

  if (scheme === "arxiv") {
    const candidate = trimmed
      .replace(/^arxiv:\s*/iu, "")
      .replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//iu, "")
    const start = lastLineBreak(candidate) + 1
    const suffix = /[?#]/u.exec(candidate.slice(start))
    const withoutQuery = suffix ? candidate.slice(0, start + suffix.index) : candidate
    // The version suffix is part of the identifier upstream but not part of the
    // work, so it is dropped to keep v1 and v2 of one preprint together.
    return withoutQuery
      .replace(/\.pdf$/iu, "")
      .replace(/v\d+$/iu, "")
      .trim()
  }

  return trimmed
}

/**
 * Builds the canonical resolver URL for an identifier.
 *
 * Returns undefined when the normalized value does not match the scheme's
 * shape: a DOI-shaped string that fails the registrant pattern is not a DOI,
 * and producing a URL for it would create a link that cannot resolve.
 */
export function identifierUrl(scheme: IdentifierScheme, value: string): string | undefined {
  const normalized = normalizeIdentifierValue(scheme, value)

  if (scheme === "doi" && /^10\.\d{4,9}\/\S+$/u.test(normalized)) {
    // The prefix is a single path segment; the suffix can contain slashes.
    const encoded = normalized.split("/").map(encodeURIComponent).join("/")
    return `https://doi.org/${encoded}`
  }
  if (scheme === "pmid" && /^\d+$/u.test(normalized)) {
    return `https://pubmed.ncbi.nlm.nih.gov/${normalized}/`
  }
  if (scheme === "pmcid" && /^PMC\d+$/u.test(normalized)) {
    return `https://pmc.ncbi.nlm.nih.gov/articles/${normalized}/`
  }
  if (scheme === "arxiv" && /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu.test(normalized)) {
    const encoded = normalized.split("/").map(encodeURIComponent).join("/")
    return `https://arxiv.org/abs/${encoded}`
  }
  return undefined
}

/** True when the value is well-formed enough to act on for that scheme. */
export function isValidIdentifier(scheme: IdentifierScheme, value: string): boolean {
  const normalized = normalizeIdentifierValue(scheme, value)
  if (!normalized) return false
  switch (scheme) {
    case "doi":
      return /^10\.\d{4,9}\/\S+$/u.test(normalized)
    case "pmid":
      return /^\d+$/u.test(normalized)
    case "pmcid":
      return /^PMC\d+$/u.test(normalized)
    case "arxiv":
      return /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu.test(normalized)
    default:
      return true
  }
}

/** Picks the identifier of one scheme to treat as primary. */
function preferredIdentifier(
  identifiers: readonly Identifier[],
  scheme: IdentifierScheme,
): Identifier | undefined {
  return identifiers
    .filter((identifier) => identifier.scheme === scheme)
    .sort((a, b) => {
      const priority = Number(b.isPrimary) - Number(a.isPrimary)
      const left = normalizeIdentifierValue(scheme, a.value).toLowerCase()
      const right = normalizeIdentifierValue(scheme, b.value).toLowerCase()
      // Case-insensitive first so two spellings of one id cannot both win, then
      // a stable total order so the choice does not depend on input order.
      return (
        priority ||
        (left < right ? -1 : left > right ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0)
      )
    })[0]
}

/**
 * Normalizes a whole identifier list: values canonical, at most one primary
 * per scheme.
 *
 * Leaving two primaries for one scheme makes "the DOI of this item" ambiguous,
 * which is a property of the record rather than of the caller.
 */
export function normalizeIdentifiers(identifiers: readonly Identifier[]): Identifier[] {
  // Group by normalized value, not by object. Identifiers are unioned as
  // metadata is completed, so the same PMID can arrive twice: once from the
  // record itself and once from a provider that echoes it back. Keeping both
  // would make every later comparison of this record see two of the same work.
  const claimed = new Set<string>()
  const out: Identifier[] = []

  for (const identifier of identifiers) {
    const value = normalizeIdentifierValue(identifier.scheme, identifier.value)
    const key = `${identifier.scheme}:${value.toLowerCase()}`
    if (claimed.has(key)) continue

    claimed.add(key)
    out.push({
      scheme: identifier.scheme,
      value,
      // Only the first occurrence can be primary; a duplicate cannot outrank
      // the entry it duplicates.
      isPrimary: identifier.isPrimary,
    })
  }

  return out
}

/**
 * The canonical key for deduplication.
 *
 * Records are the same work when they share any identity identifier. Scheme is
 * part of the key: `12345678` as a PMID is a different thing from the same
 * digits used as something else.
 */
export function recordKey(record: Pick<BibliographicRecord, "identifiers">): string | undefined {
  for (const scheme of IDENTITY_SCHEMES) {
    const found = record.identifiers.find(
      (identifier) => identifier.scheme === scheme && isValidIdentifier(scheme, identifier.value),
    )
    if (found) return `${scheme}:${normalizeIdentifierValue(scheme, found.value).toLowerCase()}`
  }
  return undefined
}

/**
 * Strips an explicit scheme prefix, e.g. `doi:10.1/x` or `PMID: 26633628`.
 *
 * The prefix carries no information beyond the scheme it names, and it is the
 * form the rest of this tool emits: `os_literature_list` reports identifiers as
 * `{scheme, value}` pairs, so a reader copying one back out writes
 * `pmid:26633628`. Accepting what we print is not optional — rejecting it makes
 * every round-trip of an identifier fail.
 *
 * Only a recognized scheme name is stripped. `arctan:1` must stay intact, and
 * stripping an unrecognized prefix would silently turn an unrelated string into
 * a malformed identifier rather than leaving it unrecognized.
 */
const SCHEME_PREFIX = /^([a-z][a-z0-9]*)\s*:\s*(?=\S)/iu

export function stripSchemePrefix(text: string): { scheme?: IdentifierScheme; rest: string } {
  const match = SCHEME_PREFIX.exec(text.trim())
  if (!match) return { rest: text }

  const named = match[1].toLowerCase()
  // Longest first so "pmcid" is not read as "pmc" plus "id".
  const candidates: IdentifierScheme[] = ["pmcid", "arxiv", "pmid", "doi", "isbn", "issn", "other"]
  const scheme = candidates.find((candidate) => candidate === named)
  if (!scheme) return { rest: text }

  return { scheme, rest: text.trim().slice(match[0].length) }
}

/**
 * Guesses a scheme from free text.
 *
 * Order matters: a `doi.org` URL also matches the general URL test, and a
 * PubMed URL mentions PMID only in the path.
 */
export function detectScheme(value: string): IdentifierScheme | undefined {
  // A declared prefix is authoritative and is consulted first. `doi:10.x/y`
  // matches the bare-DOI test too, but `pmid:abc` matches nothing else, so
  // stripping first is what makes the prefixed spellings work at all.
  const prefixed = stripSchemePrefix(value)
  if (prefixed.scheme) return prefixed.scheme

  const text = prefixed.rest.trim()
  if (/^https?:\/\/(?:dx\.)?doi\.org\//iu.test(text)) return "doi"
  if (/^10\.\d{4,9}\//u.test(text)) return "doi"
  if (/^https?:\/\/(?:www\.)?pubmed\.ncbi\.nlm\.nih\.gov\//iu.test(text)) return "pmid"
  if (/^https?:\/\/(?:pmc\.|www\.ncbi\.nbi\.nlm\.gov\/pmc)/iu.test(text)) return "pmcid"
  if (/^https?:\/\/(?:www\.)?arxiv\.org\//iu.test(text)) return "arxiv"
  if (/^PMC\d+$/iu.test(text)) return "pmcid"
  if (/^\d{7,8}$/u.test(text)) return "pmid"
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/u.test(text)) return "arxiv"
  if (/^[a-z][a-z.-]*\/\d{7}(?:v\d+)?$/iu.test(text)) return "arxiv"
  return undefined
}

/** Normalizes free text into an identifier, when a scheme can be inferred. */
export function parseIdentifier(text: string): Identifier | undefined {
  const scheme = detectScheme(text)
  if (!scheme) return undefined
  // Normalize the remainder, not the original: each scheme's normalizer strips
  // its own prefix too, but they do not all cover every spelling (the `other`
  // scheme strips none), so the prefix is removed once here for all of them.
  const value = normalizeIdentifierValue(scheme, stripSchemePrefix(text).rest)
  if (!isValidIdentifier(scheme, value)) return undefined
  return { scheme, value, isPrimary: true }
}