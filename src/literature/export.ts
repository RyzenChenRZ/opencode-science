/**
 * Bibliography export.
 *
 * A screened collection is a list of records, and a list of records is not
 * yet a bibliography: it has to become a file the user's reference manager or
 * typesetter can read. Three formats cover almost every destination:
 *
 *   - BibTeX, for LaTeX and for tools that read it.
 *   - RIS, for EndNote, Zotero, and Mendeley.
 *   - CSL-JSON, the interchange format behind most citation styles.
 *
 * Two things make an exported bibliography trustworthy:
 *
 *   - A record that has no identifier in it is a citation that will not
 *     resolve. It is marked rather than quietly written out, because a
 *     bibliography that looks complete but cannot be followed back to the
 *     papers is the failure mode worth avoiding.
 *   - A citation key that collides is disambiguated explicitly. Two papers
 *     sharing a key silently overwrite each other in a LaTeX build, and the
 *     resulting bibliography silently cites the wrong paper.
 */

import type { BibliographicRecord, Creator, Identifier } from "./identifiers.ts"

/** One record as it will be written out. */
export type Exportable = {
  id: string
  record: BibliographicRecord
}

/** The formats that can be written. */
export type ExportFormat = "bibtex" | "ris" | "csl-json"

export const EXPORT_FORMATS: ExportFormat[] = ["bibtex", "ris", "csl-json"]

/**
 * A citation key for a record.
 *
 * The convention is the familiar one: the first author's family name, the
 * year, and the first significant word of the title. A record with no author
 * falls back to its title, and one with neither falls back to its id, so a key
 * is always produced.
 */
export function citationKey(record: BibliographicRecord, fallback: string): string {
  const person = record.creators.find((creator) => creator.nameMode === "person") as
    | Extract<Creator, { nameMode: "person" }>
    | undefined
  const family = person?.familyName?.trim()
  const year = record.issuedYear ? String(record.issuedYear) : ""
  const word = significantWord(record.title)

  // The familiar form is author, year, word. A record with no author has no
  // first element, so the word stands alone; a record with no year has no
  // second element, so nothing is invented to fill the gap. A "n.d." in every
  // key would make them longer without saying anything.
  const base = [family ?? word, year, family ? word : ""]
    .filter(Boolean)
    .join("")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
  return base || fallback.replace(/[^A-Za-z0-9]/g, "").toLowerCase() || "untitled"
}

/** The first word of a title that carries meaning. */
function significantWord(title: string): string {
  const stop = new Set(["a", "an", "the", "of", "on", "in", "for", "and", "to", "with", "from", "by"])
  for (const word of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !stop.has(word)) return word
  }
  return title.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? ""
}

/**
 * A key that no earlier record in the export has taken.
 *
 * The suffix is a letter, which is what BibTeX users expect, and the reason
 * is recorded so a caller can see that a collision happened rather than
 * discovering it as a wrong citation later.
 */
export function uniqueKeys(items: Exportable[]): { key: string; id: string; collided: boolean }[] {
  const used = new Set<string>()
  const counters = new Map<string, number>()

  return items.map((item) => {
    const base = citationKey(item.record, item.id)
    if (!used.has(base)) {
      used.add(base)
      counters.set(base, 0)
      return { key: base, id: item.id, collided: false }
    }
    // The suffix is a letter, which is what BibTeX users expect: a, b, c, ...
    // and then aa, ab, once the alphabet runs out.
    let n = counters.get(base) ?? 0
    let suffix = ""
    do {
      suffix = String.fromCharCode(97 + (n % 26))
      if (n >= 26) suffix = String.fromCharCode(97 + Math.floor(n / 26) - 1) + suffix
      n += 1
    } while (used.has(base + suffix))
    counters.set(base, n)
    used.add(base + suffix)
    return { key: base + suffix, id: item.id, collided: true }
  })
}

/** The DOI of a record, if it has one. */
function doiOf(record: BibliographicRecord): string | undefined {
  const doi = record.identifiers.find((identifier) => identifier.scheme === "doi")
  return doi?.value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
}

/** Every identifier of a record, in a stable order. */
function identifiersOf(record: BibliographicRecord): Identifier[] {
  return [...record.identifiers].sort((a, b) => a.scheme.localeCompare(b.scheme))
}

/**
 * Braces a BibTeX field value.
 *
 * LaTeX treats a handful of characters as significant, and a title containing
 * one of them changes the meaning of the entry rather than printing it. The
 * value is wrapped so that it prints literally, and the characters LaTeX would
 * act on are escaped.
 */
function bibtexValue(value: string): string {
  return `{${value.replace(/([&%$#_])/g, "\\$1")}}`
}

/** The BibTeX entry type for a record's item type. */
function bibtexType(record: BibliographicRecord): string {
  switch (record.itemType) {
    case "book":
      return "book"
    case "bookSection":
      return "incollection"
    case "conferencePaper":
      return "inproceedings"
    case "thesis":
      return "phdthesis"
    case "report":
    case "standard":
      return "techreport"
    case "preprint":
      return "misc"
    case "dataset":
      return "misc"
    case "review":
      return "article"
    case "webpage":
      return "misc"
    default:
      return "article"
  }
}

/** The author list in BibTeX's `Family, Given and Family, Given` form. */
function bibtexAuthors(record: BibliographicRecord): string {
  const names = record.creators
    .filter((creator) => creator.creatorType === "author" || creator.creatorType === "editor")
    .map((creator) => {
      if (creator.nameMode === "organization") return creator.literalName
      const given = creator.givenName?.trim()
      const family = creator.familyName?.trim()
      if (!family) return given
      return given ? `${family}, ${given}` : family
    })
    .filter(Boolean)
  return names.join(" and ")
}

/** Writes the library as a BibTeX file. */
export function toBibTeX(items: Exportable[]): string {
  const keys = uniqueKeys(items)
  const chunks: string[] = []

  items.forEach((item, index) => {
    const record = item.record
    const fields: string[] = []
    const add = (name: string, value: string | undefined) => {
      if (value && value.trim()) fields.push(`  ${name} = ${bibtexValue(value.trim())},`)
    }

    add("title", record.title)
    const authors = bibtexAuthors(record)
    if (authors) fields.push(`  author = {${authors.replace(/([&%$#_])/g, "\\$1")}},`)

    // The container is a different field per entry type: a journal, a book
    // publisher, or the proceedings a paper was presented in.
    if (record.itemType === "book" || record.itemType === "bookSection") {
      add("publisher", record.containerTitle)
    } else if (record.itemType === "conferencePaper") {
      add("booktitle", record.containerTitle)
    } else if (record.itemType === "thesis") {
      add("school", record.containerTitle)
    } else if (record.itemType === "report" || record.itemType === "standard") {
      add("institution", record.containerTitle)
    } else {
      add("journal", record.containerTitle)
    }

    if (record.issuedYear) {
      fields.push(`  year = {${record.issuedYear}},`)
    } else if (record.issuedText) {
      add("year", record.issuedText)
    }
    add("doi", doiOf(record))
    add("url", record.url)
    add("abstract", record.abstract)
    if (record.language) add("language", record.language)
    if (record.rights) add("rights", record.rights)
    add("note", record.extra)

    // The other identifiers are worth keeping: a PMID lets a reader find the
    // record without the DOI.
    for (const identifier of identifiersOf(record)) {
      if (identifier.scheme === "doi") continue
      add(identifier.scheme, identifier.value)
    }

    chunks.push(
      `@${bibtexType(record)}{${keys[index].key},\n${fields.join("\n")}\n}`,
    )
  })

  return chunks.join("\n\n") + "\n"
}

/** Writes the library as an RIS file. */
export function toRis(items: Exportable[]): string {
  const chunks: string[] = []

  for (const item of items) {
    const record = item.record
    const lines: string[] = []

    // RIS type codes: JOUR, BOOK, CHAP, CONF, THES, RPRT, GEN.
    const type =
      record.itemType === "book"
        ? "BOOK"
        : record.itemType === "bookSection"
          ? "CHAP"
          : record.itemType === "conferencePaper"
            ? "CONF"
            : record.itemType === "thesis"
              ? "THES"
              : record.itemType === "report" || record.itemType === "standard"
                ? "RPRT"
                : record.itemType === "webpage"
                  ? "ELEC"
                  : record.itemType === "dataset"
                    ? "DATA"
                    : "JOUR"
    lines.push(`TY  - ${type}`)

    for (const creator of record.creators) {
      if (creator.nameMode === "organization") {
        lines.push(`A2  - ${creator.literalName}`)
        continue
      }
      const given = creator.givenName?.trim()
      const family = creator.familyName?.trim()
      if (!family && !given) continue
      // RIS wants "Last, First"; a record that only has a name keeps it.
      lines.push(`AU  - ${given && family ? `${family}, ${given}` : family || given}`)
    }

    lines.push(`TI  - ${record.title}`)
    if (record.containerTitle) {
      lines.push(record.itemType === "conferencePaper" ? `T2  - ${record.containerTitle}` : `JO  - ${record.containerTitle}`)
    }
    if (record.issuedYear) lines.push(`PY  - ${record.issuedYear}`)
    else if (record.issuedText) lines.push(`PY  - ${record.issuedText}`)

    const doi = doiOf(record)
    if (doi) lines.push(`DO  - ${doi}`)
    if (record.url) lines.push(`UR  - ${record.url}`)
    if (record.abstract) lines.push(`AB  - ${record.abstract.replace(/\n+/g, " ")}`)
    if (record.language) lines.push(`LA  - ${record.language}`)
    if (record.rights) lines.push(`C1  - ${record.rights}`)
    for (const identifier of identifiersOf(record)) {
      if (identifier.scheme === "doi") continue
      // The general-purpose field carries a "tag:value" pair, which is how RIS
      // represents identifiers it has no dedicated field for.
      lines.push(`AN  - ${identifier.scheme}:${identifier.value}`)
    }
    lines.push("ER  - ")

    chunks.push(lines.join("\n"))
  }

  return chunks.join("\n\n") + "\n"
}

/** The CSL type for a record's item type. */
function cslType(record: BibliographicRecord): string {
  switch (record.itemType) {
    case "book":
      return "book"
    case "bookSection":
      return "chapter"
    case "conferencePaper":
      return "paper-conference"
    case "thesis":
      return "thesis"
    case "report":
      return "report"
    case "standard":
      return "standard"
    case "preprint":
      return "article"
    case "dataset":
      return "dataset"
    case "webpage":
      return "webpage"
    case "patent":
      return "patent"
    case "review":
      return "article-journal"
    default:
      return "article-journal"
  }
}

/** Writes the library as CSL-JSON. */
export function toCslJson(items: Exportable[]): string {
  const data = items.map((item) => {
    const record = item.record
    const entry: Record<string, unknown> = {
      id: item.id,
      type: cslType(record),
      title: record.title,
    }

    const authors = record.creators
      .filter((creator) => creator.creatorType === "author")
      .map((creator) =>
        creator.nameMode === "organization"
          ? { literal: creator.literalName }
          : { family: creator.familyName, given: creator.givenName },
      )
    if (authors.length) entry.author = authors

    const editors = record.creators
      .filter((creator) => creator.creatorType === "editor")
      .map((creator) =>
        creator.nameMode === "organization"
          ? { literal: creator.literalName }
          : { family: creator.familyName, given: creator.givenName },
      )
    if (editors.length) entry.editor = editors

    if (record.containerTitle) {
      entry["container-title"] = record.containerTitle
      if (record.itemType === "journalArticle" || record.itemType === "review") {
        entry["collection-title"] = record.containerTitle
      }
    }
    if (record.issuedYear) {
      // CSL wants a date-parts array; a year alone is [[year]].
      const parts: number[] = [record.issuedYear]
      const month = /^\d{4}-(\d{1,2})/.exec(record.issuedText)?.[1]
      if (month) parts.push(Number(month))
      entry.issued = { "date-parts": [parts] }
    } else if (record.issuedText) {
      entry.issued = { raw: record.issuedText }
    }
    const doi = doiOf(record)
    if (doi) entry.DOI = doi
    if (record.url) entry.URL = record.url
    if (record.abstract) entry.abstract = record.abstract
    if (record.language) entry.language = record.language
    if (record.rights) entry.rights = record.rights
    if (record.shortTitle) entry["title-short"] = record.shortTitle
    if (record.citationKey) entry["citation-key"] = record.citationKey
    return entry
  })

  return JSON.stringify(data, null, 2) + "\n"
}

/** Writes the library in the requested format. */
export function exportBibliography(items: Exportable[], format: ExportFormat): string {
  switch (format) {
    case "bibtex":
      return toBibTeX(items)
    case "ris":
      return toRis(items)
    case "csl-json":
      return toCslJson(items)
    default:
      throw new Error(`Unknown export format: ${format}`)
  }
}

/**
 * What the export cannot vouch for.
 *
 * A record with no DOI and no other identifier is a reference that cannot be
 * followed back to the paper, and a record whose abstract is missing is a
 * record whose content was never checked. Both are reported so the exported
 * bibliography is read with its limits known.
 */
export function exportCaveats(items: Exportable[]): {
  withoutIdentifier: string[]
  withoutAbstract: string[]
  withoutAuthors: string[]
} {
  const withoutIdentifier: string[] = []
  const withoutAbstract: string[] = []
  const withoutAuthors: string[] = []

  for (const item of items) {
    const record = item.record
    if (!record.identifiers.length) withoutIdentifier.push(item.id)
    if (!record.abstract.trim()) withoutAbstract.push(item.id)
    if (!record.creators.length) withoutAuthors.push(item.id)
  }
  return { withoutIdentifier, withoutAbstract, withoutAuthors }
}
