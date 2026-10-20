/**
 * Reviewer tools.
 *
 * The rubric tells a reviewer to trace rather than recompute, and to read a
 * turn only through dedicated tools. These are those tools. Each one reads a
 * record that already exists — a session message list, a notebook run log, a
 * published artifact — and none of them evaluates anything.
 *
 * The reviewer gets no analysis ability on purpose. It cannot read arbitrary
 * files, run code, or search: a reviewer that can recompute stops being able to
 * tell the agent's error from its own.
 */

import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { readRunHistory } from "./notebook.ts"
import { readProvenance } from "./provenance.ts"
import {
  blocksFromMessages,
  outputText,
  type RecordedExecution,
  type TurnRecorder,
} from "./turn-recorder.ts"

/** The part of the session domain the reviewer needs to read a turn. */
export type ReviewSession = {
  context: (input: { sessionID: string }) => Promise<unknown>
  get: (input: { sessionID: string }) => Promise<{ parentID?: string } | undefined>
}

/** Schemas for the reviewer tools. */
export const READ_TURN_INPUT = {
  type: "object",
  properties: {
    sessionID: {
      type: "string",
      description:
        "Session under review. Optional: omitted, the reviewer walks up from its own session to its " +
        "root, which is the session whose turn it was launched to audit.",
    },
  },
  additionalProperties: false,
} as const

export const QUERY_EXECUTION_LOG_INPUT = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "A callID from read_turn, or a runId printed by notebook_run.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const

export const READ_ARTIFACT_INPUT = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "An artifact version id, as returned by publish_artifact or list_provenance.",
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const

export const SUBMIT_FINDINGS_INPUT = {
  type: "object",
  properties: {
    checks: {
      type: "array",
      description:
        "One entry per area verified. Consolidated: one per area, never one per value traced. " +
        "Passes are recorded even though they are not shown to the agent under review.",
      items: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["pass", "warn", "fail"],
            description: "pass = verified ok, warn = minor, fail = serious. There is no inconclusive status.",
          },
          claim: { type: "string", description: "What you checked, or what the agent claimed." },
          evidence: { type: "string", description: "What you found, citing only what you actually read." },
          blockIndex: {
            type: "integer",
            description: "Required for warn and fail: the read_turn index of the block at issue.",
          },
          contentHash: {
            type: "string",
            description: "Required for warn and fail: a hash of the text the finding is about.",
          },
          artifactVersionId: {
            type: "string",
            description: "Optional, when the check concerns a specific artifact.",
          },
        },
        required: ["status", "claim", "evidence"],
      },
    },
  },
  required: ["checks"],
  additionalProperties: false,
} as const

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... (${value.length - limit} more characters)`
}

/**
 * Finds the session under review.
 *
 * A reviewer is a subagent, so its own session id is not the session whose turn
 * it was launched to audit. Walking the parent chain finds the root, which is
 * the conversation the work happened in. An explicit sessionID short-circuits
 * the walk.
 */
async function resolveReviewTarget(
  session: ReviewSession,
  startID: string,
  explicit?: string,
): Promise<string> {
  if (explicit) return explicit
  let current = startID
  // Bounded so a malformed parent chain cannot spin.
  for (let hop = 0; hop < 16; hop += 1) {
    let info: { parentID?: string } | undefined
    try {
      info = await session.get({ sessionID: current })
    } catch {
      return current
    }
    const parent = info?.parentID
    if (!parent) return current
    current = parent
  }
  return current
}

/**
 * True when a buffer should not be shown as text.
 *
 * Decided from the bytes rather than the extension, because the extension lies:
 * a CSV can hold binary and a `.dat` can hold text. The first 8 KB are examined,
 * and a NUL byte or a high share of non-printable bytes settles it. UTF-8 text
 * without control characters other than tab, newline and carriage return is not
 * binary, so ordinary CSV and source files still read normally.
 */
function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8_192)
  if (!sample.length) return false
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 0) return true
    // Tab, LF, CR and printable ASCII are fine; everything else below 0x20, and
    // the C1 range, are not expected in a text file.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || (byte >= 0x7f && byte <= 0x9f)) suspicious += 1
  }
  return suspicious / sample.length > 0.3
}

/**
 * Describes a binary artifact well enough to be reviewed.
 *
 * For an image the dimensions come from the header, so a reviewer can at least
 * confirm the artifact is the figure it claims to be and not a truncated stub.
 */
async function describeBinary(buffer: Buffer): Promise<string[]> {
  const lines: string[] = []

  if (buffer.length >= 24 && buffer.readUInt32BE(0) === 0x89504e47) {
    // PNG: IHDR width and height are big-endian uint32s at offsets 16 and 20.
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    lines.push(`type: PNG image, ${width} x ${height} pixels`)
    // The first chunk starts at 8 with a 4-byte length, so its type — "IHDR" —
    // is at 12..16. Reading from 8 compared the length bytes against "IHDR",
    // which is never true, so every valid PNG was reported as failing its
    // signature check.
    lines.push(`IHDR chunk ok: ${buffer.toString("latin1", 12, 16) === "IHDR"}`)
    lines.push("")
    lines.push(
      "The image itself is not rendered here. To inspect it, open the file at the path recorded",
      "in the provenance entry, or compare its checksum against the one above.",
    )
    return lines
  }

  if (buffer.length >= 4 && buffer.toString("latin1", 0, 4) === "%PDF") {
    lines.push("type: PDF document")
    const text = buffer.toString("latin1")
    const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
    lines.push(`pages (approx): ${pages}`)
    lines.push("")
    lines.push("Text is not extracted here; open the file to read it.")
    return lines
  }

  lines.push("type: unrecognised binary container")
  lines.push("No structure could be read from it without the software that wrote it.")
  return lines
}

/**
 * The hash a reviewer cites to anchor a finding to a block.
 *
 * Read_turn prints this beside the text so the reviewer never has to compute it,
 * and submit_findings recomputes it to check the citation. An anchor is
 * worthless if the tool that prints the text does not also print the value that
 * has to be quoted back.
 */
export function blockHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** How many characters of the hash read_turn prints per block. */
export const HASH_PREVIEW = 12

/**
 * Checks a cited hash against the block it claims to refer to.
 *
 * A prefix is accepted because read_turn prints only HASH_PREVIEW characters:
 * requiring the full digest would force the reviewer to recompute a hash it was
 * never shown in full. Anything shorter is refused, since a citation that short
 * does not identify text.
 */
export function matchesBlockHash(cited: string, actual: string): boolean {
  const value = cited.trim().toLowerCase().replace(/^sha-?256:/, "")
  if (!/^[0-9a-f]{12,}$/.test(value)) return false
  return actual.startsWith(value)
}

/**
 * Builds the four reviewer tools.
 *
 * `submit_findings` writes the audit into the workspace so the result outlives
 * the turn. The rubric tells the reviewer that submission is its only
 * deliverable; persisting it here is what makes that true rather than
 * aspirational.
 */
export function createReviewerTools(recorder: TurnRecorder, session: ReviewSession, workspace: string) {
  const readTurn = {
    name: "read_turn",
    description:
      "List the assistant text and tool activity of the session under review, in order, with an index for each block. " +
      "Start here: it is the only way to see what the agent under review actually did.",
    input: READ_TURN_INPUT as any,
    execute: async (input: any, context: any) => {
      try {
        const target = await resolveReviewTarget(session, context.sessionID, input?.sessionID)
        const messages = await session.context({ sessionID: target })
        // Annotate before rendering so the reviewer can see which calls it will
        // actually be able to open, rather than discovering it one failed
        // lookup at a time and reading the failure as a finding.
        const blocks = recorder.annotate(blocksFromMessages(messages), target)
        if (!blocks.length) {
          return {
            content:
              `No assistant text or tool activity is recorded for session ${target}. ` +
              "Either the turn produced none, or it ran before this plugin was loaded. " +
              "Absence of evidence is not evidence of a problem: record it as a coverage limitation, not a finding.",
          }
        }
        const rendered = blocks
          .map((block) => {
            if (block.kind === "text") {
              return (
                `[${block.index}] assistant text sha256:${blockHash(block.text ?? "").slice(0, 12)}\n` +
                `${truncate(block.text ?? "", 4000)}`
              )
            }
            return (
              `[${block.index}] tool ${block.tool ?? "(unnamed)"} ` +
              `callID=${block.callID ?? "unavailable"} status=${block.status ?? "unknown"} ` +
              `detail=${block.hasExecution ? "available" : "not recorded"}`
            )
          })
          .join("\n\n")
        const unrecorded = blocks.filter((b) => b.kind === "tool" && !b.hasExecution).length
        const footer = unrecorded
          ? [
              "",
              `${unrecorded} of ${blocks.filter((b) => b.kind === "tool").length} tool calls have no recorded detail.`,
              "The recorder keeps calls in memory for the life of the service, so calls from before a",
              "restart are not available. query_execution_log will not find them: record that as a",
              "coverage limitation, not as evidence that the action did not happen.",
            ].join("\n")
          : ""
        return { content: `session ${target}\n\n${rendered}${footer}` }
      } catch (error) {
        return { content: `Could not read the turn: ${(error as Error).message}` }
      }
    },
  }

  const queryExecutionLog = {
    name: "query_execution_log",
    description:
      "Return the recorded script, stdout, stderr, and exit status of one notebook run, or the input and output of one tool call. " +
      "Use it to check that a claimed action actually happened rather than merely being asserted.",
    input: QUERY_EXECUTION_LOG_INPUT as any,
    execute: async (input: any, context: any) => {
      const id = String(input?.id ?? "").trim()
      if (!id) return { content: "An id is required. Take it from read_turn or from the notebook_run output." }

      // A notebook run id resolves against the durable run log, which outlives
      // the process; anything else is looked up in the recorded executions.
      const runs = await readRunHistory(workspace, 200)
      const run = runs.find((r) => r.runId === id || r.runId.startsWith(id))
      if (run) {
        return {
          content: [
            `run ${run.runId}  ${run.language}  exit ${run.code}  ${run.durationMs} ms  ${run.capturedAt}`,
            `interpreter: ${run.interpreter}`,
            "",
            "--- script ---",
            run.script,
            "",
            "--- stdout ---",
            run.stdout.trim() || "(empty)",
            "",
            "--- stderr ---",
            run.stderr.trim() || "(empty)",
            "",
            `--- files written ---\n${run.changedFiles.length ? run.changedFiles.join("\n") : "(none)"}`,
          ].join("\n"),
        }
      }

      const target = await resolveReviewTarget(session, context.sessionID, input?.sessionID)
      const recorded = recorder.executions(target).find((e) => e.callID === id)
      if (!recorded) {
        // This must not assert that the action did not happen. The recorder holds
        // calls in memory for the life of the service, so a call from before a
        // restart is simply not there — and read_turn will have shown the same
        // block as `detail=not recorded`. Telling the reviewer the claim is
        // "unbacked" would invite a finding the records cannot support.
        const blocks = recorder.annotate(blocksFromMessages(await session.context({ sessionID: target })), target)
        const known = blocks.some((b) => b.callID === id)
        return {
          content: known
            ? `Call ${id} appears in the turn but its input and output are not recorded. ` +
              "The recorder keeps calls in memory for the life of the service, so this call " +
              "predates a restart or fell outside the retained window. Its detail cannot be " +
              "checked; record that as a coverage limitation rather than as a finding."
            : `No recorded execution with id ${id} in session ${target}, and no notebook run with that id. ` +
              "The id may be mistyped, or may belong to a different session. If the agent claims " +
              "it performed this action, note that the record does not cover it — do not conclude " +
              "from this alone that the action was not performed.",
        }
      }
      return {
        content: [
          `${recorded.tool}  callID=${recorded.callID}  status=${recorded.status}  agent=${recorded.agent}`,
          "",
          "--- input ---",
          JSON.stringify(recorded.input, null, 2).slice(0, 8000),
          "",
          "--- output ---",
          recorded.output || "(empty)",
        ].join("\n"),
      }
    },
  }

  const readArtifact = {
    name: "read_artifact",
    description:
      "Read a published artifact by version id, returning its stored contents and provenance record. " +
      "Reading a saved artifact is tracing, not recomputation.",
    input: READ_ARTIFACT_INPUT as any,
    execute: async (input: any) => {
      const id = String(input?.id ?? "").trim()
      if (!id) return { content: "An artifact id is required." }
      const record = await readProvenance(workspace, id)
      if ("error" in record) return { content: record.error }

      const header = [
        `artifact ${record.versionId}  (${record.filename})`,
        `checksum sha256:${record.checksum}`,
      ]
      if (record.note) header.push(`note: ${record.note}`)
      header.push("", "--- contents ---")

      try {
        // Read as a buffer and decide from the bytes what the file is. Decoding
        // a PNG or an .h5 as UTF-8 and printing the result put ~20k characters of
        // mojibake into the reviewer's context, where the only thing it could do
        // with it was spend tokens. A binary artifact is described, not inlined.
        const buffer = await readFile(record.storedPath)
        if (isBinary(buffer)) {
          const viewable = await describeBinary(buffer)
          return {
            content: [
              ...header,
              `(binary file, ${buffer.byteLength.toLocaleString("en-US")} bytes — not shown)`,
              "",
              ...viewable,
            ].join("\n"),
          }
        }
        return { content: [...header, truncate(buffer.toString("utf8"), 20_000)].join("\n") }
      } catch (error) {
        return { content: `The record exists but its contents could not be read: ${(error as Error).message}` }
      }
    },
  }

  const submitFindings = {
    name: "submit_findings",
    description:
      "Submit the review as your only deliverable. Record passes as well as problems: one consolidated entry per area verified, " +
      "not one per value traced. A warn or fail must cite where its evidence came from: either a blockIndex with the " +
      "contentHash read_turn printed beside it, or an artifactVersionId, or a notebook runId named in the evidence.",
    input: SUBMIT_FINDINGS_INPUT as any,
    execute: async (input: any, context: any) => {
      const checks = Array.isArray(input?.checks) ? input.checks : []
      const counts: Record<string, number> = { pass: 0, warn: 0, fail: 0 }
      for (const check of checks) {
        const status = String((check as any)?.status ?? "")
        if (status in counts) counts[status] += 1
      }

      // The gate is real, not a sentence in the response. It is keyed on the pair
      // (session under review, this reviewer's own session), so a resubmission
      // by the same reviewer is refused while a second, independent reviewer of
      // the same turn is allowed to file its own. Keying on the reviewed session
      // alone made a re-review after a fix impossible, which is precisely when
      // a re-review is wanted. It is checked after validation, so a malformed
      // submission is told what is actually wrong with it.
      const { mkdir, writeFile, readdir } = await import("node:fs/promises")
      const dir = join(workspace, ".opencode-science", "reviews")
      await mkdir(dir, { recursive: true })

      let target = context.sessionID
      try {
        target = await resolveReviewTarget(session, context.sessionID, undefined)
      } catch {
        // Falling back to the reviewer's own session would merge two reviewers'
        // work; the explicit id is the safer default.
      }

      const existing = (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".json"))

      // A warn or fail has to point at something that can be re-read. Three
      // sources qualify, because evidence about an artifact or a notebook run
      // often has no corresponding turn block: insisting on one made those
      // findings unrecordable, and the reviewer had to invent a citation.
      const target_ = await resolveReviewTarget(session, context.sessionID, undefined)
      const blocks = recorder.annotate(
        blocksFromMessages(await session.context({ sessionID: target_ })),
        target_,
      )

      const problems: string[] = []
      const rejected = new Set<number>()
      checks.forEach((check: any, i: number) => {
        const status = String(check?.status ?? "")
        if (status !== "warn" && status !== "fail") return

        const citesArtifact = typeof check?.artifactVersionId === "string" && check.artifactVersionId.trim()
        const citesRun = /\brun[ -]?id\b|\brun \w{8,}|\bnotebook run\b/i.test(String(check?.evidence ?? ""))
        const citesBlock = typeof check?.blockIndex === "number"

        if (!citesArtifact && !citesRun && !citesBlock) {
          problems.push(
            `check ${i + 1} (${status}) cites no source: give it an artifactVersionId, name the notebook ` +
              "run id in its evidence, or give a blockIndex from read_turn.",
          )
          rejected.add(i)
          return
        }

        if (!citesBlock) return

        const block = blocks.find((b) => b.index === check.blockIndex)
        if (!block) {
          problems.push(`check ${i + 1} cites block ${check.blockIndex}, which read_turn does not list.`)
          rejected.add(i)
          return
        }
        if (block.kind !== "text") {
          problems.push(
            `check ${i + 1} cites block ${check.blockIndex}, which is a tool call, not text. ` +
              "Cite the assistant text that made the claim, and name the callID in the evidence.",
          )
          rejected.add(i)
          return
        }
        if (!check?.contentHash || !matchesBlockHash(String(check.contentHash), blockHash(block.text ?? ""))) {
          // This is the check that was missing. A hash that is merely present was
          // accepted before, so any string — including 64 zeros — could stand as
          // the anchor for a finding, and the anchor was uncheckable by anyone
          // reading the record afterwards.
          problems.push(
            `check ${i + 1} cites block ${check.blockIndex} with a contentHash that does not match its text. ` +
              "Copy the sha256 read_turn prints beside that block.",
          )
          rejected.add(i)
        }
      })

      if (problems.length) {
        return {
          content: [
            `${problems.length} check(s) could not be recorded:`,
            ...problems.map((line) => `  - ${line}`),
            "",
            "Only these were refused. The other checks were fine but were not saved either — fix the",
            "cited ones and submit the whole review again, so the record is not split across files.",
          ].join("\n"),
        }
      }

      // The gate is checked after validation, not before. Returning "already
      // recorded" to a malformed submission told the caller the gate was the
      // problem when the real problem was a finding with no citable source, so
      // the fix it would have made was the wrong one.
      for (const name of existing) {
        try {
          const prior = JSON.parse(await readFile(join(dir, name), "utf8"))
          if (prior.reviewedSessionID === target && prior.reviewSessionID === context.sessionID) {
            return {
              content:
                `This review of session ${target} was already recorded in ${name} ` +
                `(${prior.counts.pass} pass, ${prior.counts.warn} warn, ${prior.counts.fail} fail). ` +
                "That record stands and this submission was not saved. The gate is closed for you: the " +
                "checks already recorded are the deliverable.",
            }
          }
        } catch {
          // A review file that will not parse is not grounds to block a new one.
        }
      }

      const record = {
        submittedAt: new Date().toISOString(),
        reviewSessionID: context.sessionID,
        reviewedSessionID: target,
        counts,
        checks,
      }
      const file = join(dir, `${Date.now()}-${context.sessionID.slice(0, 8)}.json`)
      await writeFile(file, JSON.stringify(record, null, 2), "utf8")

      return {
        content: [
          `Review recorded: ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail.`,
          `Saved to ${file}`,
          "",
          "The gate is now closed for you: a further submission from this review session will be refused. The checks",
          "above are the deliverable — do not add a summary of them. A different reviewer auditing the same",
          "turn may still file its own review.",
        ].join("\n"),
      }
    },
  }

  return [readTurn, queryExecutionLog, readArtifact, submitFindings]
}