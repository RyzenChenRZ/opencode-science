import { createHash } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"
import { render } from "./http.ts"
import type { RunRecord } from "./notebook.ts"
import type { ToolContext } from "./types.ts"

/**
 * Immutable artifact versions with traceable provenance.
 *
 * Ported from an open-source research workbench (Apache-2.0). The upstream
 * design is preserved: a published file is copied into a versioned directory,
 * checksummed, and described by a provenance record naming the code that
 * produced it, the inputs it consumed, and the environment it ran in.
 *
 * The one deliberate change is evidence handling. Upstream records why
 * evidence is unavailable and never infers it. That rule is kept exactly: a
 * field is either observed in this session or explicitly marked unavailable
 * with a reason, so a reader can tell the difference between "we did not
 * record this" and "we checked and it was absent".
 */

const ROOT = ".opencode-science"

/**
 * How much of something a provenance record can point at.
 *
 * `partial` exists because "recorded" and "not recorded" are not the only two
 * outcomes. Producer code that was supplied but abridged is neither: it is worth
 * keeping, and it is not reproduction. Collapsing that case into `available`
 * claimed a capability the record did not have.
 */
export type EvidenceState =
  | { state: "available" }
  | { state: "partial"; reason: string }
  | { state: "unavailable"; reason: string }

export type ArtifactVersion = {
  schema_version: 1
  artifactId: string
  versionId: string
  versionNumber: number
  filename: string
  storedPath: string
  sizeBytes: number
  checksum: string
  createdAt: string
  /** Session that produced the file. */
  sessionID: string
  /** Free-form note supplied by the caller. */
  note?: string
  /** Code that produced the file, when the caller supplies it. */
  producer: EvidenceState & { code?: string }
  /** Workspace files read by the producing run, with checksums. */
  inputs: EvidenceState & { files?: InputRecord[] }
  /** Interpreter and package inventory of the producing run. */
  environment: EvidenceState & { summary?: string }
  /** Tool invocation that produced the file. */
  tool: EvidenceState & { tool?: string; invocationID?: string }
  /** Notebook run that produced the file, when the caller names one. */
  runId?: string
  /** Whether that run id was found in the workspace run log. */
  runVerified?: boolean
  /** Set when the file was re-published with bytes identical to the head version. */
  unchanged?: boolean
}

export type InputRecord = {
  path: string
  sizeBytes: number
  checksum: string
}

export type ArtifactIndex = {
  schema_version: 1
  artifacts: Record<string, { filename: string; headVersion: number; versionIds: string[] }>
}

const SEPARATOR = "\u0000"

/** Short, stable id derived from the artifact name and its contents. */
function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join(SEPARATOR)).digest("hex").slice(0, 16)
}

function workspaceRoot(workspace: string): string {
  return resolve(workspace)
}

/** Rejects paths that escape the workspace before any filesystem access. */
export function resolveInsideWorkspace(workspace: string, candidate: string): string {
  const root = workspaceRoot(workspace)
  const full = resolve(root, candidate)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing a path outside the workspace: ${candidate}`)
  }
  return full
}

async function checksumFile(path: string): Promise<string> {
  const buffer = await readFile(path)
  return createHash("sha256").update(buffer).digest("hex")
}

/** Loads the artifact index, treating a missing file as an empty index. */
export async function loadIndex(workspace: string): Promise<ArtifactIndex> {
  const path = join(workspaceRoot(workspace), ROOT, "artifacts.json")
  try {
    return JSON.parse(await readFile(path, "utf8")) as ArtifactIndex
  } catch {
    return { schema_version: 1, artifacts: {} }
  }
}

async function saveIndex(workspace: string, index: ArtifactIndex): Promise<void> {
  const path = join(workspaceRoot(workspace), ROOT, "artifacts.json")
  await mkdir(join(workspaceRoot(workspace), ROOT), { recursive: true })
  await writeFile(path, JSON.stringify(index, null, 2) + "\n", "utf8")
}

export type PublishInput = {
  path: string
  note?: string
  producerCode?: string
  inputs?: string[]
  environmentSummary?: string
  /** Id of the notebook run that produced the file, so the record points at it. */
  runId?: string
}

/**
 * Grades producer code for whether it can be run as recorded.
 *
 * The check is deliberately narrow. It looks for the one thing that makes a
 * snippet unusable without having to execute it: an elision. A fragment with
 * `...` in place of the work is not a reproduction, and storing it beside
 * "producer code recorded" asserts a reproducibility that the record does not
 * have. A run id is accepted as an alternative handle, because
 * `query_execution_log` can return the real script for it.
 */
export type ProducerGrade =
  | { state: "available" }
  | { state: "partial"; reason: string }
  | { state: "unavailable"; reason: string }

export function gradeProducer(
  code: string | undefined,
  runId: string | undefined,
  runVerified = false,
): ProducerGrade {
  const text = code?.trim() ?? ""
  if (!text) {
    if (!runId) return { state: "unavailable", reason: "no producer code was supplied for this publication" }
    return runVerified
      ? { state: "unavailable", reason: "no producer code was supplied; the run id points at the full script" }
      : {
          state: "unavailable",
          reason:
            `no producer code was supplied and run id ${runId} is not in this workspace's run log, ` +
            "so the producing script cannot be retrieved; supply the complete script",
        }
  }
  // An ellipsis standing in for the omitted part of a snippet, on its own or
  // after a comment marker, is the shape of an abridged paste.
  const elided = /(^|[^.])\.\.\.(?!\.)|(^|[^.])\u2026/u.test(text)
  if (elided) {
    return {
      state: "partial",
      reason:
        "the supplied producer code is abridged (it contains an ellipsis) and cannot be run as " +
        "recorded; supply the complete script, or give the runId so the full script can be read " +
        "back with query_execution_log",
    }
  }
  return { state: "available" }
}

/**
 * Registers a new immutable version of a workspace file.
 *
 * The bytes are copied rather than referenced, so a later edit to the working
 * file cannot change what an earlier version recorded.
 */
export async function publishArtifact(workspace: string, sessionID: string, input: PublishInput) {
  const root = workspaceRoot(workspace)
  const source = resolveInsideWorkspace(workspace, input.path)
  const run = input.runId ? await findRun(root, input.runId) : undefined
  const declaredInputs = input.inputs?.length ? await describeInputs(root, input.inputs) : null

  let info
  try {
    info = await stat(source)
  } catch {
    throw new Error(`No such file in the workspace: ${input.path}`)
  }
  if (!info.isFile()) throw new Error(`Not a file: ${input.path}`)

  const checksum = await checksumFile(source)
  const filename = basename(source)
  // Identity follows the file name, so re-publishing an edited file appends a
  // version rather than starting an unrelated artifact.
  const artifactId = digest("artifact", filename)

  const index = await loadIndex(workspace)
  const existing = index.artifacts[artifactId]
  const versionNumber = (existing?.headVersion ?? 0) + 1
  const versionId = `${artifactId}-v${versionNumber}`

  const dir = join(root, ROOT, "artifacts", artifactId)
  await mkdir(dir, { recursive: true })

  // Publishing identical bytes again would add a version indistinguishable from
  // the one before it. Returning the existing version keeps the ledger a record
  // of what changed; saying so is better than silently writing a duplicate.
  if (existing?.headVersion) {
    const headId = existing.versionIds[existing.versionIds.length - 1]
    const head = await readProvenance(workspace, headId)
    if (!("error" in head) && head.checksum === checksum) {
      return { ...head, unchanged: true }
    }
  }

  const storedPath = join(dir, `${versionId}-${filename}`)
  await copyFile(source, storedPath)

  const record: ArtifactVersion = {
    schema_version: 1,
    artifactId,
    versionId,
    versionNumber,
    filename,
    storedPath: relative(root, storedPath).split(sep).join("/"),
    sizeBytes: info.size,
    checksum,
    createdAt: new Date().toISOString(),
    sessionID,
    ...(input.note ? { note: input.note } : {}),
    producer: (() => {
      const grade = gradeProducer(input.producerCode, input.runId, Boolean(run))
      return grade.state === "available"
        ? { state: "available" as const, code: input.producerCode }
        : grade
    })(),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.runId ? { runVerified: Boolean(run) } : {}),
    inputs: !declaredInputs
      ? { state: "unavailable", reason: "no input files were declared" }
      : declaredInputs.missing.length
        ? {
            state: "partial",
            reason: `${declaredInputs.missing.length} of ${input.inputs!.length} declared inputs could not be read: ${declaredInputs.missing.join(", ")}`,
            files: declaredInputs.files,
          }
        : { state: "available", files: declaredInputs.files },
    // The run log wins over a hand-written summary: it is what actually ran.
    environment: run
      ? environmentFromRun(run, input.runId)
      : input.environmentSummary
        ? { state: "available", summary: input.environmentSummary }
        : environmentFromRun(run, input.runId),
    tool: { state: "available", tool: "publish_artifact", invocationID: versionId },
  }

  await writeFile(join(dir, `${versionId}.provenance.json`), JSON.stringify(record, null, 2) + "\n", "utf8")

  index.artifacts[artifactId] = {
    filename,
    headVersion: versionNumber,
    versionIds: [...(existing?.versionIds ?? []), versionId],
  }
  await saveIndex(workspace, index)

  return record
}

/**
 * Checksums declared input files, reporting the ones that could not be read.
 *
 * They used to be dropped silently, which turned "I declared three inputs" into
 * "this record shows one input" with nothing to say which two were lost. A
 * reader could not tell a deliberate omission from a missing file, so the
 * unreadable ones are named and the state becomes `partial`.
 */
async function describeInputs(
  root: string,
  paths: string[],
): Promise<{ files: InputRecord[]; missing: string[] }> {
  const files: InputRecord[] = []
  const missing: string[] = []
  for (const candidate of paths) {
    const full = resolveInsideWorkspace(root, candidate)
    try {
      const info = await stat(full)
      if (!info.isFile()) {
        missing.push(candidate)
        continue
      }
      files.push({
        path: candidate,
        sizeBytes: info.size,
        checksum: await checksumFile(full),
      })
    } catch {
      missing.push(candidate)
    }
  }
  return { files, missing }
}

/**
 * Looks a run up in the workspace log.
 *
 * A caller-supplied runId is a claim, and a claim that no run backs is worth
 * checking: it is the one handle a reader has to retrieve the producing script,
 * so a typo silently turns the record's strongest evidence into a dead pointer.
 */
async function findRun(workspace: string, runId: string): Promise<RunRecord | undefined> {
  try {
    const path = join(workspaceRoot(workspace), ".opencode-science", "runs", `run-${runId}.json`)
    return JSON.parse(await readFile(path, "utf8")) as RunRecord
  } catch {
    return undefined
  }
}

/**
 * Derives the environment from a run log record.
 *
 * The caller could always hand-write an `environmentSummary`, and that string
 * became the record's environment field verbatim: whatever the model chose to
 * type, with nothing tying it to the run that produced the file. When the run is
 * found, its interpreter and exit status are read from the log instead, so the
 * field describes an observed run rather than a remembered one.
 */
export function environmentFromRun(run: RunRecord | undefined, runId: string | undefined): EvidenceState & {
  summary?: string
} {
  if (!run) {
    return {
      state: "unavailable",
      reason: runId
        ? `no run log entry for run id ${runId}; the environment of the producing run is not recorded`
        : "no run id was supplied and no environment summary was given, so the environment is not recorded",
    }
  }
  return {
    state: "available",
    summary: `${run.language}: ${run.interpreter} (exit ${run.code}, run ${run.runId})`,
  }
}

const UNAVAILABLE = { state: "unavailable" } as const

/** Reads a provenance record, or reports why it could not be read. */
export async function readProvenance(
  workspace: string,
  target: string,
): Promise<ArtifactVersion | { error: string }> {
  const root = workspaceRoot(workspace)
  const index = await loadIndex(workspace)

  const direct = index.artifacts[Object.keys(index.artifacts).find((id) => id === target) ?? ""]
  const byVersion = Object.entries(index.artifacts).find(([, value]) => value.versionIds.includes(target))
  const entry = direct ?? (byVersion ? { filename: byVersion[1].filename, headVersion: 0, versionIds: [target] } : undefined)

  if (!entry) {
    return { error: `No published artifact matches "${target}". Publish it first with publish_artifact.` }
  }

  const versionId = byVersion ? target : entry.versionIds[entry.versionIds.length - 1]
  const path = join(root, ROOT, "artifacts", byVersion ? Object.keys(index.artifacts).find((k) => index.artifacts[k].versionIds.includes(target))! : entry.versionIds[0].split("-v")[0], `${versionId}.provenance.json`)

  try {
    return JSON.parse(await readFile(path, "utf8")) as ArtifactVersion
  } catch (error) {
    return { error: `Provenance record for ${versionId} could not be read: ${(error as Error).message}` }
  }
}

/** Renders a provenance record as the text report the command prints. */
export function renderProvenance(record: ArtifactVersion): string {
  const lines = [
    `# Provenance: ${record.filename}`,
    "",
    `version      : v${record.versionNumber} (${record.versionId})`,
    `checksum     : sha256:${record.checksum}`,
    `size         : ${record.sizeBytes} bytes`,
    `published    : ${record.createdAt}`,
    `session      : ${record.sessionID}`,
  ]
  if (record.note) lines.push(`note         : ${record.note}`)

  lines.push("", "## How it was produced")
  if (record.producer.state === "available") {
    lines.push("The producing code was recorded with this version:")
    lines.push("", "```", (record.producer.code ?? "").trim(), "```")
  } else {
    lines.push(`unavailable: ${record.producer.reason}`)
  }

  lines.push("", "## Inputs")
  if (record.inputs.state === "available" && record.inputs.files?.length) {
    lines.push("| file | bytes | sha256 |", "| --- | --- | --- |")
    for (const file of record.inputs.files) {
      lines.push(`| ${file.path} | ${file.sizeBytes} | ${file.checksum.slice(0, 16)}…|`)
    }
  } else {
    lines.push(
      `unavailable: ${record.inputs.state === "unavailable" ? record.inputs.reason : "no input files were declared"}`,
    )
  }

  lines.push("", "## Environment")
  if (record.environment.state === "available") {
    lines.push(record.environment.summary ?? "")
  } else {
    lines.push(`unavailable: ${record.environment.reason}`)
  }

  lines.push(
    "",
    "## Limits",
    "This record documents what this session observed. It does not establish",
    "that the result is scientifically valid, and a checksum confirms file",
    "identity rather than correctness.",
  )
  return lines.join("\n")
}

/** Lists every published artifact and its version count. */
export async function listArtifacts(workspace: string): Promise<ArtifactVersion[]> {
  const root = workspaceRoot(workspace)
  const dir = join(root, ROOT, "artifacts")
  const out: ArtifactVersion[] = []
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  for (const artifactId of entries) {
    let files: string[]
    try {
      files = await readdir(join(dir, artifactId))
    } catch {
      continue
    }
    for (const file of files.filter((f) => f.endsWith(".provenance.json"))) {
      try {
        out.push(JSON.parse(await readFile(join(dir, artifactId, file), "utf8")) as ArtifactVersion)
      } catch {
        // A corrupt record is skipped; the listing stays useful.
      }
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export const PUBLISH_ARTIFACT_INPUT = {
  type: "object",
  properties: {
    path: { type: "string", description: "Workspace-relative path of the file to publish." },
    note: { type: "string", description: "Optional short description of what this file is." },
    producerCode: {
      type: "string",
      description:
        "The complete code that produced the file, so a reader can reproduce it. An abridged snippet " +
        "is recorded as partial, not as reproduction.",
    },
    runId: {
      type: "string",
      description:
        "Id of the notebook run that produced the file, as printed by notebook_run. Lets a reader " +
        "read the full script back with query_execution_log, and supplies the environment. The id is " +
        "checked against the run log: one that does not resolve is recorded as unverified.",
    },
    inputs: {
      type: "array",
      items: { type: "string" },
      description: "Workspace-relative paths of files this result depends on. All of them are checksummed.",
    },
    environmentSummary: {
      type: "string",
      description:
        "Interpreter versions and key package versions used for the run. Ignored when runId resolves to a " +
        "run in this workspace's log, because the recorded interpreter is evidence and this string is not.",
    },
  },
  required: ["path"],
  additionalProperties: false,
} as const

export { render, UNAVAILABLE }