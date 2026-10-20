/**
 * Structured pre-screening.
 *
 * A collection rule is written in prose, but part of it is decidable without a
 * model: a publication year range, a language, an item type, a journal
 * allowlist. Those checks are cheap, reproducible, and produce the same answer
 * every time, which is exactly what a model verdict does not.
 *
 * The point is not to replace the model's judgement. It is to decide the parts
 * that do not need judgement, so the model is only asked about the remainder
 * and an `uncertain` verdict means "the prose criteria are open to reading",
 * not "nothing was checked".
 *
 * Adapted from upstream literature-screening (Apache-2.0).
 */

import type { BibliographicRecord } from "./identifiers.ts"
import type { Verdict } from "./screening.ts"

export type Criterion =
  | { kind: "year-range"; from?: number; to?: number }
  | { kind: "language"; languages: string[] }
  | { kind: "item-type"; types: string[] }
  | { kind: "journal"; journals: string[] }
  | { kind: "title-terms"; terms: string[]; mode: "any" | "all"; negate?: boolean }
  | { kind: "abstract-present"; required: boolean }
  | { kind: "has-identifier"; schemes: string[] }

/** What a criterion concluded about one record. */
export type CriterionResult = {
  criterion: Criterion
  passed: boolean
  /** Human-readable reason, quoting the value that decided it. */
  evidence: string
  /** True when the record lacked the field the criterion needs. */
  skipped?: boolean
}

export type ScreenOutcome = {
  verdict: Verdict
  /** Criteria that decided the verdict outright. */
  decided: CriterionResult[]
  /** Criteria that could not be applied because a field was missing. */
  skipped: CriterionResult[]
  /** The prose remainder, for the model to judge. */
  needsJudgement: boolean
  summary: string
}

const ITEM_TYPE_ALIASES: Record<string, string> = {
  article: "journalArticle",
  "journal-article": "journalArticle",
  "journal article": "journalArticle",
  review: "review",
  preprint: "preprint",
  "posted-content": "preprint",
  conference: "conferencePaper",
  "conference-paper": "conferencePaper",
  "proceedings-article": "conferencePaper",
  book: "book",
  chapter: "bookSection",
  "book-section": "bookSection",
  thesis: "thesis",
  dissertation: "thesis",
  report: "report",
  dataset: "dataset",
  standard: "standard",
  patent: "patent",
  webpage: "webpage",
  document: "document",
}

/** Parses criteria from a JSON array, skipping anything unrecognized. */
export function parseCriteria(value: unknown): Criterion[] {
  if (!Array.isArray(value)) return []
  const out: Criterion[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const raw = entry as Record<string, any>
    switch (raw.kind) {
      case "year-range": {
        const from = typeof raw.from === "number" ? raw.from : undefined
        const to = typeof raw.to === "number" ? raw.to : undefined
        if (from !== undefined || to !== undefined) out.push({ kind: "year-range", from, to })
        break
      }
      case "language": {
        const languages = toStringList(raw.languages)
        if (languages.length) out.push({ kind: "language", languages })
        break
      }
      case "item-type": {
        const types = toStringList(raw.types)
          .map((value) => ITEM_TYPE_ALIASES[value.toLowerCase()] ?? value)
          .filter((value) => Object.values(ITEM_TYPE_ALIASES).includes(value as any))
        if (types.length) out.push({ kind: "item-type", types })
        break
      }
      case "journal": {
        const journals = toStringList(raw.journals)
        if (journals.length) out.push({ kind: "journal", journals })
        break
      }
      case "title-terms": {
        const terms = toStringList(raw.terms)
        if (terms.length) {
          out.push({
            kind: "title-terms",
            terms,
            mode: raw.mode === "all" ? "all" : "any",
            ...(raw.negate === true ? { negate: true } : {}),
          })
        }
        break
      }
      case "abstract-present": {
        if (typeof raw.required === "boolean") out.push({ kind: "abstract-present", required: raw.required })
        break
      }
      case "has-identifier": {
        const schemes = toStringList(raw.schemes)
        if (schemes.length) out.push({ kind: "has-identifier", schemes })
        break
      }
      default:
        break
    }
  }
  return out
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

/**
 * Applies one criterion to a record.
 *
 * A criterion whose input field is absent is `skipped` rather than failed.
 * Failing a record for a year filter when the record has no year would discard
 * a study over missing metadata, which is the opposite of what a screen is for.
 */
export function evaluateCriterion(criterion: Criterion, record: BibliographicRecord): CriterionResult {
  switch (criterion.kind) {
    case "year-range": {
      const year = record.issuedYear
      if (year === undefined) {
        return {
          criterion,
          passed: false,
          skipped: true,
          evidence: `no publication year on record (issuedText: ${JSON.stringify(record.issuedText)})`,
        }
      }
      const tooEarly = criterion.from !== undefined && year < criterion.from
      const tooLate = criterion.to !== undefined && year > criterion.to
      return {
        criterion,
        passed: !tooEarly && !tooLate,
        evidence:
          tooEarly || tooLate
            ? `year ${year} is outside ${criterion.from ?? "-inf"}..${criterion.to ?? "+inf"}`
            : `year ${year} is within ${criterion.from ?? "-inf"}..${criterion.to ?? "+inf"}`,
      }
    }

    case "language": {
      const language = record.language.trim().toLowerCase()
      if (!language) {
        return { criterion, passed: false, skipped: true, evidence: "no language on record" }
      }
      const base = language.split(/[-_]/)[0]
      const matched = criterion.languages.some((want) => {
        const w = want.toLowerCase().split(/[-_]/)[0]
        return w === language || w === base
      })
      return {
        criterion,
        passed: matched,
        evidence: matched ? `language ${record.language} is allowed` : `language ${record.language} is not in ${criterion.languages.join(", ")}`,
      }
    }

    case "item-type": {
      const passed = criterion.types.includes(record.itemType)
      return {
        criterion,
        passed,
        evidence: passed
          ? `item type ${record.itemType} is allowed`
          : `item type ${record.itemType} is not in ${criterion.types.join(", ")}`,
      }
    }

    case "journal": {
      const journal = record.containerTitle.trim()
      if (!journal) {
        return { criterion, passed: false, skipped: true, evidence: "no journal on record" }
      }
      const lowered = journal.toLowerCase()
      const matched = criterion.journals.some((want) => {
        const w = want.toLowerCase()
        return lowered === w || lowered.includes(w) || w.includes(lowered)
      })
      return {
        criterion,
        passed: matched,
        evidence: matched ? `journal "${journal}" is allowed` : `journal "${journal}" is not in the allowlist`,
      }
    }

    case "title-terms": {
      const title = record.title.toLowerCase()
      if (!title) {
        return { criterion, passed: false, skipped: true, evidence: "no title on record" }
      }
      const hits = criterion.terms.filter((term) => title.includes(term.toLowerCase()))
      const met =
        criterion.mode === "all" ? hits.length === criterion.terms.length : hits.length > 0
      const negated = criterion.negate === true
      return {
        criterion,
        passed: negated ? !met : met,
        evidence: `${hits.length}/${criterion.terms.length} terms present${negated ? " (negated)" : ""}: ${
          hits.length ? hits.join(", ") : "none"
        }`,
      }
    }

    case "abstract-present": {
      const has = record.abstract.trim().length > 0
      return {
        criterion,
        passed: criterion.required ? has : true,
        evidence: has ? "abstract present" : "no abstract on record",
      }
    }

    case "has-identifier": {
      const present = record.identifiers.map((identifier) => identifier.scheme)
      const matched = criterion.schemes.filter((scheme) => present.includes(scheme as any))
      return {
        criterion,
        passed: matched.length > 0,
        evidence: matched.length
          ? `identifiers present: ${matched.join(", ")}`
          : `none of ${criterion.schemes.join(", ")} present (record has ${present.join(", ") || "none"})`,
      }
    }

    default: {
      const never: never = criterion
      throw new Error(`unhandled criterion: ${JSON.stringify(never)}`)
    }
  }
}

/**
 * Screens a record against structured criteria.
 *
 * A failure is decisive: it excludes. Anything that merely failed to be checked
 * leaves the record open for the prose criteria, and a record with no decisive
 * result at all is `uncertain` rather than a match, because the structured
 * checks passing is not the rule being satisfied.
 */
export function screenRecord(record: BibliographicRecord, criteria: Criterion[]): ScreenOutcome {
  if (!criteria.length) {
    return {
      verdict: "uncertain",
      decided: [],
      skipped: [],
      needsJudgement: true,
      summary: "No structured criteria; every record needs a prose judgement against the rule.",
    }
  }

  const decided: CriterionResult[] = []
  const skipped: CriterionResult[] = []

  for (const criterion of criteria) {
    const result = evaluateCriterion(criterion, record)
    if (result.skipped) skipped.push(result)
    else decided.push(result)
  }

  const failures = decided.filter((result) => !result.passed)

  if (failures.length) {
    return {
      verdict: "no-match",
      decided,
      skipped,
      needsJudgement: false,
      summary: `excluded: ${failures.map((f) => f.evidence).join("; ")}`,
    }
  }

  const allPassed = decided.length > 0
  return {
    verdict: "uncertain",
    decided,
    skipped,
    // Passing the structured checks is not the rule being satisfied; the prose
    // remainder still has to be judged, so this is never a match on its own.
    needsJudgement: true,
    summary: allPassed
      ? `structured checks passed (${decided.length}); ${
          skipped.length ? `${skipped.length} skipped for missing fields; ` : ""
        }prose criteria still to judge`
      : "nothing decidable from the record's fields; prose judgement required",
  }
}