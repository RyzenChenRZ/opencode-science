import { httpJson as fetchJson, httpText, assertAdmissibleUrl, credential, credentialParams } from "./http.ts"
import type { ToolContext } from "./types.ts"

/**
 * Scientific database connectors.
 *
 * Each connector is one entry from the upstream catalogue, exposing its highest
 * value read-only queries as OpenCode tools. Tools are named
 * `os_<connector>_<action>` so permission rules can address them individually.
 *
 * Upstream is Apache-2.0. Connector identities, `useWhen` routing text, and API
 * shapes come from the upstream catalogue; the implementations here are
 * original and deliberately narrow: read-only HTTP, no credential storage, and
 * no local command execution.
 */

const str = (description: string) => ({ type: "string", description })
const int = (description: string) => ({ type: "integer", description })

function tool(
  connector: string,
  action: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  run: (input: Record<string, any>, ctx: ToolContext) => Promise<unknown>,
) {
  return {
    name: `os_${connector}_${action}`,
    description,
    input: { type: "object" as const, properties, required, additionalProperties: false },
    run,
  }
}

/** Formats a credential hint shared by every tool that needs a key. */
function hint(key: string, url: string): string {
  return `Set ${key} in the plugin options (or the ${key} environment variable); request a free key at ${url}.`
}

/** Decodes the XML entities PubMed puts inside abstract text. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, "&")
}

/**
 * Pulls the abstract out of one PubMed record.
 *
 * `efetch` returns XML, and the abstract lives in one or more `<AbstractText>`
 * elements — a structured abstract has several, each with its own Label
 * (BACKGROUND, METHODS, ...), which are joined so the result reads as prose.
 * Inline markup such as `<i>` and `<sup>` is stripped rather than escaped into
 * the text.
 */
function pubmedAbstracts(xml: string): string {
  const parts: string[] = []
  // Matches both `<AbstractText>` and `<AbstractText Label="...">`, and stops
  // at the closing tag or at the element's own end if it is self-closing.
  const pattern = /<AbstractText\b[^>]*?(?:\/>|>([\s\S]*?)<\/AbstractText>)/giu
  for (const match of xml.matchAll(pattern)) {
    const inner = (match[1] ?? "")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
    if (inner) parts.push(decodeXmlEntities(inner))
  }
  return parts.join(" ")
}

/**
 * Flattens Crossref's JATS abstract to plain text.
 *
 * The field is a fragment of XML with `<jats:p>` paragraphs and inline markup, so
 * the tags are stripped after the entities are decoded and the paragraphs are
 * joined with a space.
 */
function crossrefAbstract(jats: string): string {
  return decodeXmlEntities(
    jats
      .replace(/<\/?jats:[^>]+>/gu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
}

/**
 * Pulls the abstracts out of an efetch response, keyed by PMID.
 *
 * Exported rather than kept private because os_literature_search re-fetches
 * PubMed to build library records, and the two copies of this logic drifted:
 * the connector gained abstracts while the search path did not, which is how a
 * freshly searched library ended up with none.
 */
export function pubmedAbstractsByPmid(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  // Records are delimited by <PubmedArticle>, so each is split out before its
  // PMID is read. Scanning the whole document for the first <PMID> would attach
  // one record's abstract to every other record in the batch.
  for (const article of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/gu)) {
    const body = article[0]
    const pmid = /<PMID[^>]*>(\d+)<\/PMID>/u.exec(body)?.[1]
    const text = pubmedAbstracts(body)
    if (pmid && text) out.set(pmid, text)
  }
  return out
}

/**
 * Rebuilds an abstract from OpenAlex's inverted index.
 *
 * OpenAlex stores the text as a word-to-positions map, which is compact but has
 * to be inverted. Words are placed by position rather than concatenated in map
 * order, because map order is the order the words first appeared, not the order
 * they occur in.
 */
function openAlexAbstract(inverted: unknown): string {
  if (!inverted || typeof inverted !== "object") return ""
  const slots: string[] = []
  for (const [word, positions] of Object.entries(inverted as Record<string, unknown>)) {
    if (!Array.isArray(positions)) continue
    for (const position of positions) {
      const index = Number(position)
      if (!Number.isInteger(index) || index < 0) continue
      slots[index] = word
    }
  }
  return slots.filter((word) => typeof word === "string").join(" ").trim()
}

/**
 * Fetches PubMed hits, abstract included.
 *
 * Exported so the library search and the connector tool share one fetch path.
 * They used to be two implementations, and the second was the one that had not
 * been taught to fetch abstracts — a library built through `os_literature_search`
 * therefore held records with no abstract, which no abstract-based criterion
 * could then use.
 */
export async function fetchPubmedHits(term: string, retmax: number, ctx: ToolContext) {
  // An NCBI key raises the limit from 3 to 10 requests a second and the email
  // identifies the caller, which is what NCBI asks for in exchange. Without
  // them the query still runs, so this is an accelerator and not a gate.
  const auth = credentialParams({ api_key: credential(ctx, "ncbiApiKey"), email: credential(ctx, "ncbiEmail") })

  const search = await fetchJson<any>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${retmax}${auth}&term=${encodeURIComponent(term)}`,
    { signal: ctx.signal },
  )
  const ids: string[] = search?.esearchresult?.idlist ?? []
  if (!ids.length) return { total: 0, hits: [] as Record<string, unknown>[] }

  const summary = await fetchJson<any>(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json${auth}&id=${ids.join(",")}`,
    { signal: ctx.signal },
  )

  // esummary carries no abstracts, so a second call fetches them. A failure
  // here costs the abstracts, not the results: they are reported as absent
  // rather than dropping the records that had none.
  const abstracts = new Map<string, string>()
  try {
    const xml = await httpText(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&retmode=xml${auth}&id=${ids.join(",")}`,
      { signal: ctx.signal },
    )
    // Records are delimited by <PubmedArticle>, so each is split out before its
    // PMID is read; otherwise every record picks up the first abstract present.
    for (const article of xml.matchAll(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/gu)) {
      const body = article[0]
      const pmid = /<PMID[^>]*>(\d+)<\/PMID>/u.exec(body)?.[1]
      const text = pubmedAbstracts(body)
      if (pmid && text) abstracts.set(pmid, text)
    }
  } catch {
    // Left empty on purpose; see above.
  }

  const hits: Record<string, unknown>[] = []
  for (const id of ids) {
    const rec = summary?.result?.[id]
    if (!rec) continue
    hits.push({
      pmid: id,
      title: rec.title,
      journal: rec.fulljournalname,
      pubDate: rec.pubdate,
      authors: (rec.authors ?? []).map((a: any) => a.name),
      doi: (rec.articleids ?? []).find((a: any) => a.idtype === "doi")?.value,
      abstract: abstracts.get(id) ?? "",
    })
  }
  return { total: Number(search?.esearchresult?.count ?? hits.length), hits }
}

/** Fetches OpenAlex works, abstract included. Shared for the reason above. */
export async function fetchOpenAlexWorks(query: string, perPage: number, ctx: ToolContext) {
  // A key moves the caller into the keyed pool. It is optional here because
  // anonymous search still works; the vendored literature-review helpers are
  // stricter and refuse a keyless call, which is why the key is also forwarded
  // into notebook runs.
  const auth = credentialParams({ api_key: credential(ctx, "openAlexApiKey") })
  const data = await fetchJson<any>(
    `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}${auth}`,
    { signal: ctx.signal },
  )
  const hits: Record<string, unknown>[] = (data?.results ?? []).map((w: any) => ({
    title: w.title,
    displayName: w.display_name,
    year: w.publication_year,
    doi: w.doi,
    citedBy: w.cited_by_count,
    isOpenAccess: w.open_access?.is_oa,
    venue: w.primary_location?.source?.display_name,
    // Authors are carried through, not dropped. A record without them exports
    // as a citation with no author, which is a citation that cannot be looked
    // up by name, and OpenAlex has them for every work.
    authors: (w.authorships ?? [])
      .map((a: any) => a?.author?.display_name)
      .filter((name: unknown): name is string => typeof name === "string" && name.length > 0)
      .slice(0, 20),
    // Not every work has one; an absent index yields an empty string, which the
    // library stores as "no abstract supplied" rather than as a blank.
    abstract: openAlexAbstract(w.abstract_inverted_index),
  }))
  return { total: Number(data?.meta?.count ?? hits.length), hits }
}

export const CONNECTORS = [
  {
    id: "pubmed",
    displayName: "PubMed",
    credentials: ["ncbiApiKey", "ncbiEmail"],
    tools: [
      tool(
        "pubmed",
        "search",
        "Search biomedical literature in PubMed via NCBI E-utilities. Returns PMIDs, titles and abstracts. " +
          hint("ncbiApiKey", "https://www.ncbi.nlm.nih.gov/account/settings/"),
        { term: str("PubMed query, e.g. 'CRISPR base editing sickle cell'"), retmax: int("Max records (default 20, max 200)") },
        ["term"],
        async (input, ctx) => {
          const term = String(input.term)
          const retmax = Math.min(Number(input.retmax ?? 20), 200)
          const { total, hits } = await fetchPubmedHits(term, retmax, ctx)
          if (!hits.length) return { term, count: 0, results: [], note: "No records matched." }
          const results = hits.map((hit) => {
            const abstract = hit.abstract as string
            return {
              ...hit,
              abstract,
              authors: (hit.authors as string[]).slice(0, 8),
            }
          })
          return {
            term,
            count: total,
            withAbstract: results.filter((r) => r.abstract).length,
            identified: Boolean(credential(ctx, "ncbiApiKey") || credential(ctx, "ncbiEmail")),
            results,
          }
        },
      ),
    ],
  },
  {
    id: "literature",
    displayName: "Literature Graph",
    credentials: ["openAlexApiKey", "ncbiEmail"],
    tools: [
      tool(
        "literature",
        "search_openalex",
        "Search scholarly works by topic via OpenAlex. Returns title, year, DOI, citation counts, and abstracts. " +
          hint("openAlexApiKey", "https://openalex.org/set"),
        { query: str("Topic, title, or author search string"), perPage: int("Max records (default 10, max 50)") },
        ["query"],
        async (input, ctx) => {
          const perPage = Math.min(Number(input.perPage ?? 10), 50)
          const { total, hits } = await fetchOpenAlexWorks(String(input.query), perPage, ctx)
          return {
            count: total,
            withAbstract: hits.filter((h) => h.abstract).length,
            keyed: Boolean(credential(ctx, "openAlexApiKey")),
            results: hits,
          }
        },
      ),
      tool(
        "literature",
        "crossref_lookup",
        "Look up a DOI in Crossref. Returns title, authors, journal, publication date, and the abstract when Crossref has one.",
        { doi: str("DOI, e.g. 10.1038/nature12373") },
        ["doi"],
        async (input, ctx) => {
          const doi = String(input.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
          // `mailto` is Crossref's polite-pool opt-in: it identifies the caller
          // and routes the request to a faster, more reliable path.
          const polite = credentialParams({ mailto: credential(ctx, "ncbiEmail") })
          const data = await fetchJson<any>(
            `https://api.crossref.org/works/${encodeURIComponent(doi)}${polite}`,
            { signal: ctx.signal },
          )
          const m = data?.message
          if (!m) return { doi, found: false, note: "Crossref has no record for this DOI." }
          // Crossref carries the abstract as JATS XML inside a single string, and
          // os_literature_complete already retrieves it from here. Returning it
          // means a caller who looks a DOI up here sees the same evidence the
          // completion step would have found, rather than having to publish first
          // to discover it was there.
          const abstract = typeof m.abstract === "string" ? crossrefAbstract(m.abstract) : ""
          return {
            doi,
            found: true,
            title: m.title?.[0],
            authors: (m.author ?? []).map((a: any) => `${a.family ?? ""} ${a.given ?? ""}`.trim()).slice(0, 10),
            journal: m["container-title"]?.[0],
            published: m.published?.["date-parts"]?.[0],
            type: m.type,
            references: m["reference-count"],
            abstract,
            hasAbstract: abstract.length > 0,
          }
        },
      ),
    ],
  },
  {
    id: "clinical-trials",
    displayName: "Clinical Trials",
    credentials: [],
    tools: [
      tool(
        "clinical-trials",
        "search",
        "Search ClinicalTrials.gov for trials by condition, intervention, or phase. Returns NCT IDs.",
        { query: str("Condition or intervention, e.g. 'non-small cell lung cancer'"), max: int("Max trials (default 20)") },
        ["query"],
        async (input, ctx) => {
          const max = Math.min(Number(input.max ?? 20), 50)
          const data = await fetchJson<any>(
            `https://clinicaltrials.gov/api/v2/studies?query.cond=${encodeURIComponent(String(input.query))}&pageSize=${max}&format=json`,
            { signal: ctx.signal },
          )
          const studies = (data?.studies ?? []).map((s: any) => {
            const p = s.protocolSection ?? {}
            const idm = p.identificationModule ?? {}
            const status = p.statusModule ?? {}
            const design = p.designModule ?? {}
            return {
              nctId: idm.nctId,
              title: idm.briefTitle,
              status: status.overallStatus,
              phase: design.phases,
              enrollment: design.enrollmentInfo?.count,
            }
          })
          return { query: input.query, count: studies.length, studies }
        },
      ),
    ],
  },
  {
    id: "cellosaurus",
    displayName: "Cellosaurus",
    credentials: [],
    tools: [
      tool(
        "cellosaurus",
        "lookup",
        "Look up a cell line in Cellosaurus by name or CVCL accession. Returns species and provenance.",
        { query: str("Cell line name or CVCL/RRID identifier, e.g. 'HeLa' or 'CVCL_0020'") },
        ["query"],
        async (input, ctx) => {
          const q = String(input.query)
          // Two endpoints, verified against the live API:
          //   /cell-line/<ACC>         addresses one accession directly
          //   /search/cell-line?query= is a full-text search
          // Searching for an accession returns the closest match rather than
          // that record, so the accession form must not go through search.
          const isAccession = /^(CVCL_|RRID:)/i.test(q)
          const url = isAccession
            ? `https://api.cellosaurus.org/cell-line/${encodeURIComponent(q.toUpperCase())}?format=json`
            : `https://api.cellosaurus.org/search/cell-line?query=${encodeURIComponent(q)}&format=json&rows=5`
          const data = await fetchJson<any>(url, { signal: ctx.signal })

          // Cellosaurus JSON keys are hyphenated, not camelCased, and a
          // comment is keyed by `category` rather than `type`.
          const records: any[] = data?.Cellosaurus?.["cell-line-list"] ?? []
          const cl = records[0]
          if (!cl) return { query: q, found: false, note: "No Cellosaurus record matched." }

          const primary = (cl["accession-list"] ?? []).find((a: any) => a.type === "primary")
          const names: any[] = cl["name-list"] ?? []
          const preferred = names.find((n: any) => n.type === "identifier") ?? names[0]
          const species = (cl["species-list"] ?? [])[0]
          // A derived-from site is nested under `site`, while a comment that
          // mentions derivation carries it directly as `value`.
          const derivedFrom =
            (cl["comment-list"] ?? []).find((c: any) => c.category === "Derived from")?.value ??
            (cl["derived-from-site-list"] ?? [])[0]?.site?.value

          return {
            query: q,
            found: true,
            accession: primary?.value ?? (cl["accession-list"] ?? [])[0]?.value,
            name: preferred?.value,
            synonyms: names.filter((n: any) => n.type === "synonym").slice(0, 5).map((n: any) => n.value),
            species: species?.label ?? species?.value,
            speciesTaxId: species?.accession,
            derivedFrom,
          }
        },
      ),
    ],
  },
  {
    id: "uniprot",
    displayName: "UniProt",
    credentials: [],
    tools: [
      tool(
        "uniprot",
        "search",
        "Search UniProt for reviewed proteins by gene name or description. Returns accessions and function.",
        { query: str("Gene name, protein name, or keyword, e.g. 'TP53'"), size: int("Max results (default 10)") },
        ["query"],
        async (input, ctx) => {
          const size = Math.min(Number(input.size ?? 10), 50)
          const data = await fetchJson<any>(
            `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(String(input.query))}&format=json&size=${size}`,
            { signal: ctx.signal },
          )
          const results = (data?.results ?? []).map((r: any) => ({
            accession: r.primaryAccession,
            id: r.uniProtkbId,
            protein: r.proteinDescription?.recommendedName?.fullName?.value,
            gene: r.genes?.[0]?.geneName?.value,
            organism: r.organism?.scientificName,
            reviewed: r.entryType === "UniProtKB reviewed (Swiss-Prot)",
          }))
          return { query: input.query, count: results.length, results }
        },
      ),
    ],
  },
  {
    id: "zenodo",
    displayName: "Zenodo",
    credentials: [],
    tools: [
      tool(
        "zenodo",
        "search",
        "Search Zenodo for published datasets, software, or papers. Returns DOIs and file links.",
        { query: str("Search string, e.g. 'CRISPR screen data'"), size: int("Max results (default 10)") },
        ["query"],
        async (input, ctx) => {
          const size = Math.min(Number(input.size ?? 10), 50)
          const data = await fetchJson<any>(
            `https://zenodo.org/api/records?q=${encodeURIComponent(String(input.query))}&size=${size}`,
            { signal: ctx.signal },
          )
          const hits = (data?.hits?.hits ?? []).map((h: any) => ({
            id: h.id,
            doi: h.doi,
            title: h.metadata?.title,
            type: h.metadata?.resource_type?.title,
            published: h.metadata?.publication_date,
            files: (h.files ?? []).slice(0, 5).map((f: any) => ({ key: f.key, size: f.size, link: f.links?.self })),
          }))
          return { query: input.query, count: hits.length, hits }
        },
      ),
    ],
  },
] as const

export const CONNECTOR_IDS = CONNECTORS.map((c) => c.id)

export { assertAdmissibleUrl }
