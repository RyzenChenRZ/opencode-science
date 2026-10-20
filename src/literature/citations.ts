/**
 * Citation network.
 *
 * A paper's neighbourhood is two lists: the works it cites, and the works that
 * cite it. A review usually needs both — the second to find the seminal
 * studies, the first to check what the paper was built on.
 *
 * What the live services actually do:
 *
 *   - OpenAlex's `cites:` filter returns the works that cite a given work.
 *   - OpenAlex's `referenced_works:` filter returns the *same* set, not the
 *     other direction. Reading the two as opposites is a trap: the count came
 *     back identical for both. The works a paper cites are only in its
 *     `referenced_works` field, and have to be fetched by id.
 *   - Crossref carries a reference list on the work itself, with DOIs where
 *     the publisher deposited them, which is the most precise source for
 *     "what does this paper cite".
 *   - Europe PMC lists references and citations for MED records, keyed by PMID
 *     rather than PMCID.
 *
 * So the references of a paper are read from the work's own reference list and
 * resolved, while the citing works are read from a filter. The two directions
 * are never inferred from one another.
 */

import { httpJson } from "../http.ts"
import type { ToolContext } from "../types.ts"

/** One work in a citation list. */
export type CitationRecord = {
  id?: string
  title: string
  year?: number
  doi?: string
  /** How many times this work has been cited, when the source reports it. */
  citedBy?: number
  /** The open-access id this work is known by. */
  openAlexId?: string
  authors?: string[]
  venue?: string
}

/** The neighbourhood of a work. */
export type CitationNeighbourhood = {
  /** The work the query resolved to. */
  subject?: { id?: string; title?: string; year?: number; doi?: string; openAlexId?: string; citedBy?: number }
  /** Works the subject cites. */
  references: CitationRecord[]
  /** Works that cite the subject. */
  citations: CitationRecord[]
  /** Which service each list came from. */
  sources: { references?: string; citations?: string }
  /** Where a list could not be produced, and why. */
  unavailable?: { list: "references" | "citations"; reason: string }[]
  /** The totals the source reports, which exceed what was returned. */
  totals?: { references?: number; citations?: number }
  /** How many of the listed references the service could name. */
  resolvedReferences?: number
}

/** The OpenAlex id of a work, from a DOI or PMID. */
export async function openAlexId(
  identifiers: readonly { scheme: string; value: string }[],
  ctx: ToolContext,
): Promise<{ id: string; title?: string; year?: number; doi?: string; citedBy?: number } | undefined> {
  const doi = identifiers.find((i) => i.scheme === "doi")
  const pmid = identifiers.find((i) => i.scheme === "pmid")
  const key = doi
    ? `doi:${doi.value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")}`
    : pmid
      ? `pmid:${pmid.value}`
      : undefined
  if (!key) return undefined

  const data = await httpJson<any>(
    `https://api.openalex.org/works/${encodeURIComponent(key)}?select=id,title,publication_year,doi,cited_by_count,referenced_works`,
    { signal: ctx.signal },
  )
  if (!data?.id) return undefined
  return {
    id: data.id,
    title: data.title,
    year: data.publication_year,
    doi: data.doi ? String(data.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : undefined,
    citedBy: data.cited_by_count,
  }
}

/**
 * The works a subject cites.
 *
 * Read from the work's own `referenced_works` list and then resolved in
 * batches, because the list holds OpenAlex ids and not papers.
 *
 * The accounting distinguishes three numbers, because conflating them makes
 * the result look broken when it is not: how many references the work lists,
 * how many of those the service could name, and how many are returned here.
 * A list of 59 whose ids are resolved in batches will come back with fewer
 * than 59 papers — some ids are records the service does not serve — and
 * saying "54 could not be resolved" when only 40 were ever looked up is a
 * different claim from the truth.
 */
export async function referencedWorks(
  openAlexId: string,
  limit: number,
  ctx: ToolContext,
): Promise<{ records: CitationRecord[]; total: number; resolved: number; queried: number }> {
  const subject = await httpJson<any>(
    `https://api.openalex.org/works/${encodeURIComponent(openAlexId)}?select=id,referenced_works`,
    { signal: ctx.signal },
  )
  const ids: string[] = (subject?.referenced_works ?? [])
    .map((value: string) => String(value).split("/").pop() ?? "")
    .filter(Boolean)

  if (!ids.length) return { records: [], total: 0, resolved: 0, queried: 0 }

  // OpenAlex accepts an OR of ids in one filter, but a long list makes an
  // unwieldy URL, so the ids are fetched in batches. Every id is looked up:
  // the list of what a paper cites is the point, and stopping early because
  // the caller only wants a few of them would make the totals a fiction.
  const batchSize = 40
  const records: CitationRecord[] = []
  let queried = 0
  for (let start = 0; start < ids.length; start += batchSize) {
    const batch = ids.slice(start, start + batchSize)
    queried += batch.length
    const data = await httpJson<any>(
      `https://api.openalex.org/works?filter=${encodeURIComponent(`openalex_id:${batch.join("|")}`)}` +
        `&per-page=${batchSize}&select=id,title,publication_year,doi,cited_by_count,authorships,primary_location`,
      { signal: ctx.signal },
    )
    for (const work of data?.results ?? []) {
      records.push({
        id: work.id,
        openAlexId: String(work.id ?? "").split("/").pop(),
        title: work.title ?? "",
        year: work.publication_year,
        doi: work.doi ? String(work.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : undefined,
        citedBy: work.cited_by_count,
        authors: (work.authorships ?? [])
          .map((a: any) => a?.author?.display_name)
          .filter((name: unknown): name is string => typeof name === "string")
          .slice(0, 8),
        venue: work.primary_location?.source?.display_name,
      })
    }
  }

  return { records, total: ids.length, resolved: records.length, queried }
}

/**
 * The works that cite a subject.
 *
 * Read from the `cites:` filter, which is the direction that filter actually
 * means.
 */
export async function citingWorks(
  openAlexId: string,
  limit: number,
  ctx: ToolContext,
): Promise<{ records: CitationRecord[]; total: number }> {
  const data = await httpJson<any>(
    `https://api.openalex.org/works?filter=${encodeURIComponent(`cites:${openAlexId}`)}` +
      `&per-page=${limit}&select=id,title,publication_year,doi,cited_by_count,authorships,primary_location`,
    { signal: ctx.signal },
  )
  const records: CitationRecord[] = (data?.results ?? []).map((work: any) => ({
    id: work.id,
    openAlexId: String(work.id ?? "").split("/").pop(),
    title: work.title ?? "",
    year: work.publication_year,
    doi: work.doi ? String(work.doi).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : undefined,
    citedBy: work.cited_by_count,
    authors: (work.authorships ?? [])
      .map((a: any) => a?.author?.display_name)
      .filter((name: unknown): name is string => typeof name === "string")
      .slice(0, 8),
    venue: work.primary_location?.source?.display_name,
  }))
  return { records, total: Number(data?.meta?.count ?? records.length) }
}

/**
 * The references of a work, from Crossref's own reference list.
 *
 * Crossref's list is the publisher's deposit, so it is the most accurate
 * statement of what a paper cites — but only for works whose publisher
 * deposited references, and a reference is often a bare DOI with no title.
 * The DOI is kept even when the title is unknown, because a DOI resolves.
 */
export async function crossrefReferences(
  doi: string,
  limit: number,
  ctx: ToolContext,
): Promise<{ records: CitationRecord[]; total: number; withDoi: number }> {
  const data = await httpJson<any>(
    `https://api.crossref.org/works/${encodeURIComponent(doi)}`,
    { signal: ctx.signal },
  )
  const references: any[] = data?.message?.reference ?? []
  const records: CitationRecord[] = []
  let withDoi = 0
  for (const reference of references) {
    if (records.length >= limit) break
    const referenceDoi = reference?.DOI ? String(reference.DOI) : undefined
    if (referenceDoi) withDoi += 1
    // The unstructured form is the only title available for many references.
    const title = reference?.["article-title"] ?? reference?.["volume-title"] ?? reference?.unstructured ?? ""
    records.push({
      title: String(title).replace(/\s+/g, " ").trim().slice(0, 300),
      doi: referenceDoi,
      year: reference?.year ? Number(reference.year) : undefined,
      venue: reference?.["journal-title"],
      authors: reference?.author ? [String(reference.author)] : undefined,
    })
  }
  return { records, total: references.length, withDoi }
}

/**
 * The references and citations of a work, from Europe PMC.
 *
 * Europe PMC keys these by PMID, so a record without one cannot be looked up
 * this way.
 */
export async function europePmcNeighbourhood(
  pmid: string,
  ctx: ToolContext,
): Promise<
  | {
      references: { records: CitationRecord[]; total: number }
      citations: { records: CitationRecord[]; total: number }
    }
  | undefined
> {
  const read = async (kind: "references" | "citations") => {
    const data = await httpJson<any>(
      `https://www.ebi.ac.uk/europepmc/webservices/rest/MED/${encodeURIComponent(pmid)}/${kind}?format=json&pageSize=50`,
      { signal: ctx.signal },
    )
    const items: any[] = data?.referenceList?.reference ?? data?.citationList?.citation ?? []
    return {
      records: items.map((item: any) => ({
        title: String(item?.title ?? "").trim(),
        doi: item?.doi,
        pmid: item?.id && String(item.id).startsWith("MED/") ? String(item.id).slice(4) : undefined,
        authors: item?.authorString ? String(item.authorString).split(/,\s*/).slice(0, 8) : undefined,
        venue: item?.journalAbbreviation,
        year: item?.pubYear ? Number(item.pubYear) : undefined,
      })) as CitationRecord[],
      total: Number(data?.hitCount ?? items.length),
    }
  }

  const [references, citations] = await Promise.all([read("references"), read("citations")])
  return { references, citations }
}

/**
 * The neighbourhood of a work, from whichever sources can answer.
 *
 * The lists are filled independently, so a subject that OpenAlex knows but
 * Europe PMC does not still gets a citing list, and one that only Crossref
 * knows still gets a reference list.
 */
export async function citationNeighbourhood(
  identifiers: readonly { scheme: string; value: string }[],
  limit: number,
  ctx: ToolContext,
): Promise<CitationNeighbourhood> {
  const out: CitationNeighbourhood = { references: [], citations: [], sources: {}, unavailable: [] }

  const doi = identifiers.find((i) => i.scheme === "doi")
  const pmid = identifiers.find((i) => i.scheme === "pmid")

  let subjectId: string | undefined
  try {
    const subject = await openAlexId(identifiers, ctx)
    if (subject) {
      subjectId = String(subject.id ?? "").split("/").pop()
      out.subject = { ...subject, openAlexId: subjectId }
    }
  } catch (error) {
    out.unavailable?.push({ list: "citations", reason: `OpenAlex lookup failed: ${(error as Error).message}` })
  }

  // References: OpenAlex's own list, then Crossref's as a second reading.
  if (subjectId) {
    try {
      const { records, total, resolved, queried } = await referencedWorks(subjectId, limit, ctx)
      out.references = records.slice(0, limit)
      out.sources.references = "openalex"
      out.totals = { ...out.totals, references: total }
      out.resolvedReferences = resolved
      if (resolved < queried) {
        // The ids that came back with no paper are not errors in the data; they
        // are works OpenAlex lists but does not serve. Saying so is better
        // than letting the count imply the list was read in full.
        out.unavailable?.push({
          list: "references",
          reason:
            `${total} references are listed, ${queried} were looked up, and ${resolved} resolved to a ` +
            "record. The rest are ids the service does not serve.",
        })
      }
    } catch (error) {
      out.unavailable?.push({ list: "references", reason: `OpenAlex references failed: ${(error as Error).message}` })
    }
  }

  if (doi && (!out.references.length || !out.sources.references)) {
    try {
      const { records, total, withDoi } = await crossrefReferences(
        doi.value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, ""),
        limit,
        ctx,
      )
      if (records.length) {
        out.references = records
        out.sources.references = "crossref"
        out.totals = { ...out.totals, references: total }
        if (!withDoi) {
          out.unavailable?.push({
            list: "references",
            reason: "Crossref's reference list carries no DOIs, so these references cannot be resolved to records.",
          })
        }
      }
    } catch (error) {
      out.unavailable?.push({ list: "references", reason: `Crossref references failed: ${(error as Error).message}` })
    }
  }

  // Citations: the `cites:` filter, with Europe PMC as a second reading.
  if (subjectId) {
    try {
      const { records, total } = await citingWorks(subjectId, limit, ctx)
      out.citations = records
      out.sources.citations = "openalex"
      out.totals = { ...out.totals, citations: total }
    } catch (error) {
      out.unavailable?.push({ list: "citations", reason: `OpenAlex citing works failed: ${(error as Error).message}` })
    }
  }

  if (pmid && !out.citations.length) {
    try {
      const neighbourhood = await europePmcNeighbourhood(pmid.value, ctx)
      if (neighbourhood) {
        out.citations = neighbourhood.citations.records
        out.sources.citations = "europepmc"
        out.totals = { ...out.totals, citations: neighbourhood.citations.total }
        if (!out.references.length && neighbourhood.references.records.length) {
          out.references = neighbourhood.references.records
          out.sources.references = "europepmc"
          out.totals = { ...out.totals, references: neighbourhood.references.total }
        }
      }
    } catch (error) {
      out.unavailable?.push({ list: "citations", reason: `Europe PMC failed: ${(error as Error).message}` })
    }
  }

  return out
}
