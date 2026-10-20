import { spawn } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import type { RunFn, RunResult } from "./types.ts"

/**
 * Interpreter execution for the notebook tools.
 *
 * Every run is a fresh process rather than a persistent kernel: this keeps the
 * implementation honest about state (no hidden globals between runs) and avoids
 * shipping a Jupyter transport, at the cost of losing in-memory variables
 * between cells. Runs are therefore self-contained scripts.
 */

const DEFAULT_TIMEOUT_MS = 300_000
const MAX_OUTPUT_CHARS = 200_000

/** Directories never scanned when detecting files produced by a run. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "__pycache__",
  ".venv",
  "venv",
  ".Rproj.user",
  ".ipynb_checkpoints",
])

type FileState = { mtimeMs: number; size: number }

/**
 * Snapshots the workspace so a run's outputs can be attributed to it. Depth is
 * bounded so a large checkout does not make every notebook call slow.
 *
 * Directories are recorded too, marked by a trailing separator. Without them a
 * script that called `os.makedirs("out")` and then wrote nothing was reported as
 * having produced no change at all, and the reconciliation against the declared
 * effects read that as the script failing to do what it said — when the
 * directory it had just created was sitting right there.
 */
const DIRECTORY_MARK = "/"

async function snapshot(root: string, depth = 0): Promise<Map<string, FileState>> {
  const out = new Map<string, FileState>()
  if (depth > 4) return out

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const here = relative(root, full).split(sep).join("/")
      out.set(`${here}${DIRECTORY_MARK}`, { mtimeMs: 0, size: 0 })
      for (const [path, state] of await snapshot(full, depth + 1)) {
        out.set(`${here}/${path}`, state)
      }
      continue
    }
    try {
      const info = await stat(full)
      out.set(entry.name, { mtimeMs: info.mtimeMs, size: info.size })
    } catch {
      // The file disappeared between readdir and stat; treat it as unchanged.
    }
  }
  return out
}

/** Lists files created or modified by the run, relative to the workspace. */
function producedFiles(before: Map<string, FileState>, after: Map<string, FileState>): string[] {
  const changed: string[] = []
  for (const [path, state] of after) {
    const prior = before.get(path)
    if (!prior || prior.mtimeMs !== state.mtimeMs || prior.size !== state.size) {
      changed.push(path.split(sep).join("/"))
    }
  }
  return changed.sort()
}

export const runProcess: RunFn = async (request) => {
  const { command, args = [], cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env, signal, input } = request

  const before = await snapshot(cwd)

  return await new Promise<RunResult>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      signal,
      windowsHide: true,
      // A resolved interpreter must be spawned directly so a repo cannot
      // substitute a shell function or alias of the same name.
      shell: false,
    })

    // Piping input avoids quoting and escaping a whole script through argv,
    // which is what the static analyzers read their source from.
    if (input !== undefined) {
      child.stdin?.end(input, "utf8")
    }

    let stdout = ""
    let stderr = ""
    let truncated = false
    let timedOut = false

    const append = (chunk: Buffer, stream: "out" | "err") => {
      const text = chunk.toString("utf8")
      if (stream === "out") {
        if (stdout.length + text.length > MAX_OUTPUT_CHARS) {
          stdout += text.slice(0, MAX_OUTPUT_CHARS - stdout.length)
          truncated = true
        } else stdout += text
      } else if (stderr.length + text.length > MAX_OUTPUT_CHARS) {
        stderr += text.slice(0, MAX_OUTPUT_CHARS - stderr.length)
        truncated = true
      } else stderr += text
    }

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "out"))
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "err"))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)

    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({
        code: -1,
        stdout,
        stderr: `${stderr}\n${error.message}`,
        changedFiles: [],
      })
    })

    child.on("close", async (code) => {
      clearTimeout(timer)
      const after = await snapshot(cwd)
      const changedFiles = producedFiles(before, after)
      const notes: string[] = []
      if (timedOut) notes.push(`Run exceeded the ${timeoutMs} ms limit and was terminated.`)
      if (truncated) notes.push("Output was truncated at the 200k character budget.")
      resolve({
        code: code ?? -1,
        stdout,
        stderr: notes.length ? `${stderr}\n[${notes.join(" ")}]` : stderr,
        changedFiles,
      })
    })
  })
}

/** Strips a trailing script path so a configured command can be split safely. */
function splitCommandLine(commandLine: string): { command: string; args: string[] } {
  const trimmed = commandLine.trim()
  if (!trimmed) throw new Error("Empty interpreter command")
  // Quote-aware split so an interpreter path containing spaces still works.
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const char of trimmed) {
    if (quote) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) parts.push(current)
      current = ""
      continue
    }
    current += char
  }
  if (current) parts.push(current)
  if (!parts.length) throw new Error("Empty interpreter command")
  return { command: parts[0], args: parts.slice(1) }
}

async function canRun(command: string, args: string[]): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      resolve(false)
    }, 25_000)
    child.on("error", () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

export type Interpreter = { command: string; args: string[]; label: string }

/**
 * Finds an interpreter for a language, preferring the configured override and
 * falling back to the usual platform candidates. Returns a probe result so the
 * caller can report a real version rather than assuming one.
 */
export async function resolvePython(
  configured: string | undefined,
  candidates: Interpreter[],
): Promise<{ interpreter: Interpreter; version: string }> {
  const probe = ["-c", "import sys;print('.'.join(map(str,sys.version_info[:3])))"]
  if (configured) {
    const { command, args } = splitCommandLine(configured)
    const version = await tryRun(command, [...args, ...probe])
    if (!version) {
      throw new Error(
        `Configured python "${configured}" could not be executed. Check the interpreter path in the plugin options.`,
      )
    }
    return { interpreter: { command, args, label: configured }, version }
  }
  for (const candidate of candidates) {
    const version = await tryRun(candidate.command, [...candidate.args, ...probe])
    if (version) return { interpreter: candidate, version }
  }
  throw new Error(
    `No usable Python interpreter found. Tried: ${candidates.map((c) => c.command).join(", ")}. ` +
      `Set "python" in the plugin options to an absolute interpreter path.`,
  )
}

async function tryRun(command: string, args: string[]): Promise<string | undefined> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, shell: false })
    let out = ""
    let done = false
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      if (!done) {
        done = true
        resolve(undefined)
      }
    }, 25_000)
    child.stdout?.on("data", (c: Buffer) => {
      if (out.length < 400) out += c.toString("utf8")
    })
    child.on("error", () => {
      clearTimeout(timer)
      if (!done) {
        done = true
        resolve(undefined)
      }
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (!done) {
        done = true
        resolve(code === 0 ? out.trim() : undefined)
      }
    })
  })
}

/** Rscript is invoked directly; unlike Python it needs no version flag. */
export async function resolveR(
  configured: string | undefined,
  candidates: Interpreter[],
): Promise<{ interpreter: Interpreter; version: string }> {
  const probe = ["-e", "cat(R.version.string)"]
  if (configured) {
    const { command, args } = splitCommandLine(configured)
    const version = await tryRun(command, [...args, ...probe])
    if (!version) {
      throw new Error(
        `Configured Rscript "${configured}" could not be executed. Check the interpreter path in the plugin options.`,
      )
    }
    return { interpreter: { command, args, label: configured }, version }
  }
  for (const candidate of candidates) {
    const version = await tryRun(candidate.command, [...candidate.args, ...probe])
    if (version) return { interpreter: candidate, version }
  }
  throw new Error(
    `No usable Rscript found. Tried: ${candidates.map((c) => c.command).join(", ")}. ` +
      `Set "rscript" in the plugin options to an absolute path.`,
  )
}

/** Platform-appropriate interpreter candidates. */
export const PYTHON_CANDIDATES: Interpreter[] =
  process.platform === "win32"
    ? [
        { command: "python", args: [], label: "python" },
        { command: "py", args: ["-3"], label: "py -3" },
      ]
    : [
        { command: "python3", args: [], label: "python3" },
        { command: "python", args: [], label: "python" },
      ]

export const R_CANDIDATES: Interpreter[] = [
  { command: "Rscript", args: [], label: "Rscript" },
]

/** Derives a script filename that keeps the interpreter choice visible. */
export function scriptName(language: "python" | "r", label: string): string {
  const safe = basename(label).replace(/[^a-zA-Z0-9]/g, "") || "run"
  return `.opencode-science/${safe}-${language}.${language === "python" ? "py" : "R"}`
}