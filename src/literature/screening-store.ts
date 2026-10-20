/**
 * The screening record on disk.
 *
 * Split out from tools.ts so the export tool can read the recorded verdicts
 * without importing the tool definitions, which would have made the two files
 * import each other.
 */

import { createScreeningState, parseRule, type ScreeningState } from "./screening.ts"

/** Where the screening record lives, alongside the library. */
export const SCREEN_FILE = ".opencode-science/screening.json"

/**
 * Reads the screening record, or reports why it could not be read.
 *
 * A file that exists and will not parse is reported, not treated as absent.
 * Reading it as absent would drop the rule and every recorded verdict, and
 * the next write would replace them with a fresh empty state.
 */
export async function loadScreening(workspace: string): Promise<ScreeningState | undefined> {
  let text: string
  try {
    const { readFile } = await import("node:fs/promises")
    text = await readFile(`${workspace}/${SCREEN_FILE}`, "utf8")
  } catch {
    // No screening file is the ordinary "not screened yet" case.
    return undefined
  }
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `The screening record at ${SCREEN_FILE} could not be read as JSON and was left untouched. ` +
        "Move it aside to start a new screening record.",
    )
  }
  const rule = parseRule(parsed?.rule)
  if (!rule) {
    throw new Error(
      `The screening record at ${SCREEN_FILE} is not in a recognised form and was left untouched.`,
    )
  }
  const state = createScreeningState(rule, parsed.evidenceMode ?? "abstract")
  state.ruleRevision = parsed.ruleRevision ?? 1
  for (const [itemId, decision] of Object.entries(parsed.assessments ?? {})) {
    state.assessments.set(itemId, { itemId, decision: decision as any })
  }
  for (const [itemId, value] of Object.entries(parsed.overrides ?? {})) {
    state.overrides.set(itemId, value as "include" | "exclude")
  }
  return state
}

/** Writes the screening record, renamed into place. */
export async function saveScreening(workspace: string, state: ScreeningState): Promise<void> {
  const { mkdir, rename, rm, writeFile } = await import("node:fs/promises")
  await mkdir(`${workspace}/.opencode-science`, { recursive: true })
  const assessments: Record<string, unknown> = {}
  for (const [itemId, assessment] of state.assessments) {
    assessments[itemId] = assessment.decision
  }
  const overrides: Record<string, string> = {}
  for (const [itemId, value] of state.overrides) overrides[itemId] = value
  // Renamed into place so an interrupted write cannot leave a truncated record
  // that the next read would reject.
  const target = `${workspace}/${SCREEN_FILE}`
  const temp = `${target}.${process.pid}.tmp`
  try {
    await writeFile(
      temp,
      JSON.stringify(
        {
          rule: state.rule,
          ruleRevision: state.ruleRevision,
          evidenceMode: state.evidenceMode,
          assessments,
          overrides,
        },
        null,
        2,
      ),
      "utf8",
    )
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
}
