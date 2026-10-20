import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"
import { createHash } from "node:crypto"
import { runProcess, resolvePython, resolveR, PYTHON_CANDIDATES, R_CANDIDATES, type Interpreter } from "./process.ts"
import { analyzeScript, reconcile, renderAnalysis } from "./notebook-analysis.ts"
import type { ToolContext } from "./types.ts"

/**
 * Notebook-style code execution against the user's own interpreter.
 *
 * Upstream runs a managed kernel with an app-owned `host.*` API. This plugin
 * instead runs each cell as a self-contained script through the interpreter the
 * user already has. That keeps setup to "Python must be on PATH" and avoids a
 * hidden kernel process, at the cost of no state carried between runs: code
 * that needs earlier definitions must include them or reload from a file.
 */

export type NotebookConfig = {
  python?: string
  rscript?: string
  /** Default timeout for a run, when the call does not set its own. */
  timeoutMs: number
  /**
   * Credential keys to forward into the interpreter's environment.
   *
   * The vendored skills read their configuration from the environment rather
   * than from plugin options, so a key configured here was invisible to them:
   * `search_openalex` and `expand_citations` in the literature-review helpers
   * raise `RuntimeError` on a keyless call and could not run at all.
   */
  credentialKeys?: readonly string[]
}

/**
 * Maps a plugin credential key to the environment variable the vendored skills
 * read. Adding a key without a name here would forward nothing useful, so the
 * mapping is explicit.
 */
const CREDENTIAL_ENV: Record<string, string> = {
  openAlexApiKey: "OPENALEX_API_KEY",
  ncbiApiKey: "NCBI_API_KEY",
  ncbiEmail: "NCBI_EMAIL",
}

/** CONTACT_EMAIL is what the literature-review helpers read for a Crossref contact. */
const CONTACT_ALIASES: Record<string, string[]> = {
  ncbiEmail: ["CONTACT_EMAIL"],
}

const RUNS_DIR = ".opencode-science/runs"

export type RunRecord = {
  runId: string
  language: "python" | "r"
  interpreter: string
  version: string
  script: string
  /** Process exit status; non-zero means the run did not complete cleanly. */
  code: number
  stdout: string
  stderr: string
  changedFiles: string[]
  capturedAt: string
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 300_000
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 1_800_000

/**
 * Keeps a caller-supplied timeout inside the range the tool schema advertises.
 *
 * The schema already bounds `timeoutMs`, but this is also the path for the
 * plugin-level default, which arrives from config and is not validated by
 * anything upstream.
 */
function clampTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.floor(value), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
}

/** Keeps a workspace-relative path inside the workspace. */
function insideWorkspace(workspace: string, candidate: string): string {
  const full = resolve(workspace, candidate)
  const root = resolve(workspace)
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`Refusing a path outside the workspace: ${candidate}`)
  }
  return full
}

async function ensureScratch(workspace: string): Promise<string> {
  const dir = join(workspace, RUNS_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

async function runOnce(
  ctx: ToolContext,
  config: NotebookConfig,
  language: "python" | "r",
  code: string,
  timeoutMs?: number,
): Promise<RunRecord> {
  const scratch = await ensureScratch(ctx.workspace)
  const runId = createHash("sha256")
    .update(`${Date.now()}:${Math.random()}:${language}`)
    .digest("hex")
    .slice(0, 16)

  const extension = language === "python" ? ".py" : ".R"
  const scriptPath = join(scratch, `run-${runId}${extension}`)
  await writeFile(scriptPath, code, "utf8")

  const resolved =
    language === "python"
      ? await resolvePython(config.python, PYTHON_CANDIDATES)
      : await resolveR(config.rscript, R_CANDIDATES)

  const { interpreter } = resolved
  const args =
    language === "python" ? [...interpreter.args, scriptPath] : [...interpreter.args, "--vanilla", scriptPath]

  const startedAt = Date.now()
  let result
  try {
    result = await runProcess({
      command: interpreter.command,
      args,
      cwd: ctx.workspace,
      timeoutMs: clampTimeout(timeoutMs ?? config.timeoutMs),
      env: {
        // Keep the interpreter output parseable and free of encoding surprises.
        PYTHONIOENCODING: "utf-8",
        PYTHONUNBUFFERED: "1",
        R_LIBS_USER: join(ctx.workspace, ".opencode-science/rlib"),
        ...forwardedCredentials(config, ctx),
      },
      signal: ctx.signal,
    })
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }

  return {
    runId,
    language,
    interpreter: `${basenameLabel(interpreter)} ${resolved.version}`.trim(),
    version: resolved.version,
    script: code,
    code: result.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    changedFiles: result.changedFiles,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  }
}

function basenameLabel(interpreter: Interpreter): string {
  return interpreter.label || interpreter.command
}

/**
 * Builds the child environment entries for configured credentials.
 *
 * Only keys with an explicit environment name are forwarded, and a key with no
 * configured value contributes nothing rather than an empty string, which the
 * vendored helpers would read as a present-but-blank credential.
 */
export function forwardedCredentials(
  config: NotebookConfig,
  ctx: ToolContext,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of config.credentialKeys ?? []) {
    const name = CREDENTIAL_ENV[key]
    if (!name) continue
    const value = ctx.credentials[key]
    if (!value?.trim()) continue
    env[name] = value.trim()
    for (const alias of CONTACT_ALIASES[key] ?? []) env[alias] = value.trim()
  }
  return env
}

/** Minimal JSON Schema for the notebook_run tool input. */
export const NOTEBOOK_RUN_INPUT = {
  type: "object",
  properties: {
    code: {
      type: "string",
      description: "Self-contained Python or R script to execute.",
    },
    language: {
      type: "string",
      enum: ["python", "r"],
      description: "Which interpreter to run the code with.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1000,
      maximum: 1_800_000,
      description: "Optional per-run timeout in milliseconds.",
    },
  },
  required: ["code", "language"],
  additionalProperties: false,
} as const

export type NotebookRunner = {
  run: (input: { code: string; language: "python" | "r"; timeoutMs?: number }, ctx: ToolContext) => Promise<string>
}

export function createNotebookRunner(config: NotebookConfig): NotebookRunner {
  return {
    async run(input, ctx) {
      // Analyze before running: the script is on disk as a file, and reading it
      // costs nothing compared to executing it.
      const analysis = await analyzeScript(input.code, input.language)

      const record = await runOnce(ctx, config, input.language, input.code, input.timeoutMs)
      const lines: string[] = [
        `run ${record.runId} (${record.language}, exit ${record.code}, ${record.durationMs} ms)`,
        `interpreter: ${record.interpreter}`,
      ]
      if (record.stdout.trim()) lines.push("", "--- stdout ---", record.stdout.trim())
      if (record.stderr.trim()) lines.push("", "--- stderr ---", record.stderr.trim())

      // Declared effects come from reading the code; changed files come from
      // watching the workspace. Reporting both, and their disagreement, is what
      // makes a claimed artifact checkable.
      const comparison = reconcile(analysis, record.changedFiles)
      lines.push("", renderAnalysis(analysis, comparison))

      // Only files the script actually declared are presented as its output.
      // A workspace-wide change list would attribute another process's writes to
      // this run, which on a home-directory workspace is most of them.
      if (comparison.declared.length) {
        lines.push("", "--- files this script writes ---", comparison.declared.join("\n"))
      }

      if (record.code !== 0) {
        lines.push("", "The run did not exit cleanly. Read stderr before reporting any result.")
      }
      // The run log is the only durable record of what was executed, so a write
      // failure is stated rather than swallowed: the result above is still
      // true, but it cannot be retrieved by run_id in a later turn.
      await persistRun(ctx.workspace, record).catch((error) => {
        lines.push(
          "",
          `WARNING: this run was not written to the run log (${(error as Error).message}).`,
          "It cannot be cited by run_id later.",
        )
      })
      return lines.join("\n")
    },
  }
}

/**
 * Reads the run log so a later turn can cite what was executed.
 *
 * Newest first, and `limit` keeps the newest. `readdir` returns entries in no
 * guaranteed order — on NTFS it is close to insertion order — so taking
 * `.slice(-limit)` before sorting selected an arbitrary window and then sorted
 * it oldest-first. With more runs on disk than the limit, the runs just made
 * were the ones missing, which is exactly what a caller checking its own work
 * looks for.
 */
export async function readRunHistory(workspace: string, limit = 20): Promise<RunRecord[]> {
  const dir = join(workspace, RUNS_DIR)
  const records: RunRecord[] = []
  try {
    const { readdir } = await import("node:fs/promises")
    const files = (await readdir(dir)).filter((f) => f.startsWith("run-") && f.endsWith(".json"))
    for (const file of files) {
      try {
        const text = await readFile(join(dir, file), "utf8")
        records.push(JSON.parse(text) as RunRecord)
      } catch {
        // A single unreadable record does not invalidate the rest of the log.
      }
    }
  } catch {
    return []
  }
  // Newest first, then truncate: the limit must select the recent end.
  records.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
  return records.slice(0, limit)
}

/** Appends a run record to the workspace log for provenance. */
export async function persistRun(workspace: string, record: RunRecord): Promise<void> {
  const dir = await ensureScratch(workspace)
  await writeFile(join(dir, `run-${record.runId}.json`), JSON.stringify(record, null, 2), "utf8")
}

export { insideWorkspace, ensureScratch, dirname }