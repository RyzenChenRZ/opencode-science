/**
 * Acquisition, citation network, and export tools.
 *
 * These three close the gaps that separated the library from a real review
 * workflow: a library held abstracts but not the papers, a paper had no
 * neighbourhood, and a screened set of records had no way out as a
 * bibliography.
 *
 * They live apart from tools.ts because each is a self-contained workflow over
 * the library rather than a view of it.
 */

import { join } from "node:path"
import { mkdir, writeFile } from "node:fs/promises"
import type { ToolContext } from "../types.ts"
import { createLibrary, getById, summarize, type LibraryEntry } from "./library.ts"
import {
  downloadDocument,
  downloadEuropePmcText,
  europePmcIdentifier,
  openAlexLocations,
  unpaywallLocations,
  arxivLocation,
  PDF_DIR,
  type DocumentCandidate,
} from "./acquire.ts"
import { citationNeighbourhood } from "./citations.ts"
import { exportBibliography, exportCaveats, EXPORT_FORMATS, type ExportFormat, type Exportable } from "./export.ts"
import { attachFullText } from "./pdf.ts"
import { resolveInsideWorkspace } from "../provenance.ts"

const str = (description: string) => ({ type: "string", description })
const int = (description: string) => ({ type: "integer", description })

/**
 * The largest bibliography returned inline.
 *
 * The tool's whole output goes through a rendering budget, and a bibliography
 * of more than a few dozen records exceeds it. What comes back then is a
 * truncated JSON document, which the caller cannot parse — so beyond this
 * size the bibliography is written to a file and the path returned instead.
 */
const INLINE_LIMIT = 24_000

/** The file extension for a format. */
function extensionFor(format: ExportFormat): string {
  switch (format) {
    case "ris":
      return "ris"
    case "csl-json":
      return "json"
    default:
      return "bib"
  }
}

/**
 * A file name for a downloaded document.
 *
 * Derived from the record's own identifier, so the file is recognisable in the
 * workspace and a second download of the same paper overwrites the first
 * rather than piling up.
 */
function documentName(entry: LibraryEntry): string {
  const doi = entry.record.identifiers.find((i) => i.scheme === "doi")?.value
  const pmid = entry.record.identifiers.find((i) => i.scheme === "pmid")?.value
  const stem = (doi ?? pmid ?? entry.id).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80)
  return `${stem}.pdf`
}

export const LITERATURE_WORKFLOW_TOOLS = [
  {
    name: "os_literature_fetch_pdf",
    description:
      "Find an open-access copy of a paper in the library and download it into the workspace, then " +
      "optionally attach its text to the record. Tries Unpaywall and OpenAlex for an OA location, and " +
      "falls back to Europe PMC's full text when no PDF is served. A download is verified by its bytes, " +
      "so an HTML page served in place of a PDF is reported as a failure rather than saved as the paper. " +
      "Use this before screening on full text.",
    input: {
      type: "object",
      properties: {
        id: str("Library entry id, as returned by os_literature_list."),
        attach: {
          type: "boolean",
          description:
            "Also attach the extracted text to the record (default true). The text is checked against " +
            "the record's title and DOI first, so a document that is not this paper is refused.",
        },
        maxAttempts: int("Max locations to try (default 6)."),
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const id = String(input.id)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      const entry = getById(entries, id)
      if (!entry) return { error: `No library entry with id ${id}. Run os_literature_list to see the ids.` }

      const identifiers = entry.record.identifiers
      const maxAttempts = Math.min(Number(input.maxAttempts ?? 6), 12)

      // The candidates are gathered in order of how likely they are to be both
      // open and fetchable: a repository copy first, then a publisher copy,
      // then the arXiv preprint.
      const candidates: DocumentCandidate[] = []
      const notes: string[] = []
      const gather = async (list: DocumentCandidate[]) => {
        for (const candidate of list) {
          if (candidates.length >= maxAttempts) return
          if (!candidates.some((existing) => existing.url === candidate.url)) candidates.push(candidate)
        }
      }

      try {
        const unpaywall = await unpaywallLocations(identifiers.find((i) => i.scheme === "doi")?.value ?? "", ctx)
        await gather(unpaywall.candidates)
        if (unpaywall.skipped) notes.push(unpaywall.skipped)
      } catch (error) {
        // Unpaywall is one source among several; its failure is noted and the
        // others are still tried.
        notes.push(`Unpaywall lookup failed: ${(error as Error).message}`)
      }
      try {
        await gather(await openAlexLocations(identifiers, ctx))
      } catch (error) {
        notes.push(`OpenAlex lookup failed: ${(error as Error).message}`)
      }
      const arxiv = arxivLocation(identifiers)
      if (arxiv) await gather([arxiv])

      const destination = join(ctx.workspace, PDF_DIR, documentName(entry))
      const result = await downloadDocument(candidates, destination, ctx)

      if (!result.ok) {
        // No PDF anywhere. Europe PMC holds the full text of its open-access
        // corpus as JATS XML, which is the remaining route to a readable paper.
        // Its identifier is looked up from the record's DOI or PMID, because a
        // record collected from PubMed or OpenAlex does not carry a PMCID.
        const epmc = await europePmcIdentifier(identifiers, ctx).catch(() => undefined)
        if (epmc) {
          const textPath = join(ctx.workspace, PDF_DIR, documentName(entry).replace(/\.pdf$/, ".txt"))
          const text = await downloadEuropePmcText(epmc.pmcid, textPath, ctx)
          if (text.ok) {
            const attached = await attachText(ctx, entry, textPath, text.characters ?? 0)
            return {
              id,
              title: entry.record.title,
              ok: true,
              source: "europepmc",
              note:
                `No PDF was served by any open-access location, so the full text was taken from ` +
                `Europe PMC's ${epmc.pmcid} instead. It is the paper's text without the typeset layout.`,
              pdfAttempts: result.attempts,
              sourceNotes: notes.length ? notes : undefined,
              textPath: text.path,
              attached,
            }
          }
          return {
            id,
            title: entry.record.title,
            ok: false,
            reason: result.reason,
            attempts: result.attempts,
            sourceNotes: notes.length ? notes : undefined,
            europePmc: text.reason,
          }
        }
        return {
          id,
          title: entry.record.title,
          ok: false,
          reason: result.reason,
          attempts: result.attempts,
          sourceNotes: notes.length ? notes : undefined,
          note:
            "This paper is not openly available through the services consulted. Obtain it through your " +
            "institution's access and place the PDF in the workspace, then use os_literature_read_pdf.",
        }
      }

      const shouldAttach = input.attach !== false
      let attached: unknown
      if (shouldAttach) {
        attached = await attachText(ctx, entry, result.path ?? destination, result.bytes ?? 0)
      }

      return {
        id,
        title: entry.record.title,
        ok: true,
        source: result.source,
        label: result.label,
        url: result.url,
        path: result.path,
        bytes: result.bytes,
        note:
          "The document was verified to be a PDF by its first bytes. It is attached to the record only " +
          "if its title and DOI match the record.",
        sourceNotes: notes.length ? notes : undefined,
        attempts: result.attempts,
        attached,
      }
    },
  },

  {
    name: "os_literature_citations",
    description:
      "Get the citation neighbourhood of a paper in the library: the works it cites, and the works that " +
      "cite it. The two directions are read from different services and are never inferred from one " +
      "another. Reports the totals the source holds even when only part of the list is returned.",
    input: {
      type: "object",
      properties: {
        id: str("Library entry id, as returned by os_literature_list."),
        direction: {
          type: "string",
          enum: ["references", "citations", "both"],
          description: "Which list to fetch (default both).",
        },
        limit: int("Max records per list (default 25, max 100)."),
      },
      required: ["id"],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const id = String(input.id)
      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      const entry = getById(entries, id)
      if (!entry) return { error: `No library entry with id ${id}. Run os_literature_list to see the ids.` }

      const limit = Math.min(Number(input.limit ?? 25), 100)
      const direction = String(input.direction ?? "both")
      const neighbourhood = await citationNeighbourhood(entry.record.identifiers, limit, ctx)

      const out: Record<string, unknown> = {
        id,
        title: entry.record.title,
        subject: neighbourhood.subject,
        sources: neighbourhood.sources,
        totals: neighbourhood.totals,
      }
      if (direction === "references" || direction === "both") {
        out.references = neighbourhood.references
        const listed = neighbourhood.totals?.references
        const resolved = neighbourhood.resolvedReferences ?? listed ?? 0
        if (listed && neighbourhood.references.length < resolved) {
          out.referencesNote =
            `Showing ${neighbourhood.references.length} of ${resolved} resolved references` +
            (resolved !== listed ? ` (${listed} are listed by the source)` : "") +
            ". Raise limit to see more."
        }
      }
      if (direction === "citations" || direction === "both") {
        out.citations = neighbourhood.citations
        if (neighbourhood.totals?.citations && neighbourhood.totals.citations > neighbourhood.citations.length) {
          out.citationsNote =
            `Showing ${neighbourhood.citations.length} of ${neighbourhood.totals.citations} citing works. ` +
            "Raise limit to see more."
        }
      }
      if (neighbourhood.unavailable?.length) out.unavailable = neighbourhood.unavailable
      return out
    },
  },

  {
    name: "os_literature_export",
    description:
      "Export the library as a bibliography in BibTeX, RIS, or CSL-JSON. Records can be selected by id " +
      "or by their screening verdict, so a review can export the studies it included rather than " +
      "everything it looked at. Reports which exported records carry no identifier, since a citation " +
      "without one cannot be followed back to the paper.",
    input: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: EXPORT_FORMATS,
          description: "Bibliography format (default bibtex).",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Library entry ids to export. Omit to export the whole library.",
        },
        verdict: {
          type: "string",
          enum: ["match", "no-match", "uncertain", "all"],
          description:
            "Export only the records with this screening verdict (default all). Requires a screening " +
            "rule to have been set.",
        },
        path: str("Workspace-relative path to write the file to. Omit to return the text only."),
      },
      required: [],
      additionalProperties: false,
    } as any,
    run: async (input: Record<string, any>, ctx: ToolContext) => {
      const format = (String(input.format ?? "bibtex") as ExportFormat)
      if (!EXPORT_FORMATS.includes(format)) {
        return { error: `Unknown format: ${format}. Use one of ${EXPORT_FORMATS.join(", ")}.` }
      }

      const library = createLibrary(ctx.workspace)
      const entries = await library.load()
      if (!entries.length) return { error: "The library is empty. Search for records first." }

      let selected: LibraryEntry[] = entries

      if (Array.isArray(input.ids) && input.ids.length) {
        const wanted = new Set(input.ids.map(String))
        const missing = [...wanted].filter((id) => !entries.some((entry) => entry.id === id))
        selected = entries.filter((entry) => wanted.has(entry.id))
        if (missing.length) {
          return { error: `No library entry with id: ${missing.join(", ")}.`, exported: 0 }
        }
      }

      const verdict = String(input.verdict ?? "all")
      if (verdict !== "all") {
        const { loadScreening } = await import("./screening-store.ts")
        const state = await loadScreening(ctx.workspace)
        if (!state) {
          return {
            error:
              "No screening rule has been set, so there are no verdicts to filter by. " +
              "Use os_literature_screening_state with action 'set-rule' first, or pass verdict 'all'.",
          }
        }
        const { effectiveVerdict } = await import("./screening.ts")
        selected = selected.filter((entry) => {
          const outcome = effectiveVerdict(state, entry.id)
          return outcome.verdict === verdict
        })
        if (!selected.length) {
          return { error: `No records have the verdict '${verdict}'.`, exported: 0 }
        }
      }

      const items: Exportable[] = selected.map((entry) => ({ id: entry.id, record: entry.record }))
      const text = exportBibliography(items, format)
      const caveats = exportCaveats(items)

      const result: Record<string, unknown> = {
        format,
        exported: items.length,
        librarySize: entries.length,
        records: items.map((item) => summarize(entries.find((e) => e.id === item.id)!)),
        characters: text.length,
      }

      if (caveats.withoutIdentifier.length) {
        result.withoutIdentifier = caveats.withoutIdentifier
        result.note =
          `${caveats.withoutIdentifier.length} exported record(s) carry no identifier, so a citation to ` +
          "them cannot be resolved to a paper. They are included because they were asked for."
      }
      if (caveats.withoutAbstract.length) {
        result.withoutAbstract = caveats.withoutAbstract
      }
      if (caveats.withoutAuthors.length) {
        result.withoutAuthors = caveats.withoutAuthors
      }

      if (input.path) {
        // A path outside the workspace is refused, and reported rather than
        // thrown: a tool that crashes takes the turn with it, while a tool
        // that explains itself lets the caller correct the path.
        let target: string
        try {
          target = resolveInsideWorkspace(ctx.workspace, String(input.path))
        } catch (error) {
          return { error: (error as Error).message, exported: 0 }
        }
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, text, "utf8")
        result.path = target
        result.note = `${result.note ? `${result.note} ` : ""}Written to ${target}.`
      } else if (text.length > INLINE_LIMIT) {
        // A bibliography of any size is a file, not something to push through
        // the context. Returning it inline would push the tool's own output
        // past the budget, and a truncated JSON document cannot be parsed by
        // the caller that asked for it.
        const target = join(ctx.workspace, ".opencode-science", "exports", `library.${extensionFor(format)}`)
        await mkdir(join(target, ".."), { recursive: true })
        await writeFile(target, text, "utf8")
        result.path = target
        result.note =
          `${result.note ? `${result.note} ` : ""}The bibliography is ${text.length} characters, which is too ` +
          `long to return inline, so it was written to ${target}. Pass a 'path' to choose where it goes.`
      } else {
        result.text = text
      }

      return result
    },
  },
]

/**
 * Attaches a downloaded document's text to a record.
 *
 * The identity check inside attachFullText decides whether the document is
 * this record's paper, and a document that fails the check is not attached.
 */
async function attachText(
  ctx: ToolContext,
  entry: LibraryEntry,
  path: string,
  characters: number,
): Promise<unknown> {
  if (path.endsWith(".txt")) {
    // Europe PMC's text needs no PDF extraction; it is already text. It is
    // recorded with the same provenance fields a PDF would carry, so the
    // screening tools treat it the same way.
    const { mkdir: ensureDir, writeFile: write } = await import("node:fs/promises")
    const dir = join(ctx.workspace, ".opencode-science", "texts", entry.id, "pages")
    await ensureDir(dir, { recursive: true })
    const { readFile } = await import("node:fs/promises")
    const body = await readFile(path, "utf8")
    await write(join(dir, "page-0001.txt"), body, "utf8")
    const textPath = join(ctx.workspace, ".opencode-science", "texts", entry.id, "text.txt")
    await write(textPath, body, "utf8")

    const library = createLibrary(ctx.workspace)
    const entries = await library.load()
    const stored = getById(entries, entry.id)
    if (stored) {
      stored.record.fullText = {
        pages: 1,
        characters: body.length,
        extractor: "europepmc-jats",
        source: path,
        retrievedAt: new Date().toISOString(),
        sections: [],
        path: textPath.split(/[\\/]/).join("/").replace(/^\.?\//, ""),
        identity: { confirmedBy: "doi" },
      }
      stored.updatedAt = new Date().toISOString()
      await library.save(entries)
    }
    return {
      attached: true,
      characters: body.length,
      extractor: "europepmc-jats",
      note: "The text came from Europe PMC's JATS XML rather than a PDF, so it has no page numbers.",
    }
  }

  const attached = await attachFullText(ctx, entry, path)
  if (!attached.ok) {
    return {
      attached: false,
      reason: attached.reason,
      note: attached.note,
      identity: attached.identity,
    }
  }
  return {
    attached: true,
    extractor: attached.fullText.extractor,
    pages: attached.fullText.pages,
    characters: attached.fullText.characters,
    identity: attached.fullText.identity,
  }
}
