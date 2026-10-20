import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import type { ToolContext } from "../types.ts"
import { resolvePython, PYTHON_CANDIDATES, type Interpreter } from "../process.ts"
import { createLibrary, type LibraryEntry } from "./library.ts"
import type { FullText } from "./identifiers.ts"

const HERE = dirname(fileURLToPath(import.meta.url))
// pdf.ts already lives in src/literature, so the extractor is a sibling of this
// file. Joining "literature" here again resolved to src/literature/literature.
const EXTRACTOR = join(HERE, "pdf-extract.py")
const TEXTS_DIR = ".opencode-science/fulltext"

/** Ceiling on one page of text handed back in a tool response. */
const PAGE_BUDGET = 4_000
/** Ceiling on a whole-document read. */
const DOCUMENT_BUDGET = 40_000

export type ExtractionFailure = {
  /** Distinct from the success shape, which has no `reason`. */
  ok: false
  reason: string
  attempts?: string[]
  note?: string
}

export type ExtractionSuccess = {
  ok: true
  extractor: string
  pages: number
  characters: number
  sections: { title: string; page: number }[]
  attempts: string[]
  /** Per-page text, present only when the caller asked for it. */
  pagesText?: string[]
}

/** Resolves the interpreter the same way notebook_run does. */
async function pythonFor(ctx: ToolContext): Promise<Interpreter> {
  return (await resolvePython(undefined, PYTHON_CANDIDATES)).interpreter
}

/**
 * Runs the extractor and reads its answer.
 *
 * A failure here is a result, not an exception: the caller is told which
 * libraries were tried and why each declined, because "the PDF has no text
 * layer" and "no PDF library is installed" call for different responses.
 */
export async function extractPdf(
  path: string,
  ctx: ToolContext,
  options: { pages?: boolean } = {},
): Promise<ExtractionSuccess | ExtractionFailure> {
  let command: string
  let args: string[]
  try {
    const interpreter = await pythonFor(ctx)
    command = interpreter.command
    // The flag goes after the script path: everything before it belongs to the
    // interpreter, which rejected `--pages` as an unknown option.
    args = [...interpreter.args, EXTRACTOR, ...(options.pages ? ["--pages"] : []), path]
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  }

  const { runProcess } = await import("../process.ts")
  const result = await runProcess({
    command,
    args,
    cwd: ctx.workspace,
    // Extraction is bounded by the file, not by computation: a slow run here
    // means the library is stuck rather than that the paper is long.
    timeoutMs: 120_000,
  })

  if (result.code !== 0) {
    return {
      ok: false,
      reason: `the extractor exited ${result.code}`,
      note: result.stderr.trim().slice(0, 400) || undefined,
    }
  }

  let parsed: any
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch {
    return {
      ok: false,
      reason: "the extractor did not return JSON",
      note: result.stdout.trim().slice(0, 300),
    }
  }

  if (parsed?.ok !== true) {
    return {
      ok: false,
      reason: String(parsed?.error ?? "the document could not be read"),
      attempts: Array.isArray(parsed?.attempts) ? parsed.attempts : undefined,
      note: typeof parsed?.note === "string" ? parsed.note : undefined,
    }
  }

  return {
    ok: true,
    extractor: String(parsed.extractor ?? "unknown"),
    pages: Number(parsed.pages ?? 0),
    characters: Number(parsed.characters ?? 0),
    sections: Array.isArray(parsed.sections) ? parsed.sections : [],
    attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
    pagesText: Array.isArray(parsed.pagesText) ? parsed.pagesText.map((p: unknown) => String(p)) : undefined,
  }
}

/**
 * Whether a PDF's text actually belongs to the record it is being attached to.
 *
 * Nothing used to check this: any readable PDF could be attached to any record,
 * and from then on screening reported that record's "full text" while reading a
 * different paper. That is the same class of overstatement the evidence mode
 * exists to prevent, so the text is compared against the record before it is
 * stored.
 *
 * Two signals confirm identity, either one is enough: the record's DOI appears
 * in the text, or enough of the title's distinctive words appear in the opening
 * pages. Neither is conclusive in the negative — a scanned or differently
 * typeset PDF may show neither — so a mismatch is reported with the evidence
 * and can be overridden deliberately, rather than silently accepted.
 */
const STOPWORDS = new Set([
  "about", "after", "against", "among", "analysis", "based", "between", "both", "could",
  "during", "each", "effects", "from", "have", "into", "more", "most", "novel", "other",
  "over", "review", "study", "such", "than", "that", "their", "there", "these", "they",
  "this", "those", "through", "under", "using", "were", "what", "when", "where", "which",
  "while", "with", "within", "would", "your",
])

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
}

export type IdentityCheck = {
  ok: boolean
  /** How identity was established, when it was. */
  confirmedBy?: "doi" | "title"
  /** Share of the title's distinctive words found in the opening pages. */
  titleOverlap?: number
  missingWords?: string[]
  reason?: string
}

/** Compares a PDF's opening text against the record it is being attached to. */
export function checkDocumentIdentity(
  record: { title?: string; identifiers?: readonly { scheme: string; value: string }[] },
  pages: readonly string[],
): IdentityCheck {
  const opening = pages.slice(0, 3).join("\n")
  const normalizedOpening = normalizeWords(opening).join(" ")

  // A DOI printed in the document is the strongest confirmation available.
  for (const identifier of record.identifiers ?? []) {
    if (identifier.scheme.toLowerCase() !== "doi") continue
    const doi = identifier.value.toLowerCase().trim()
    if (!doi) continue
    if (normalizedOpening.includes(doi.replace(/[^a-z0-9]+/g, " ").trim())) return { ok: true, confirmedBy: "doi" }
    // DOIs are often broken across a line, so the suffix is checked too.
    const suffix = doi.split("/").slice(1).join("/")
    if (suffix && normalizedOpening.includes(normalizeWords(suffix).join(" "))) {
      return { ok: true, confirmedBy: "doi" }
    }
  }

  const words = normalizeWords(record.title ?? "").filter((word) => word.length >= 4 && !STOPWORDS.has(word))
  if (!words.length) {
    // No usable title to compare: nothing to contradict, so do not refuse.
    return { ok: true, titleOverlap: undefined }
  }

  const openingSet = new Set(normalizeWords(opening))
  const missing = words.filter((word) => !openingSet.has(word))
  const overlap = (words.length - missing.length) / words.length
  if (overlap >= 0.5) return { ok: true, confirmedBy: "title", titleOverlap: overlap, missingWords: missing }

  return {
    ok: false,
    titleOverlap: overlap,
    missingWords: missing,
    reason:
      `This PDF does not look like the record it is being attached to. ` +
      `Only ${Math.round(overlap * 100)}% of the title's distinctive words appear in its first three pages` +
      (missing.length ? ` (missing: ${missing.slice(0, 6).join(", ")})` : "") +
      `, and the record's DOI does not appear. Attach the matching PDF, or pass allowMismatch to ` +
      `attach this one anyway.`,
  }
}

/** The stored full-text record, wrapped so callers can branch on `ok`. */
export type AttachedText =
  | { ok: true; fullText: FullText }
  | { ok: false; reason: string; attempts?: string[]; note?: string; identity?: IdentityCheck }

/**
 * Extracts and stores a document's text beside the library.
 *
 * The text goes to a file rather than into the record: a full paper is tens of
 * thousands of characters, and the screening record only ever needs to know
 * that the text exists, where it came from, and which sections it has.
 */
export async function attachFullText(
  ctx: ToolContext,
  entry: LibraryEntry,
  pdfPath: string,
  options: { allowMismatch?: boolean } = {},
): Promise<AttachedText> {
  // One extraction, asked for both structure and page text. Asking twice would
  // mean two answers to the same question, and the page a section points at
  // would be the page a different run happened to split on.
  const result = await extractPdf(pdfPath, ctx, { pages: true })
  if (!result.ok) {
    return { ok: false, reason: result.reason, attempts: result.attempts, note: result.note }
  }

  const pages = result.pagesText ?? []

  // Before anything is stored, the text is checked against the record. A PDF
  // attached to the wrong record makes every later full-text judgement about a
  // document the record does not name.
  const identity = checkDocumentIdentity(entry.record, pages)
  if (!identity.ok && !options.allowMismatch) {
    return {
      ok: false,
      reason: identity.reason ?? "This PDF does not appear to match the record.",
      identity,
      note: "Nothing was stored. Pass allowMismatch if the text really is the right document.",
    }
  }

  const dir = join(ctx.workspace, TEXTS_DIR, entry.id)
  await mkdir(join(dir, "pages"), { recursive: true })

  let characters = 0
  for (const [index, page] of pages.entries()) {
    characters += page.length
    await writeFile(join(dir, "pages", `page-${String(index + 1).padStart(4, "0")}.txt`), page, "utf8")
  }
  const textPath = join(dir, "text.txt")
  await writeFile(textPath, pages.join("\n\n"), "utf8")

  return {
    ok: true,
    fullText: {
      pages: result.pages,
      characters: characters || result.characters,
      extractor: result.extractor,
      source: pdfPath,
      retrievedAt: new Date().toISOString(),
      sections: result.sections,
      path: textPath.split(sep).join("/").replace(/^\.?\//, ""),
      identity: {
        confirmedBy: identity.confirmedBy,
        titleOverlap: identity.titleOverlap,
        overridden: !identity.ok && options.allowMismatch ? true : undefined,
      },
    },
  }
}

/**
 * Reads the stored per-page files back.
 *
 * The pages were written by attachFullText in a single extraction, so reading
 * them back returns exactly what the section offsets refer to.
 */
export async function readPageFiles(dir: string, count: number): Promise<string[]> {
  const pages: string[] = []
  for (let i = 1; i <= count; i += 1) {
    try {
      pages.push(await readFile(join(dir, `page-${String(i).padStart(4, "0")}.txt`), "utf8"))
    } catch {
      // A missing page is reported as empty rather than shifting every later
      // page down by one, which would make the section offsets wrong.
      pages.push("")
    }
  }
  return pages
}

export { PAGE_BUDGET, DOCUMENT_BUDGET, TEXTS_DIR }