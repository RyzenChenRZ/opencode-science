/**
 * Literature library.
 *
 * A file-backed store of bibliographic records, keyed by identifier. The whole
 * point of the store is deduplication: the same paper arrives from PubMed, then
 * Crossref, then OpenAlex, and each of those spells it differently. Without a
 * key, a literature review quietly triples in size and reports three studies
 * where there was one.
 *
 * Adapted from the upstream literature-library contracts (Apache-2.0): the
 * revision-counted metadata completion protocol and the optimistic-concurrency
 * check are preserved, because they are what stops two concurrent completions
 * from silently overwriting each other.
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  IDENTITY_SCHEMES,
  normalizeIdentifiers,
  normalizeIdentifierValue,
  recordKey,
  type BibliographicRecord,
  type Creator,
  type Identifier,
} from "./identifiers.ts"

/** A record as stored: the record plus its own bookkeeping. */
export type LibraryEntry = {
  id: string
  record: BibliographicRecord
  /** Bumped on every metadata write; the completion protocol checks it. */
  metadataRevision: number
  createdAt: string
  updatedAt: string
  /** Which connectors contributed this record, for provenance. */
  sources: string[]
}

export type LibraryFile = {
  schema_version: 1
  entries: LibraryEntry[]
}

const STORE_DIR = ".opencode-science"
const STORE_FILE = "library.json"

/**
 * Every key a record can be found under.
 *
 * Two records for one work rarely carry the same identifier scheme: PubMed
 * gives a PMID, Crossref gives a DOI, and neither source knows about the
 * other's. Indexing on all identity identifiers is what lets those two collide
 * during deduplication instead of becoming two entries for one paper.
 */
export function recordKeys(record: Pick<BibliographicRecord, "identifiers">): string[] {
  const keys: string[] = []
  for (const scheme of IDENTITY_SCHEMES) {
    for (const identifier of record.identifiers) {
      if (identifier.scheme !== scheme) continue
      const value = normalizeIdentifierValue(scheme, identifier.value).toLowerCase()
      if (!value) continue
      const key = `${scheme}:${value}`
      if (!keys.includes(key)) keys.push(key)
    }
  }
  return keys
}

/** Empty record, so callers never have to supply every optional field. */
export function emptyRecord(title: string): BibliographicRecord {
  return {
    itemType: "journalArticle",
    title,
    abstract: "",
    issuedText: "",
    containerTitle: "",
    shortTitle: "",
    language: "",
    rights: "",
    url: "",
    extra: "",
    typeFields: {},
    creators: [],
    identifiers: [],
  }
}

/** Builds a person creator, tolerating the "Family, Given" form. */
export function personCreator(family: string, given: string, creatorType = "author"): Creator {
  return { nameMode: "person", familyName: family.trim(), givenName: given.trim(), creatorType }
}

/** Guesses item type from free-form publication fields. */
export function inferItemType(record: Pick<BibliographicRecord, "typeFields" | "containerTitle">) {
  const type = String(record.typeFields?.type ?? "").toLowerCase()
  if (type === "journal-article") return "journalArticle" as const
  if (type === "proceedings-article") return "conferencePaper" as const
  if (type === "book" || type === "monograph" || type === "reference-book") return "book" as const
  if (type === "book-chapter" || type === "book-section" || type === "book-part") return "bookSection" as const
  if (type === "posted-content") return "preprint" as const
  if (type === "dissertation" || type === "thesis") return "thesis" as const
  if (type === "report" || type === "report-number" || type === "standard") return "report" as const
  if (type === "dataset") return "dataset" as const
  if (type === "posted-content" && record.containerTitle) return "preprint" as const
  return "journalArticle" as const
}

/**
 * Pulls a four-digit year out of whatever the provider supplied.
 *
 * Providers disagree on date shape: "2021-07-15", "2021 Jul", "Jul 2021",
 * "2021". Scanning for the first plausible year handles all of them without
 * guessing at locale-specific formats.
 */
export function inferYear(issuedText: string): number | undefined {
  const match = /\b(1[0-9]{3}|20[0-9]{2}|21[0-9]{2})\b/.exec(issuedText)
  if (!match) return undefined
  const year = Number(match[1])
  return year >= 1000 && year <= 9999 ? year : undefined
}

/** Stable short id from a record key, for use in file names and references. */
function entryId(record: BibliographicRecord, key: string | undefined, index: number): string {
  if (key) {
    // Hash-free and reversible: the key already is a canonical identifier.
    return key.replace(/^([a-z]+):/i, "$1-").replace(/[^A-Za-z0-9.-]/g, "-").slice(0, 120)
  }
  return `unkeyed-${index + 1}-${Math.abs(hashString(record.title)).toString(36)}`
}

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return hash
}

export type Library = {
  readonly workspace: string
  readonly path: string
  load(): Promise<LibraryEntry[]>
  save(entries: LibraryEntry[]): Promise<void>
}

/**
 * Adds a record, merging into an existing entry when the key already exists.
 *
 * The merge fills only fields the stored record leaves empty. An existing
 * abstract is never overwritten by a provider that returns none, because a
 * search index truncating a summary is not grounds for losing the full one.
 */
export function mergeInto(
  stored: BibliographicRecord,
  incoming: BibliographicRecord,
): { record: BibliographicRecord; filled: string[] } {
  const filled: string[] = []
  const merged: BibliographicRecord = { ...stored }

  for (const field of [
    "abstract",
    "containerTitle",
    "shortTitle",
    "language",
    "rights",
    "url",
    "issuedText",
  ] as const) {
    if (!merged[field] && incoming[field]) {
      merged[field] = incoming[field]
      filled.push(field)
    }
  }
  if (!merged.issuedYear && incoming.issuedYear) {
    merged.issuedYear = incoming.issuedYear
    filled.push("issuedYear")
  }
  if (!merged.creators.length && incoming.creators.length) {
    merged.creators = incoming.creators
    filled.push("creators")
  }
  if (!Object.keys(merged.typeFields).length && Object.keys(incoming.typeFields).length) {
    merged.typeFields = incoming.typeFields
    filled.push("typeFields")
  }

  // Identifiers are unioned, not replaced: a PubMed hit and a Crossref hit for
  // the same work contribute different identifiers and both are worth keeping.
  merged.identifiers = normalizeIdentifiers([...stored.identifiers, ...incoming.identifiers])
  return { record: merged, filled }
}

/**
 * The store exists but is not readable as a library file.
 *
 * Separate from a missing store so a caller can say "your library is corrupt and
 * was not modified" rather than quietly continuing as though there were no
 * records, which is what a silent fallback would do.
 */
export class LibraryUnreadableError extends Error {
  readonly storePath: string
  constructor(storePath: string) {
    super(
      `The literature library at ${storePath} could not be read as a library file. ` +
        "It was left untouched: no record was added or overwritten. Move the file aside to start a new " +
        "library, or restore it from a backup.",
    )
    this.name = "LibraryUnreadableError"
    this.storePath = storePath
  }
}

/** Returns the entries, or undefined when the file exists but is not a library. */
function tryParseStore(text: string): LibraryEntry[] | undefined {
  let parsed: LibraryFile
  try {
    parsed = JSON.parse(text) as LibraryFile
  } catch {
    return undefined
  }
  if (parsed?.schema_version !== 1 || !Array.isArray(parsed.entries)) return undefined
  return parsed.entries
}

export function createLibrary(workspace: string): Library {
  const path = join(workspace, STORE_DIR, STORE_FILE)

  return {
    workspace,
    path,

    async load(): Promise<LibraryEntry[]> {
      let text: string
      try {
        text = await readFile(path, "utf8")
      } catch {
        // A missing store is an empty store, which is the correct answer for a
        // workspace that has not searched yet.
        return []
      }
      // A store that exists but will not parse is not an empty library, and
      // treating it as one is destructive: the next search would save only its
      // own records over the top. So the distinction is kept, and the caller is
      // told which of the two it is looking at.
      const parsed = tryParseStore(text)
      if (!parsed) {
        throw new LibraryUnreadableError(path)
      }
      return parsed
    },

    async save(entries: LibraryEntry[]): Promise<void> {
      await mkdir(join(workspace, STORE_DIR), { recursive: true })
      const file: LibraryFile = { schema_version: 1, entries }
      // Write beside the store and rename over it, so an interrupted write
      // leaves the previous contents intact rather than a truncated file.
      const temp = `${path}.${process.pid}.tmp`
      try {
        await writeFile(temp, JSON.stringify(file, null, 2), "utf8")
        await rename(temp, path)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
    },
  }
}

/**
 * Inserts records, merging duplicates.
 *
 * Returns what happened per record so the caller can report "3 added, 2 merged
 * into existing" rather than a bare count that hides the deduplication.
 */
export async function addRecords(
  library: Library,
  records: BibliographicRecord[],
  source: string,
): Promise<{ added: number; merged: number; entries: LibraryEntry[]; filledFields: Record<string, string[]> }> {
  const entries = await library.load()

  // Every stored entry is indexed under each identifier it carries, so a new
  // record matches on any scheme rather than only on the one it happens to lead
  // with. Without this, a PubMed hit and a Crossref hit of the same paper stay
  // separate and a review silently counts one study twice.
  const index = new Map<string, LibraryEntry>()
  for (const entry of entries) {
    for (const key of recordKeys(entry.record)) index.set(key, entry)
  }

  const filledFields: Record<string, string[]> = {}
  let added = 0
  let merged = 0
  const now = new Date().toISOString()

  for (const record of records) {
    const normalized: BibliographicRecord = { ...record, identifiers: normalizeIdentifiers(record.identifiers) }
    const keys = recordKeys(normalized)

    const existing = keys.length ? index.get(keys[0]) : undefined
    if (existing) {
      const result = mergeInto(existing.record, normalized)
      existing.record = result.record
      existing.metadataRevision += 1
      existing.updatedAt = now
      if (!existing.sources.includes(source)) existing.sources.push(source)
      if (result.filled.length) filledFields[existing.id] = result.filled
      // The merged record may now be findable under identifiers neither side
      // had alone, so the index is refreshed rather than left stale.
      for (const key of recordKeys(existing.record)) index.set(key, existing)
      merged += 1
      continue
    }

    const entry: LibraryEntry = {
      id: entryId(normalized, recordKey(normalized), entries.length + added),
      record: normalized,
      metadataRevision: 1,
      createdAt: now,
      updatedAt: now,
      sources: [source],
    }
    entries.push(entry)
    for (const key of keys) index.set(key, entry)
    added += 1
  }

  await library.save(entries)
  return { added, merged, entries, filledFields }
}

/**
 * Applies a metadata completion under optimistic concurrency.
 *
 * `expectedRevision` must match the stored revision or the write is refused.
 * Two agents completing metadata for the same item concurrently would
 * otherwise each read the same revision and the second write would discard the
 * first one's work without either of them noticing.
 */
export async function completeMetadata(
  library: Library,
  itemId: string,
  expectedRevision: number,
  update: Partial<BibliographicRecord>,
  overwriteFields: string[] = [],
): Promise<
  | {
      status: "committed"
      entry: LibraryEntry
      filled: string[]
      overwritten: string[]
      filledIdentifiers: string[]
      /** Fields the update named but that carried no usable value. */
      notSupplied: string[]
    }
  | { status: "stale"; currentRevision: number }
  | { status: "not-found" }
> {
  const entries = await library.load()
  const index = entries.findIndex((entry) => entry.id === itemId)
  if (index < 0) return { status: "not-found" }

  const entry = entries[index]
  if (entry.metadataRevision !== expectedRevision) {
    return { status: "stale", currentRevision: entry.metadataRevision }
  }

  const filled: string[] = []
  const overwritten: string[] = []
  /** Identifiers gained by this call, so the caller can report which landed. */
  const filledIdentifiers: string[] = []
  /** Fields the update named but that carried no value, so the gap is stated. */
  const notSupplied: string[] = []
  const next: BibliographicRecord = { ...entry.record }

  for (const [field, value] of Object.entries(update)) {
    if (value === undefined || value === null) continue
    // An empty string is not a value. Crossref returns "" for absent fields,
    // and counting that as a fill would tell the caller a record is complete
    // when the field is still empty.
    if (typeof value === "string" && !value.trim()) {
      notSupplied.push(field)
      continue
    }

    // Identifiers accumulate rather than replace. Attaching a DOI to a record
    // that has a PMID is not a conflict between two values for one field, it
    // is two identifiers for one work, and dropping the new one would leave a
    // later sighting of the same paper unable to resolve to this entry.
    if (field === "identifiers" && Array.isArray(value)) {
      const before = next.identifiers.length
      next.identifiers = normalizeIdentifiers([...next.identifiers, ...(value as Identifier[])])
      const gained = next.identifiers.length - before
      if (gained > 0) {
        filled.push(field)
        filledIdentifiers.push(...next.identifiers.slice(-gained).map((i) => `${i.scheme}:${i.value}`))
      }
      continue
    }

    const key = field as keyof BibliographicRecord
    const current = next[key]
    const wasEmpty =
      current === undefined ||
      current === null ||
      current === "" ||
      (Array.isArray(current) && current.length === 0)

    if (wasEmpty) {
      ;(next as any)[key] = value
      // Verified rather than assumed: a field is only reported as filled when
      // the value that landed is actually there.
      const landed = next[key]
      const landedEmpty =
        landed === undefined ||
        landed === null ||
        landed === "" ||
        (Array.isArray(landed) && landed.length === 0)
      if (landedEmpty) notSupplied.push(field)
      else filled.push(field)
      continue
    }

    // A non-empty scalar field is only replaced when the caller names it, which
    // is what makes a conflict visible rather than silently resolved.
    if (overwriteFields.includes(field)) {
      ;(next as any)[key] = value
      overwritten.push(field)
    }
  }

  entry.record = next
  entry.metadataRevision += 1
  entry.updatedAt = new Date().toISOString()
  entries[index] = entry
  await library.save(entries)

  return { status: "committed", entry, filled, overwritten, filledIdentifiers, notSupplied }
}

/** Entries whose identifiers mention any of the given identifiers. */
export function findByIdentifier(entries: LibraryEntry[], scheme: string, value: string): LibraryEntry[] {
  const target = normalizeIdentifierValue(scheme as any, value).toLowerCase()
  return entries.filter((entry) =>
    entry.record.identifiers.some(
      (identifier) =>
        identifier.scheme === scheme &&
        normalizeIdentifierValue(identifier.scheme, identifier.value).toLowerCase() === target,
    ),
  )
}

export function getById(entries: LibraryEntry[], id: string): LibraryEntry | undefined {
  return entries.find((entry) => entry.id === id)
}

/** Compact listing, so a large library does not flood the model's context. */
export function summarize(entry: LibraryEntry): Record<string, unknown> {
  const identifiers: Identifier[] = entry.record.identifiers
    .filter((identifier) => identifier.isPrimary || ["doi", "pmid"].includes(identifier.scheme))
    .slice(0, 4)
  return {
    id: entry.id,
    title: entry.record.title,
    year: entry.record.issuedYear,
    journal: entry.record.containerTitle || undefined,
    itemType: entry.record.itemType,
    identifiers,
    sources: entry.sources,
    hasAbstract: entry.record.abstract.length > 0,
    updatedAt: entry.updatedAt,
  }
}