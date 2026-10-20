import { readFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { runProcess, resolvePython, resolveR, PYTHON_CANDIDATES, R_CANDIDATES } from "./process.ts"

/**
 * Notebook static analysis.
 *
 * Attributes file effects to a script by reading the code rather than by
 * diffing the workspace afterwards.
 *
 * The reason this exists: a before/after snapshot cannot tell which files a run
 * wrote, only which files changed. On a workspace that is a home directory, an
 * unrelated process' log file looks exactly as much like an output as a file the
 * script deliberately saved. Upstream solves this with a full AST analysis over
 * a hand-maintained table of every numpy/pandas call's file semantics; here the
 * language's own parser does the work, which is exact for the shapes that
 * matter and admits when it cannot tell.
 *
 * Adapted from upstream notebook-analysis (Apache-2.0): the read/write effect
 * vocabulary and the rule that an unresolvable argument is reported as unknown
 * rather than omitted.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const PYTHON_ANALYZER = join(HERE, "notebook-analysis", "python-effects.py")
const R_ANALYZER = join(HERE, "notebook-analysis", "r-effects.R")

export type FileEffect = {
  path: string
  call: string
  line?: number
}

export type AnalysisReport = {
  language: "python" | "r"
  /** Paths the script says it writes. */
  writes: FileEffect[]
  /** Paths the script says it reads. */
  reads: FileEffect[]
  /** Calls whose path could not be resolved statically. */
  unknown: { call: string; line?: number; reason?: string }[]
  networks: { call: string; line?: number }[]
  subprocesses: { call: string; line?: number }[]
  /** eval/exec/compile and similar: behaviour not recoverable by reading. */
  dynamicCalls: { call: string; line?: number }[]
  /** True when the analyzer ran and parsed the script. */
  analyzed: boolean
  /** Why the analyzer could not run, when it could not. */
  unavailable?: string
}

function emptyReport(language: "python" | "r", unavailable: string): AnalysisReport {
  return {
    language,
    writes: [],
    reads: [],
    unknown: [],
    networks: [],
    subprocesses: [],
    dynamicCalls: [],
    analyzed: false,
    unavailable,
  }
}

/**
 * Runs the analyzer for one script.
 *
 * The analyzer is piped the source on stdin and answers with one JSON object,
 * so nothing has to be quoted or escaped between the two processes. A failure
 * here never fails the run: the script is still executed, and the caller is
 * told the analysis was unavailable rather than shown an empty result that
 * looks like "this script touches no files".
 */
export async function analyzeScript(
  code: string,
  language: "python" | "r",
): Promise<AnalysisReport> {
  if (language === "python") {
    let command: string
    let args: string[]
    try {
      const resolved = await resolvePython(undefined, PYTHON_CANDIDATES)
      command = resolved.interpreter.command
      args = [...resolved.interpreter.args, PYTHON_ANALYZER]
    } catch (error) {
      return emptyReport("python", (error as Error).message)
    }

    const result = await runProcess({
      command,
      args,
      cwd: HERE,
      // Analysis is cheap; a hang means the parser is stuck, not that the
      // script is large.
      timeoutMs: 30_000,
      input: code,
    })

    return parseAnalyzerOutput(result.stdout, "python", result.code)
  }

  let command: string
  let args: string[]
  try {
    const resolved = await resolveR(undefined, R_CANDIDATES)
    command = resolved.interpreter.command
    args = [...resolved.interpreter.args, "--vanilla", R_ANALYZER]
  } catch (error) {
    return emptyReport("r", (error as Error).message)
  }

  const result = await runProcess({
    command,
    args,
    cwd: HERE,
    timeoutMs: 30_000,
    input: code,
  })

  return parseAnalyzerOutput(result.stdout, "r", result.code)
}

/**
 * Reads the analyzer's JSON answer.
 *
 * A parse failure is reported as unavailable rather than as "no effects": the
 * difference matters, because an empty effect list would be taken as a clean
 * result and used to justify publishing an artifact.
 */
function parseAnalyzerOutput(
  stdout: string,
  language: "python" | "r",
  exitCode: number,
): AnalysisReport {
  const text = stdout.trim()
  if (!text) {
    return emptyReport(language, `analyzer produced no output (exit ${exitCode})`)
  }
  try {
    const parsed = JSON.parse(text) as any
    if (parsed.ok === false) {
      return emptyReport(language, String(parsed.error ?? "analyzer reported failure"))
    }
    return {
      language: parsed.language ?? language,
      writes: Array.isArray(parsed.writes) ? parsed.writes : [],
      reads: Array.isArray(parsed.reads) ? parsed.reads : [],
      unknown: Array.isArray(parsed.unknown) ? parsed.unknown : [],
      networks: Array.isArray(parsed.networks) ? parsed.networks : [],
      subprocesses: Array.isArray(parsed.subprocesses) ? parsed.subprocesses : [],
      dynamicCalls: Array.isArray(parsed.dynamicCalls) ? parsed.dynamicCalls : [],
      analyzed: true,
    }
  } catch (error) {
    // Show the head of what came back: an unexpected format is a bug in the
    // analyzer worth seeing, and the whole payload can be large.
    return emptyReport(language, `analyzer output was not JSON: ${text.slice(0, 120)}`)
  }
}

/**
 * Reconciles the declared effects with what actually changed on disk.
 *
 * The analyzer says what the code intends; the snapshot says what happened.
 * Both are reported, because they can legitimately disagree — a write that
 * failed raises, a change with no declared write is the interesting case.
 */
export function reconcile(
  report: AnalysisReport,
  changed: string[],
): {
  declared: string[]
  undeclared: string[]
  declaredButUnchanged: string[]
} {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "")
  const declaredSet = new Set(report.writes.map((effect) => normalize(effect.path)))
  const changedSet = new Set(changed.map(normalize))

  // The snapshot marks a directory with a trailing separator, so a change under
  // a newly created directory is not counted as undeclared by that script.
  const createdDirectories = new Set(
    [...changedSet].filter((value) => value.endsWith("/")).map((value) => value.slice(0, -1)),
  )

  const declared = [...declaredSet]
  // Hoisted out of the filter: spreading the set per changed file made this
  // quadratic in the number of changes, and on a home-directory workspace the
  // changed list is the large one.
  const declaredPaths = [...declaredSet]
  const undeclared = [...changedSet].filter(
    // A declared write to `figures` legitimately appears as `figures/x.png`, so
    // a change under a declared directory is not an undeclared one.
    (value) =>
      !declaredPaths.some((d) => value === d || value.startsWith(`${d}/`)) &&
      ![...createdDirectories].some((dir) => value.startsWith(`${dir}/`)),
  )
  // A declared path is accounted for when the snapshot shows that exact path,
  // shows the directory it lives in, or shows anything beneath it.
  //
  // The third clause is what stops a false alarm on `os.makedirs("out")`: the
  // directory often already existed, so it appears in the before-snapshot too
  // and no diff will ever flag it, yet the script plainly wrote into it.
  //
  // "Not accounted for" is weaker than "absent": a file the script rewrote with
  // identical content keeps its mtime and size, so the snapshot cannot see it.
  const changedPaths = [...changedSet]
  const satisfied = (value: string) =>
    changedSet.has(value) ||
    changedSet.has(`${value}/`) ||
    changedPaths.some((path) => path.startsWith(`${value}/`))

  const declaredButUnchanged = declared.filter((value) => !satisfied(value))

  return { declared, undeclared, declaredButUnchanged }
}

/** Compact summary for the notebook_run output. */
export function renderAnalysis(report: AnalysisReport, reconcileResult?: ReturnType<typeof reconcile>): string {
  if (!report.analyzed) {
    return `Static analysis unavailable (${report.unavailable}). File effects were not determined.`
  }

  const lines: string[] = ["--- static analysis ---"]
  if (report.writes.length) {
    lines.push(`writes: ${report.writes.map((effect) => effect.path).join(", ")}`)
  }
  if (report.reads.length) {
    lines.push(`reads: ${report.reads.map((effect) => effect.path).join(", ")}`)
  }
  if (report.networks.length) {
    lines.push(`network access: ${report.networks.map((effect) => effect.call).join(", ")}`)
  }
  if (report.subprocesses.length) {
    lines.push(`subprocess: ${report.subprocesses.map((effect) => effect.call).join(", ")}`)
  }
  if (report.dynamicCalls.length) {
    lines.push(
      `dynamic calls (behaviour not recoverable by reading): ${report.dynamicCalls.map((effect) => effect.call).join(", ")}`,
    )
  }
  if (report.unknown.length) {
    lines.push(
      `unresolved paths: ${report.unknown.map((effect) => `${effect.call} (${effect.reason ?? "computed at run time"})`).join("; ")}`,
    )
  }
  if (!report.writes.length && !report.reads.length && !report.unknown.length) {
    lines.push("no file access found")
  }

  if (reconcileResult) {
    if (reconcileResult.undeclared.length) {
      lines.push(
        `changed on disk but not declared by this script: ${reconcileResult.undeclared.join(", ")}`,
      )
    }
    if (reconcileResult.declaredButUnchanged.length) {
      lines.push(
        `declared by this script but not seen to change on disk: ${reconcileResult.declaredButUnchanged.join(", ")}`,
      )
    }
  }

  return lines.join("\n")
}