/**
 * Screening rules.
 *
 * A collection rule is a description plus inclusion and exclusion criteria. It
 * is stored as JSON, because it is data that has to round-trip through
 * revisions and comparisons, and rendered as prose for the model, because prose
 * is what a person actually reads and edits.
 *
 * Adapted from upstream literature-screening (Apache-2.0). The three-part rule
 * shape, the length bounds, and the serialization format are preserved.
 */

export const RULE_MAX_LENGTH = 2000
export const RULE_STORAGE_MAX_LENGTH = 12100

export type CollectionRule = {
  /** Background context for whoever reads the prompt. May be empty. */
  description: string
  /** Every clause here must hold for a record to be included. */
  inclusion: string
  /** Any clause here disqualifies a record. */
  exclusion: string
}

/**
 * Why a rule was rejected.
 *
 * Reported instead of a single boolean so the caller can be told which field is
 * actually missing. A rule arriving with a fine `inclusion` and no `exclusion`
 * used to be refused with a message naming `inclusion`, which sent the caller
 * looking at the one field that was fine.
 */
export type RuleProblem = "not-an-object" | "missing-inclusion" | "missing-exclusion" | "too-long"

/** Validates a collection rule, naming the field at fault when it fails. */
export function checkRule(value: unknown): CollectionRule | RuleProblem {
  if (typeof value !== "object" || value === null) return "not-an-object"
  const raw = value as Record<string, unknown>
  // Read each field once, narrowed, so the rule is built from strings rather
  // than from values that might not be strings.
  const read = (field: "description" | "inclusion" | "exclusion"): string | undefined => {
    const fieldValue = raw[field]
    return typeof fieldValue === "string" ? fieldValue.trim() : undefined
  }
  const description = read("description")
  const inclusion = read("inclusion")
  const exclusion = read("exclusion")

  // `inclusion` and `exclusion` are both required, and the JSON schema says so.
  // An empty exclusion is not the same as an absent one: defaulting it would
  // tell the reader that nothing disqualifies a record, when what actually
  // happened is that nobody wrote one. `description` is background prose and
  // genuinely optional, so it is the only one with a default.
  if (!inclusion) return "missing-inclusion"
  if (!exclusion) return "missing-exclusion"

  const rule: CollectionRule = {
    description: description ?? "",
    inclusion,
    exclusion,
  }
  const total = rule.description.length + rule.inclusion.length + rule.exclusion.length
  if (total > RULE_MAX_LENGTH) return "too-long"
  return rule
}

/** Rejects a rule that is too long to be applied or stored. */
export function parseRule(value: unknown): CollectionRule | undefined {
  const result = checkRule(value)
  return typeof result === "string" ? undefined : result
}

/** The persisted representation. */
export function formatRule(rule: CollectionRule): string {
  return JSON.stringify({
    description: rule.description.trim(),
    inclusion: rule.inclusion.trim(),
    exclusion: rule.exclusion.trim(),
  })
}

/** Reads a persisted rule back, or undefined when it cannot be trusted. */
export function readRule(text: string): CollectionRule | undefined {
  try {
    return parseRule(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * Renders a rule as the prompt a screener is given.
 *
 * The wording is load-bearing: "all must be met" and "none may apply" are the
 * whole difference between a conjunction and a disjunction, and getting them
 * backwards silently changes which papers a review keeps.
 */
export function rulePrompt(text: string): string {
  const rule = readRule(text)
  if (!rule) throw new Error("Invalid structured collection rule.")
  return [
    `Background:\n${rule.description}`,
    "",
    `Inclusion criteria (all must be met):\n${rule.inclusion}`,
    "",
    `Exclusion criteria (none may apply):\n${rule.exclusion}`,
  ].join("\n")
}

/** Three-valued verdict. `uncertain` is a real outcome, not a failure. */
export type Verdict = "match" | "no-match" | "uncertain"

export type Decision = {
  itemId: string
  verdict: Verdict
  /** Why this verdict, in one sentence, citing the criterion that decided it. */
  reason: string
  /** Rule revision the decision was made against. */
  ruleRevision: number
  /** Where the verdict came from. */
  source: "structured" | "model" | "manual"
  confidence?: number
  decidedAt: string
}

export type Assessment = {
  itemId: string
  decision: Decision
  /** Set when a human overrode the model. */
  override?: "include" | "exclude"
}

/**
 * The reason a stored verdict no longer applies.
 *
 * A screening run is not a permanent verdict: if the rule changes, the model
 * changes, or the evidence underneath it is replaced, the old answer describes
 * a question that is no longer being asked.
 */
export type StaleReason =
  | "rule-changed"
  | "model-changed"
  | "input-changed"
  | "missing-evidence"
  | "uncertain"

/**
 * What the library can actually be screened on.
 *
 * `unavailable` is the case that matters: a record with neither an abstract nor
 * extracted full text supports no evidence-based judgement at all, and saying
 * so is better than defaulting to the abstract and letting an empty string read
 * as an abstract that said nothing.
 */
export type EvidenceMode = "abstract" | "full-text" | "unavailable"

/** A record, as far as evidence availability is concerned. */
export type EvidenceCarrier = {
  abstract: string
  fullText?: { characters: number }
}

/**
 * Derives the evidence mode from the library rather than trusting the caller.
 *
 * `full-text` wins when any record has extracted text, because screening is a
 * per-record judgement and one full text does not make the rest full text — so
 * the mode is a ceiling, not a statement that every record has it. Which records
 * actually do is reported alongside it.
 */
export function deriveEvidenceMode(entries: readonly EvidenceCarrier[]): {
  mode: EvidenceMode
  withFullText: number
  withAbstract: number
  total: number
} {
  const total = entries.length
  const withFullText = entries.filter((e) => (e.fullText?.characters ?? 0) > 0).length
  const withAbstract = entries.filter(
    (e) => e.abstract.trim().length > 0 || (e.fullText?.characters ?? 0) > 0,
  ).length
  const mode: EvidenceMode =
    withFullText > 0 ? "full-text" : withAbstract > 0 ? "abstract" : "unavailable"
  return { mode, withFullText, withAbstract, total }
}

/**
 * Whether a requested mode is served by what the library holds.
 *
 * The refusal exists because the mode is written into the screening record and
 * read back later as a description of what the judgements were based on.
 */
export function checkEvidenceMode(
  requested: "abstract" | "full-text",
  derived: ReturnType<typeof deriveEvidenceMode>,
): { ok: true; mode: EvidenceMode } | { ok: false; reason: string } {
  if (requested === "full-text" && derived.mode !== "full-text") {
    return {
      ok: false,
      reason:
        derived.mode === "unavailable"
          ? "Full-text screening needs extracted text, and no record in this library has an abstract " +
            "or extracted text either. Use os_literature_read_pdf to extract it, or screen on the " +
            "abstract after filling metadata with os_literature_complete."
          : `Full-text screening needs extracted text, and none of these ${derived.total} records has ` +
            `any: ${derived.withAbstract} have an abstract and 0 have extracted text. Run ` +
            "os_literature_read_pdf on the ones you want judged on full text, or screen on the abstract.",
    }
  }
  if (requested === "abstract" && derived.mode === "unavailable") {
    return {
      ok: false,
      reason:
        "No record in this library has an abstract or extracted text, so no evidence-based " +
        "judgement is possible. Fill metadata with os_literature_complete or extract full text.",
    }
  }
  return { ok: true, mode: derived.mode }
}

export type ScreeningState = {
  rule: CollectionRule
  ruleRevision: number
  evidenceMode: EvidenceMode
  assessments: Map<string, Assessment>
  /** Overrides, kept apart so a refresh cannot silently discard them. */
  overrides: Map<string, "include" | "exclude">
}

export function createScreeningState(rule: CollectionRule, evidenceMode: EvidenceMode): ScreeningState {
  return {
    rule,
    ruleRevision: 1,
    evidenceMode,
    assessments: new Map(),
    overrides: new Map(),
  }
}

/** Changes the rule and invalidates every verdict that was made against it. */
export function updateRule(state: ScreeningState, rule: CollectionRule): ScreeningState {
  const next: ScreeningState = {
    ...state,
    rule,
    ruleRevision: state.ruleRevision + 1,
    // Map is copied rather than shared: the old state's verdicts must not
    // change under the caller that still holds it.
    assessments: new Map(state.assessments),
    overrides: new Map(state.overrides),
  }
  return next
}

/** Records a manual decision, which always wins over any model verdict. */
export function override(state: ScreeningState, itemId: string, decision: "include" | "exclude"): ScreeningState {
  const overrides = new Map(state.overrides)
  overrides.set(itemId, decision)
  return { ...state, overrides }
}

export function clearOverrides(state: ScreeningState, itemIds: string[]): ScreeningState {
  const overrides = new Map(state.overrides)
  for (const id of itemIds) overrides.delete(id)
  return { ...state, overrides }
}

/**
 * The verdict that actually applies.
 *
 * An override outranks the recorded assessment. `stale` is reported when the
 * assessment was made against a different rule revision, so a caller can tell
 * "no" from "not under this rule any more" — collapsing those would report a
 * stale match as a current exclusion.
 */
export function effectiveVerdict(
  state: ScreeningState,
  itemId: string,
): { verdict: Verdict | "pending" | "stale"; decision?: Decision; override?: "include" | "exclude"; staleReason?: StaleReason } {
  const manual = state.overrides.get(itemId)
  if (manual) return { verdict: manual === "include" ? "match" : "no-match", override: manual }

  const assessment = state.assessments.get(itemId)
  if (!assessment) return { verdict: "pending" }

  if (assessment.decision.ruleRevision !== state.ruleRevision) {
    return { verdict: "stale", decision: assessment.decision, staleReason: "rule-changed" }
  }
  return { verdict: assessment.decision.verdict, decision: assessment.decision }
}

/** Counts by effective verdict, which is what a progress display needs. */
export function tally(state: ScreeningState, itemIds: string[]) {
  const counts = { match: 0, "no-match": 0, uncertain: 0, pending: 0, stale: 0, overridden: 0 }
  for (const id of itemIds) {
    const outcome = effectiveVerdict(state, id)
    if (outcome.override) {
      counts.overridden += 1
      if (outcome.override === "include") counts.match += 1
      else counts["no-match"] += 1
      continue
    }
    counts[outcome.verdict] += 1
  }
  return counts
}

/**
 * Turns `uncertain` into a review bucket.
 *
 * Upstream maps `no-match` to `review` rather than discarding it, and the same
 * caution applies here: a record the screener could not confidently reject is
 * not the same as one it confidently rejected, and merging them quietly loses
 * studies. `no-match` is kept separate from `uncertain` for that reason.
 */
export function reviewBucket(verdict: Verdict | "pending" | "stale"): "match" | "review" | "no-match" | "pending" {
  switch (verdict) {
    case "match":
      return "match"
    case "uncertain":
    case "stale":
      return "review"
    case "no-match":
      return "no-match"
    default:
      return "pending"
  }
}