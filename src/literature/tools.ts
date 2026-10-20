/**
 * Literature tools.
 *
 * Exposes the library, screening, and pre-screening layers as OpenCode tools,
 * and adds the search-and-collect path that turns a query into a stored,
 * deduplicated set of records.
 *
 * The connectors in connectors.ts answer a single question against one
 * database. These tools answer the question that actually gets asked: not
 * "what does PubMed say about X" but "give me the set of records for X, merged,
 * deduplicated, and tell me which ones are in and which are out".
 */

import { httpJson as fetchJson, httpText, assertAdmissibleUrl } from "../http.ts"
import { fetchPubmedHits, fetchOpenAlexWorks } from "../connectors.ts"
import { join } from "node:path"
import type { ToolContext } from "../types.ts"
import {
  addRecords,
  completeMetadata,
  createLibrary,
  emptyRecord,
  findByIdentifier,
  getById,
  inferItemType,
  inferYear,
  personCreator,
  summarize,
  type LibraryEntry,
} from "./library.ts"
import {
  checkEvidenceMode,
  checkRule,
  deriveEvidenceMode,
  formatRule,
  parseRule,
  rulePrompt,
  RULE_MAX_LENGTH,
  createScreeningState,
  updateRule,
  override,
  clearOverrides,
  effectiveVerdict,
  tally,
  reviewBucket,
  type CollectionRule,
  type ScreeningState,
} from "./screening.ts"
import { parseCriteria, screenRecord } from "./prescreen.ts"
import { loadScreening, saveScreening } from "./screening-store.ts"
import {
  attachFullText,
  readPageFiles,
  PAGE_BUDGET,
  DOCUMENT_BUDGET,
} from "./pdf.ts"
import { resolveInsideWorkspace } from "../provenance.ts"
import { normalizeIdentifierValue, parseIdentifier } from "./identifiers.ts"

/**
 * The message shown when a rule is refused.
 *
 * It names the field that is actually at fault. The previous single message
 * blamed `inclusion` for every failure, so a caller whose rule was fine but
 * missing `exclusion` was sent to correct the one field that was already right.
 */
function ruleProblemMessage(problem: string): string {
  switch (problem) {
    case "missing-inclusion":
      return "The rule needs a non-empty 'inclusion': the criteria every record must meet."
    case "missing-exclusion":
      return (
        "The rule needs a non-empty 'exclusion': the criteria that disqualify a record. " +
        "It cannot be defaulted, because an omitted exclusion and an exclusion of " +
        "'nothing' are different claims."
      )
    case "too-long":
      return `The rule must be under ${RULE_MAX_LENGTH} characters in total.`
    default:
      return "The rule must be an object with 'inclusion' and 'exclusion' strings."
  }
}

async function loadScreeningRecord(workspace: string): Promise<ScreeningState | undefined> {
  return loadScreening(workspace)
}

/**
 * What the library can support, and whether a request for a mode is served.
 *
 * The evidence mode is recomputed on every read rather than trusted from the
 * stored state. Full text can be extracted after a screening session was
 * started, so a stored "abstract" would understate what the record now has, and
 * a stored "full-text" would overstate it if the text was never there.
 */
function evidenceFor(entries: readonly LibraryEntry[]) {
  return deriveEvidenceMode(
    entries.map((entry) => ({ abstract: entry.record.abstract, fullText: entry.record.fullText })),
  )
}

/**
 * Converts one connector result into library records.
 *
 * Each connector returns its own field names, so this is where they become the
 * one record shape the library stores. Anything a source does not supply stays
 * empty rather than being invented: a record with no abstract is a record the
 * screener will be told about, not one with a fabricated summary.
 */
/**
 * Splits a PubMed author name into a family name and initials.
 *
 * PubMed's esummary writes an author as "Family Initials" — "Firoozi D",
 * "Mohammad-Kazem Hosseini Asl S". The last token is the initials and
 * everything before it is the family name.
 *
 * The split used to take the last token as the family name, which produced
 * "D, Firoozi" — a citation to a person named D, surname Firoozi. Nothing
 * noticed, because the library stored the names and the bibliography was
 * written by hand from the papers.
 */
function splitPubmedName(name: string): { family: string; given: string } {
  const trimmed = String(name ?? "").trim()
  if (!trimmed) return { family: "", given: "" }
  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) return { family: parts[0], given: "" }

  const last = parts[parts.length - 1]
  // A trailing token of one to three letters is initials. Anything else — a
  // collective name, a suffix — is left as the family name.
  const isInitials = /^[A-Z]{1,3}$/u.test(last) || /^[A-Z](?:[- ][A-Z])*$/u.test(last)
  if (!isInitials) return { family: trimmed, given: "" }
  return { family: parts.slice(0, -1).join(" "), given: last }
}

export function recordFromPubmed(hit: any): ReturnType<typeof emptyRecord> {  const record = emptyRecord(String(hit.title ?? "Untitled"))
  record.abstract = String(hit.abstract ?? "")
  record.issuedText = String(hit.pubDate ?? "")
  record.issuedYear = inferYear(record.issuedText)
  record.containerTitle = String(hit.journal ?? "")
  record.itemType = inferItemType(record)
  record.creators = (hit.authors ?? [])
    .map((name: string) => {
      const { family, given } = splitPubmedName(name)
      return personCreator(family, given)
    })
    .filter((creator: any) => creator.familyName)
    .slice(0, 20)
  record.identifiers = [
    ...(hit.pmid ? [{ scheme: "pmid" as const, value: String(hit.pmid), isPrimary: true }] : []),
    ...(hit.doi ? [{ scheme: "doi" as const, value: String(hit.doi), isPrimary: false }] : []),
  ]
  return record
}

/**
 * The arXiv id a record's DOI implies, if it has one.
 *
 * arXiv mints a DOI for every preprint, in the form 10.48550/arXiv.2301.00001.
 * The identifier was already recognized by the lookup tool and by the
 * deduplication key, but nothing ever produced one: a record collected from
 * OpenAlex carried only its DOI, so looking it up by its arXiv id found
 * nothing, and the direct PDF route to a preprint was unreachable.
 */
function arxivIdFromDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined
  const match = /^10\.48550\/arxiv\.(.+)$/iu.exec(doi.trim())
  if (!match) return undefined
  const id = match[1].replace(/v\d+$/iu, "")
  return /^(?:\d{4}\.\d{4,5}|[a-z][a-z.-]*\/\d{7})$/iu.test(id) ? id : undefined
}

/** The identifiers a record should carry for the given DOI. */
function identifiersForDoi(doi: string | undefined, primary: boolean) {
  const identifiers: { scheme: "doi" | "arxiv"; value: string; isPrimary: boolean }[] = []
  if (doi) identifiers.push({ scheme: "doi", value: doi, isPrimary: primary })
  const arxiv = arxivIdFromDoi(doi)
  if (arxiv) identifiers.push({ scheme: "arxiv", value: arxiv, isPrimary: false })
  return identifiers
}

function recordFromOpenAlex(hit: any): ReturnType<typeof emptyRecord> {
  // OpenAlex's search endpoint calls it display_name; the shared fetcher also
  // carries `title`. Either is accepted so the two cannot drift apart again.
  const record = emptyRecord(String(hit.displayName ?? hit.title ?? "Untitled"))
  // Stored from the connector rather than fetched later: an abstract the
  // source already supplied should not need a second round trip per record.
  record.abstract = String(hit.abstract ?? "")
  record.issuedYear = typeof hit.year === "number" ? hit.year : undefined
  record.issuedText = hit.year ? String(hit.year) : ""
  record.containerTitle = String(hit.venue ?? "")
  record.url = String(hit.doi ?? "")
  record.typeFields = {
    citedBy: hit.citedBy,
    openAccess: hit.isOpenAccess,
  }
  record.itemType = inferItemType(record)
  const doi = typeof hit.doi === "string" ? hit.doi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "") : ""
  record.identifiers = identifiersForDoi(doi || undefined, true)
  // OpenAlex gives display names, not split names, so the family name is
  // whatever comes last and the given names are what comes before. A record
  // with no authors at all is left without them rather than given a guess.
  record.creators = (hit.authors ?? [])
    .map((name: string) => {
      const parts = String(name).trim().split(/\s+/)
      if (!parts.length) return undefined
      if (parts.length === 1) return personCreator(parts[0], "")
      return personCreator(parts[parts.length - 1], parts.slice(0, -1).join(" "))
    })
    .filter(Boolean)
    .slice(0, 20)
  return record
}

function recordFromCrossref(message: any): ReturnType<typeof emptyRecord> {
  const record = emptyRecord(String(message.title?.[0] ?? "Untitled"))
  record.containerTitle = String(message["container-title"]?.[0] ?? "")
  record.abstract = String(message.abstract ?? "").replace(/<[^>]+>/g, "").trim()
  const parts = message.published?.["date-parts"]?.[0]
  record.issuedText = Array.isArray(parts) ? parts.join("-") : ""
  record.issuedYear = inferYear(record.issuedText)
  record.url = String(message.URL ?? "")
  record.typeFields = { type: message.type, referenceCount: message["reference-count"] }
  record.itemType = inferItemType(record)
  record.creators = (message.author ?? [])
    .map((author: any) => personCreator(String(author.family ?? ""), String(author.given ?? "")))
    .slice(0, 20)
  record.identifiers = identifiersForDoi(message.DOI ? String(message.DOI) : undefined, true)
  return record
}

/**
 * Searches the bibliographic connectors and stores what they return.
 *
 * Results are merged into the library rather than returned loose, because the
 * next thing anyone does with a search result is cite it, and a citation needs
 * an identifier that will still resolve later.
 */
async function searchAndStore(
  ctx: ToolContext,
  query: string,
  sources: string[],
  limit: number,
): Promise<Record<string, unknown>> {
  const library = createLibrary(ctx.workspace)
  const collected: ReturnType<typeof emptyRecord>[] = []
  const perSource = Math.max(3, Math.min(Math.ceil(limit / Math.max(sources.length, 1)), 50))
  const failures: { source: string; reason: string }[] = []

  for (const source of sources) {
    try {
      if (source === "pubmed") {
        // Shared with os_pubmed_search so the two cannot drift. They used to be
        // separate implementations, and this one had never been taught to fetch
        // abstracts — which is why a library built by searching held records with
        // no abstract at all.
        const { hits } = await fetchPubmedHits(query, perSource, ctx)
        for (const hit of hits) collected.push(recordFromPubmed(hit))
      } else if (source === "openalex") {
        const { hits } = await fetchOpenAlexWorks(query, perSource, ctx)
        for (const work of hits) collected.push(recordFromOpenAlex(work))
      } else if (source === "crossref") {
        // Crossref has no free-text endpoint that fits here; it is reached by
        // identifier, which is what the `literature_complete` tool does.
        failures.push({ source: "crossref", reason: "reached by identifier, not by search; use literature_complete" })
      } else {
        failures.push({ source, reason: "unknown source" })
      }
    } catch (error) {
      // One source failing is reported, not fatal: a partial result set with a
      // stated gap is more useful than an error that discards the rest.
      failures.push({ source, reason: (error as Error).message })
    }
  }

  if (!collected.length) {
    return { query, sources, count: 0, note: "No records matched.", failures: failures.length ? failures : undefined }
  }

  const result = await addRecords(library, collected.slice(0, limit), sources.join("+"))
  return {
    query,
    sources,
    retrieved: collected.length,
    added: result.added,
    merged: result.merged,
    note:
      result.merged > 0
        ? `${result.merged} record(s) matched an existing entry by identifier and were merged into it.`
        : undefined,
    records: result.entries
      .filter((entry) => collected.some((c) => entry.record.identifiers.some((i) => c.identifiers.some((o) => o.scheme === i.scheme && o.value.toLowerCase() === i.value.toLowerCase()))))
      .slice(-limit)
      .map(summarize),
    failures: failures.length ? failures : undefined,
  }
}

const str = (description: string) => ({ type: "string", description })
const int = (description: string) => ({ type: "integer", description })

export const LITERATURE_TOOLS = [
  {
    name: "os_literature_search",
    description:
      "Search the bibliographic databases and store the results in this workspace's literature library. " +
      "Records are deduplicated by identifier across sources, so the same paper found by PubMed and OpenAlex becomes one entry. " +
      "Returns the stored entries with their identifiers so each one can be cited.",
    input: {
      type: "object",
      properties: {
        query: str("Search query, e.g. 'CRISPR base editing sickle cell'"),
        sources: {
          type: "array",
          items: { type: "string", enum: ["pubmed", "openalex"] },
          description: "Which databases to search (default: both).",
        },
        limit: int("Max records to store (default 20, max 50)."),
      },
      required: ["query"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const sources = Array.isArray(input.sources) && input.sources.length ? input.sources : ["pubmed", "openalex"]
      const limit = Math.min(Number(input.limit ?? 20), 50)
      return searchAndStore(ctx, String(input.query), sources.map(String), limit)
    },
  },

  {
    name: "os_literature_list",
    description:
      "List records in the literature library with their identifiers, sources, and abstract status. " +
      "Use it to see what has already been collected before searching again.",
    input: {
      type: "object",
      properties: {
        limit: int("Max entries to return (default 20, max 100)."),
        hasAbstract: {
          type: "boolean",
          description: "When true, only entries with a non-empty abstract.",
        },
      },
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const library = createLibrary(ctx.workspace)
      const all = await library.load()
      let entries = all
      if (input.hasAbstract === true) {
        entries = entries.filter((entry) => entry.record.abstract.trim().length > 0)
      }
      const limit = Math.min(Number(input.limit ?? 20), 100)

      if (!entries.length) {
        // The two empty cases need different advice. Saying "the library is
        // empty" about a library holding 11 records that merely lack abstracts
        // sends the caller off to search again for no reason, and hides the fact
        // that they need to complete metadata instead.
        if (all.length) {
          return {
            count: 0,
            librarySize: all.length,
            note:
              `None of the ${all.length} records in this library has an abstract. ` +
              "Search does not collect abstracts; fill them in with os_literature_complete " +
              "before filtering on one.",
          }
        }
        return { count: 0, note: "The library is empty. Use os_literature_search to collect records." }
      }
      return { count: entries.length, records: entries.slice(-limit).reverse().map(summarize) }
    },
  },

  {
    name: "os_literature_complete",
    description:
      "Fill missing metadata on a stored record from Crossref, using its DOI or PMID. " +
      "This is also how a record that arrived with only one identifier acquires the others, " +
      "which is what lets a later sighting of the same paper resolve to the same entry. " +
      "Fields that already have a value are not overwritten unless you name them in overwriteFields.",
    input: {
      type: "object",
      properties: {
        id: str("The library entry id, as returned by os_literature_list."),
        expectedRevision: int("The entry's current metadataRevision. The write is refused if it has changed."),
        overwriteFields: {
          type: "array",
          items: {
            type: "string",
            enum: ["title", "abstract", "containerTitle", "issuedText", "issuedYear", "itemType", "language", "url"],
          },
          description: "Fields to overwrite even when already populated.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      const entry = getById(entries, String(input.id))
      if (!entry) return { error: `No library entry with id ${input.id}.` }

      const doi = entry.record.identifiers.find((i) => i.scheme === "doi")?.value
      const pmid = entry.record.identifiers.find((i) => i.scheme === "pmid")?.value
      if (!doi && !pmid) {
        return {
          error:
            "This record has no DOI or PMID, so there is nothing to look up. " +
            "Add an identifier to it first, then run this again.",
        }
      }

      let message: any
      let source: string
      if (doi) {
        const url = `https://api.crossref.org/works/${encodeURIComponent(normalizeIdentifierValue("doi", doi))}`
        assertAdmissibleUrl(url)
        const data = await fetchJson<any>(url, { signal: ctx.signal })
        message = data?.message
        source = "crossref"
      } else {
        // Narrowed here rather than relying on the guard above: the guard is
        // what proves pmid exists, and this is the branch that uses it.
        const pmidValue = pmid as string
        const data = await fetchJson<any>(
          `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${pmidValue}`,
          { signal: ctx.signal },
        )
        const rec = data?.result?.[pmidValue]
        if (!rec) return { error: `PubMed has no record for ${pmidValue}.` }
        message = {
          title: [rec.title],
          "container-title": [rec.fulljournalname],
          published: { "date-parts": [parseYearParts(rec.pubdate)] },
          author: (rec.authors ?? []).map((a: any) => ({ family: a.name, given: "" })),
        }
        source = "pubmed"
      }
      if (!message) return { error: `${source} has no record for this item.` }

      const incoming = recordFromCrossref(message)
      const result = await completeMetadata(
        library,
        entry.id,
        typeof input.expectedRevision === "number" ? input.expectedRevision : entry.metadataRevision,
        incoming,
        Array.isArray(input.overwriteFields) ? input.overwriteFields.map(String) : [],
      )

      if (result.status === "stale") {
        return {
          error:
            `This entry changed since it was read (now at revision ${result.currentRevision}, you supplied ${input.expectedRevision}). ` +
            "Re-read it and decide whether the new value is still wanted.",
          currentRevision: result.currentRevision,
        }
      }
      if (result.status === "not-found") return { error: `No library entry with id ${input.id}.` }

      return {
        source,
        filled: result.filled,
        overwritten: result.overwritten,
        identifiersGained: result.filledIdentifiers,
        record: summarize(result.entry),
      }
    },
  },

  {
    name: "os_literature_screen",
    description:
      "Apply a collection rule to the library. Structured criteria (year range, language, item type, journal, title terms) " +
      "are checked deterministically; anything left over is returned for judgement against the rule's prose criteria. " +
      "Pass structured criteria that you can state exactly, so the model's judgement is spent only on what needs it. " +
      "A record with no decisive result is 'uncertain', never an automatic match.",
    input: {
      type: "object",
      properties: {
        rule: {
          type: "object",
          properties: {
            description: str("What this collection is looking for. Optional background."),
            inclusion: str("Criteria that must ALL be met."),
            exclusion: str("Criteria that must NONE apply."),
          },
          // `exclusion` is required alongside `inclusion`. It used to be optional here
// while the parser demanded it, so a caller following this schema was refused
// for a field the schema had said it could leave out.
required: ["inclusion", "exclusion"],
          additionalProperties: false,
        },
        criteria: {
          type: "array",
          description: "Structured, decidable criteria. Checked before any judgement.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["year-range", "language", "item-type", "journal", "title-terms", "abstract-present", "has-identifier"],
              },
              from: int("year-range: earliest publication year"),
              to: int("year-range: latest publication year"),
              languages: { type: "array", items: { type: "string" }, description: "language: allowed languages" },
              types: { type: "array", items: { type: "string" }, description: "item-type: allowed item types" },
              journals: { type: "array", items: { type: "string" }, description: "journal: allowed journals" },
              terms: { type: "array", items: { type: "string" }, description: "title-terms: terms to look for" },
              mode: { type: "string", enum: ["any", "all"], description: "title-terms: require any or all" },
              negate: { type: "boolean", description: "title-terms: invert the match" },
              required: { type: "boolean", description: "abstract-present: whether an abstract is required" },
              schemes: { type: "array", items: { type: "string" }, description: "has-identifier: required identifier schemes" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
        limit: int("Max records to report (default 20, max 100)."),
      },
      required: ["rule"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const rule = checkRule(input.rule)
      if (typeof rule === "string") return { error: ruleProblemMessage(rule) }

      const criteria = parseCriteria(input.criteria)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      if (!entries.length) return { count: 0, note: "The library is empty. Use os_literature_search to collect records." }

      // The rule passed here must be the one `decide` will stamp verdicts with.
      // It was accepted and echoed back while the stored rule stayed whatever
      // `set-rule` last wrote, so a record judged against this text was filed
      // under a different revision and then counted as a match for the rule it
      // had never been judged against. Accepting a second, unsaved rule is how
      // that happened, so the two are required to agree.
      const state = await loadScreening(ctx.workspace)
      if (state) {
        const stored = formatRule(state.rule)
        const supplied = formatRule(rule)
        if (stored !== supplied) {
          return {
            error:
              "This rule is not the one recorded for this screening. Decisions are stamped with the " +
              `recorded rule (revision ${state.ruleRevision}), so judging against a different rule here ` +
              "would file them under the wrong one. Call os_literature_screening_state with action " +
              "'set-rule' to change the rule first.",
            recordedRule: rulePrompt(stored),
            suppliedRule: rulePrompt(supplied),
            ruleRevision: state.ruleRevision,
          }
        }
      }

      const limit = Math.min(Number(input.limit ?? 20), 100)
      // Screen the newest `limit` records, but say so when that is a subset.
      // Truncating silently would let a caller read a tally of 20 and conclude
      // it described the whole library.
      const window = entries.slice(-limit)
      const results = window.map((entry) => {
        const outcome = screenRecord(entry.record, criteria)
        return {
          id: entry.id,
          title: entry.record.title,
          year: entry.record.issuedYear,
          journal: entry.record.containerTitle || undefined,
          structuredVerdict: outcome.verdict,
          bucket: reviewBucket(outcome.verdict),
          needsJudgement: outcome.needsJudgement,
          reason: outcome.summary,
          criteria: outcome.decided.map((r) => `${r.criterion.kind}: ${r.evidence}`),
          skipped: outcome.skipped.map((r) => `${r.criterion.kind}: ${r.evidence}`),
        }
      })

      const counts = results.reduce<Record<string, number>>((acc, r) => {
        acc[r.bucket] = (acc[r.bucket] ?? 0) + 1
        return acc
      }, {})

      const coverage =
        entries.length > results.length
          ? `Screened the ${results.length} most recent of ${entries.length} records; ` +
            "the rest were not judged. Raise `limit` to cover the library."
          : null

      return {
        counts,
        screened: results.length,
        librarySize: entries.length,
        rulePrompt: rulePrompt(formatRule(rule)),
        ruleRevision: state?.ruleRevision ?? null,
        note: [
          coverage,
          "Records marked needsJudgement passed the structured checks but have not been judged against the prose criteria. " +
            "Judge them yourself against the rule, or call os_literature_screening_state to record a decision.",
        ]
          .filter(Boolean)
          .join(" "),
        records: results,
      }
    },
  },

  {
    name: "os_literature_screening_state",
    description:
      "Record screening decisions and read back the tally. Use 'set-rule' to change the rule, which invalidates prior verdicts; " +
      "'decide' to record a judgement against the prose criteria; 'override' to force an include or exclude that no refresh can undo. " +
      "Changing the rule marks earlier decisions stale rather than silently reusing them.",
    input: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["read", "set-rule", "decide", "override", "reset-overrides"],
          description: "What to do.",
        },
        rule: {
          type: "object",
          properties: {
            description: str("What this collection is looking for. Optional background."),
            inclusion: str("Criteria that must ALL be met."),
            exclusion: str("Criteria that must NONE apply."),
          },
          // `exclusion` is required alongside `inclusion`. It used to be optional here
// while the parser demanded it, so a caller following this schema was refused
// for a field the schema had said it could leave out.
required: ["inclusion", "exclusion"],
          additionalProperties: false,
        },
        evidenceMode: {
          type: "string",
          enum: ["abstract", "full-text"],
          description:
            "The evidence you intend to judge on. Checked against what the library actually holds: " +
            "requesting full-text when no record has extracted text is refused rather than recorded.",
        },
        ruleRevision: {
          type: "integer",
          description:
            "For action 'decide': the ruleRevision these judgements were prepared against, as returned by " +
            "a previous read. Refused if the rule has changed since.",
        },
        decisions: {
          type: "array",
          description: "For action 'decide': one entry per record.",
          items: {
            type: "object",
            properties: {
              id: str("Library entry id."),
              verdict: { type: "string", enum: ["match", "no-match", "uncertain"] },
              reason: str("Why, in one sentence, citing the criterion that decided it."),
              confidence: { type: "number", minimum: 0, maximum: 1, description: "Optional." },
            },
            required: ["id", "verdict", "reason"],
            additionalProperties: false,
          },
        },
        overrides: {
          type: "array",
          description:
            "For action 'override': entries with the forced decision. For action 'reset-overrides': " +
            "the ids to clear, or omit the array to clear every override. `decision` is required only " +
            "for 'override'.",
          items: {
            type: "object",
            properties: {
              id: str("Library entry id."),
              decision: { type: "string", enum: ["include", "exclude"] },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const action = String(input.action)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      let state = await loadScreening(ctx.workspace)

      if (action === "set-rule") {
        const rule = checkRule(input.rule)
        if (typeof rule === "string") return { error: ruleProblemMessage(rule) }

        // The requested mode is checked against what the library actually holds
        // before it is stored. It used to be written straight into the screening
        // record, which then read back as a description of what the judgements
        // were based on — so a session could claim full-text screening while
        // every decision had been made from an abstract.
        const derived = evidenceFor(entries)
        if (input.evidenceMode) {
          const requested = input.evidenceMode === "full-text" ? "full-text" : "abstract"
          const check = checkEvidenceMode(requested, derived)
          if (!check.ok) {
            return { error: check.reason, availableEvidence: derived }
          }
        }
        const effective = derived.mode === "unavailable" ? "unavailable" : derived.mode

        state = state ? updateRule(state, rule) : createScreeningState(rule, effective)
        state = { ...state, evidenceMode: effective }
        await saveScreening(ctx.workspace, state)
        return {
          ruleRevision: state.ruleRevision,
          evidenceMode: state.evidenceMode,
          evidenceAvailable: derived,
          note: state.ruleRevision > 1
            ? "The rule changed, so earlier decisions are now stale rather than silently reused."
            : "Rule set.",
          rulePrompt: rulePrompt(formatRule(state.rule)),
        }
      }

      if (!state) return { error: "No screening rule has been set. Run this with action 'set-rule' first." }

      if (action === "decide") {
        const decisions = Array.isArray(input.decisions) ? input.decisions : []
        if (!decisions.length) return { error: "No decisions supplied." }
        // A caller that read the rule at revision N and is filing verdicts
        // later must say so; if the rule moved underneath it, those verdicts
        // were made against text that is no longer the rule, and stamping them
        // with the current revision would launder them into current results.
        if (typeof input.ruleRevision === "number" && input.ruleRevision !== state.ruleRevision) {
          return {
            error:
              `These decisions were prepared against rule revision ${input.ruleRevision}, but the ` +
              `recorded rule is now revision ${state.ruleRevision}. Re-read the rule and judge again ` +
              "against the current text.",
            ruleRevision: state.ruleRevision,
            rulePrompt: rulePrompt(formatRule(state.rule)),
          }
        }
        let recorded = 0
        const unknown: string[] = []
        const noEvidence: string[] = []
        for (const raw of decisions) {
          const id = String(raw.id)
          const entry = getById(entries, id)
          if (!entry) {
            unknown.push(id)
            continue
          }
          // The stored mode is a claim about what the verdicts were based on.
          // It was checked when the rule was set and then never again, so a
          // full-text screening could take a verdict about a record that has no
          // extracted text — an abstract-only judgement filed as a full-text
          // one, which is exactly the overstatement the mode exists to prevent.
          if (state.evidenceMode === "full-text" && !((entry.record.fullText?.characters ?? 0) > 0)) {
            noEvidence.push(id)
            continue
          }
          state.assessments.set(id, {
            itemId: id,
            decision: {
              itemId: id,
              verdict: raw.verdict,
              reason: String(raw.reason ?? ""),
              ruleRevision: state.ruleRevision,
              source: "model",
              confidence: typeof raw.confidence === "number" ? raw.confidence : undefined,
              decidedAt: new Date().toISOString(),
            },
          })
          recorded += 1
        }
        await saveScreening(ctx.workspace, state)
        return {
          recorded,
          unknownIds: unknown.length ? unknown : undefined,
          refusedForLackOfEvidence: noEvidence.length
            ? {
                ids: noEvidence,
                reason:
                  "This screening is recorded as full-text, but these records have no extracted text, so a " +
                  "judgement of them could only have been made from an abstract. Attach the PDF with " +
                  "os_literature_read_pdf, or set the rule to evidenceMode 'abstract' to judge on abstracts.",
              }
            : undefined,
        }
      }

      if (action === "override") {
        const list = Array.isArray(input.overrides) ? input.overrides : []
        if (!list.length) return { error: "No overrides supplied." }
        // An override is a durable verdict, so it has to name a record that
        // exists. Writing one for an unknown id left an entry in the ledger
        // that no record could ever clear, and it still counted toward the
        // totals — an exclusion applied to nothing.
        const unknown: string[] = []
        const noDecision: string[] = []
        for (const raw of list) {
          const id = String(raw.id)
          if (!getById(entries, id)) {
            unknown.push(id)
            continue
          }
          // The schema allows `decision` to be absent so that reset-overrides
          // can name ids without inventing one; an override still needs it.
          if (raw.decision !== "include" && raw.decision !== "exclude") {
            noDecision.push(id)
            continue
          }
          state = override(state, id, raw.decision)
        }
        if (noDecision.length) {
          await saveScreening(ctx.workspace, state)
          return {
            error:
              "An override needs a decision of 'include' or 'exclude' for each id; none was given for: " +
              noDecision.join(", "),
            overridden: list.length - unknown.length - noDecision.length,
            missingDecision: noDecision,
          }
        }
        if (unknown.length) {
          await saveScreening(ctx.workspace, state)
          return {
            error:
              "These ids are not in the library, so an override for them would apply to no record: " +
              unknown.join(", "),
            overridden: list.length - unknown.length,
            unknownIds: unknown,
          }
        }
        await saveScreening(ctx.workspace, state)
        return { overridden: list.length }
      }

      if (action === "reset-overrides") {
        const list = Array.isArray(input.overrides) ? input.overrides : []
        state = clearOverrides(
          state,
          list.length ? list.map((raw: any) => String(raw.id)) : [...state.overrides.keys()],
        )
        await saveScreening(ctx.workspace, state)
        return { overridesRemaining: state.overrides.size }
      }

      // read
      const ids = entries.map((entry) => entry.id)
      // Reported from the library, not from the stored state: text may have been
      // extracted since the session was set, and the record should describe the
      // evidence that exists now.
      const derived = evidenceFor(entries)
      const stored = state.evidenceMode
      return {
        ruleRevision: state.ruleRevision,
        evidenceMode: derived.mode,
        evidenceModeStored: stored,
        evidenceAvailable: derived,
        ...(derived.mode !== stored
          ? {
              note:
                `The screening record says '${stored}' but the library currently supports ` +
                `'${derived.mode}'. The mode now reported is the derived one.`,
            }
          : {}),
        rulePrompt: rulePrompt(formatRule(state.rule)),
        counts: tally(state, ids),
        overrides: Object.fromEntries(state.overrides),
        undecided: ids.filter((id) => !state!.assessments.has(id) && !state!.overrides.has(id)).length,
        pendingJudgement: ids.filter((id) => {
          const outcome = effectiveVerdict(state!, id)
          return outcome.verdict === "pending" || outcome.verdict === "stale" || outcome.verdict === "uncertain"
        }).length,
      }
    },
  },

  {
    name: "os_literature_read_pdf",
    description:
      "Extract a paper's full text from a PDF and attach it to a library record, so screening can be " +
      "judged on full text rather than on the abstract. Uses whichever PDF library the user's " +
      "interpreter already has. Reports honestly when a PDF has no text layer or no library can read it.",
    input: {
      type: "object",
      properties: {
        id: str("Library entry id, as returned by os_literature_list."),
        path: str("Workspace-relative path to the PDF file."),
        allowMismatch: {
          type: "boolean",
          description:
            "Attach even when the PDF does not look like the record (no DOI match, and under half the " +
            "title's distinctive words in its opening pages). Only for a document you have confirmed " +
            "another way, such as a scanned or differently typeset copy.",
        },
      },
      required: ["id", "path"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const id = String(input.id)
      const pdfPath = String(input.path)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      const entry = getById(entries, id)
      if (!entry) return { error: `No library entry with id ${id}. Run os_literature_list to see the ids.` }

      let source: string
      try {
        source = resolveInsideWorkspace(ctx.workspace, pdfPath)
      } catch (error) {
        // resolveInsideWorkspace already says "refusing a path outside the
        // workspace"; repeating the prefix produced a doubled sentence.
        return { error: (error as Error).message }
      }

      const attached = await attachFullText(ctx, entry, source, {
        allowMismatch: input.allowMismatch === true,
      })
      if (!attached.ok) {
        return {
          ok: false,
          id,
          reason: attached.reason,
          attempts: attached.attempts,
          note: attached.note,
          identity: attached.identity,
        }
      }

      entry.record.fullText = attached.fullText
      entry.updatedAt = new Date().toISOString()
      await library.save(entries)

      const identity = attached.fullText.identity
      return {
        ok: true,
        id,
        title: entry.record.title,
        extractor: attached.fullText.extractor,
        pages: attached.fullText.pages,
        characters: attached.fullText.characters,
        sections: attached.fullText.sections,
        storedAt: attached.fullText.path,
        // Reported so a reader can see whether the text was tied to this record
        // or merely placed on it.
        matchedRecord: identity?.overridden
          ? "no — attached with allowMismatch, so the text is not confirmed to be this paper"
          : identity?.confirmedBy
            ? `yes (${identity.confirmedBy === "doi" ? "the record's DOI appears in the text" : "the title appears in the opening pages"})`
            : "not checked (the record has no title or DOI to compare)",
        note:
          "Full text is now available for this record, so os_literature_screen can be judged on " +
          "full text. Use os_literature_read_section to read a specific part.",
      }
    },
  },

  {
    name: "os_literature_read_section",
    description:
      "Read part of a paper's extracted full text: a named section, a page range, or the whole " +
      "document within a size budget. Requires os_literature_read_pdf to have been run on the record first.",
    input: {
      type: "object",
      properties: {
        id: str("Library entry id."),
        section: str("Section heading to read, matched against the extracted section list (case-insensitive)."),
        fromPage: int("First page to read, 1-based."),
        toPage: int("Last page to read, inclusive."),
        maxChars: int("Character budget for the returned text (default 4000, max 40000)."),
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const id = String(input.id)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      const entry = getById(entries, id)
      if (!entry) return { error: `No library entry with id ${id}.` }
      const fullText = entry.record.fullText
      if (!fullText) {
        return {
          error: `This record has no extracted full text. Run os_literature_read_pdf on it first, ` +
            `or judge it from the abstract (evidenceMode 'abstract').`,
        }
      }

      const budget = Math.min(Number(input.maxChars ?? PAGE_BUDGET), DOCUMENT_BUDGET)
      const pagesDir = join(ctx.workspace, ".opencode-science", "fulltext", id, "pages")
      const allPages = await readPageFiles(pagesDir, fullText.pages)

      let selected = allPages
      let what = `the whole document (${allPages.length} pages)`

      if (input.section !== undefined) {
        const wanted = String(input.section).toLowerCase()
        const hit = fullText.sections.find((s) => s.title.toLowerCase().includes(wanted))
        if (!hit) {
          return {
            error: `No section matching '${input.section}'.`,
            availableSections: fullText.sections.map((s) => `${s.title} (p.${s.page})`),
          }
        }
        const nextIdx = fullText.sections.findIndex((s) => s.page > hit.page)
        const lastPage = nextIdx === -1 ? fullText.pages : fullText.sections[nextIdx].page - 1
        selected = allPages.slice(hit.page - 1, lastPage)
        what = `section '${hit.title}' (pages ${hit.page}-${lastPage})`
      } else if (input.fromPage !== undefined || input.toPage !== undefined) {
        const from = Math.max(1, Number(input.fromPage ?? 1))
        const to = Math.min(allPages.length, Number(input.toPage ?? from))
        selected = allPages.slice(from - 1, to)
        what = `pages ${from}-${to}`
      }

      const joined = selected.join("\n\n").trim()
      return {
        id,
        title: entry.record.title,
        reading: what,
        pagesReturned: selected.length,
        totalCharacters: joined.length,
        truncated: joined.length > budget,
        text: joined.length > budget ? `${joined.slice(0, budget)}\n... (truncated)` : joined,
      }
    },
  },

  {
    name: "os_literature_lookup",
    description:
      "Find a stored record by DOI, PMID, PMCID, or arXiv id, accepting any common spelling. " +
      "Use it to check whether something is already in the library before searching for it again.",
    input: {
      type: "object",
      properties: {
        identifier: str("DOI, PMID, PMCID, or arXiv id, in any spelling."),
      },
      required: ["identifier"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const raw = String(input.identifier)
      const parsed = parseIdentifier(raw)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      if (!entries.length) return { found: false, note: "The library is empty." }

      if (!parsed) {
        return {
          found: false,
          query: raw,
          note:
            "That is not a recognizable DOI, PMID, PMCID, or arXiv id. " +
            "Check for a typo, or search for the record instead.",
        }
      }

      const matches = findByIdentifier(entries, parsed.scheme, parsed.value)
      return {
        found: matches.length > 0,
        query: raw,
        normalized: parsed,
        matches: matches.map((entry: LibraryEntry) => ({ ...summarize(entry), abstract: entry.record.abstract || undefined })),
      }
    },
  },
]

function parseYearParts(value: string): [number] | number[] {
  const year = inferYear(String(value))
  return year ? [year] : []
}