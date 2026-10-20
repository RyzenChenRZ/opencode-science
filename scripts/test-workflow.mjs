// Tests for the three capability modules: acquisition, citation network, export.
//
// These run against the live services where a network answer is the point, and
// against the pure functions otherwise.

import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
const failures = []

function check(name, actual, expected) {
  // Arrays and objects are compared by value, not by reference: two lists of
  // the same ids are the same answer.
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  if (same) {
    passed += 1
    return
  }
  failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function checkTrue(name, value) {
  if (value) {
    passed += 1
    return
  }
  failures.push(`${name}: expected truthy, got ${JSON.stringify(value)}`)
}

const { looksLikePdf, jatsToText, downloadDocument, unpaywallLocations, europePmcIdentifier } = await import(
  "../src/literature/acquire.ts"
)
const { toBibTeX, toRis, toCslJson, uniqueKeys, citationKey, exportCaveats } = await import(
  "../src/literature/export.ts"
)
const { emptyRecord, personCreator } = await import("../src/literature/library.ts")

// --- PDF detection ---------------------------------------------------------

checkTrue("a real PDF header is recognised", looksLikePdf(Buffer.from("%PDF-1.7\nrest")))
check("an HTML bot-block is not a PDF", looksLikePdf(Buffer.from("<!DOCTYPE html><html>")), false)
check("an empty body is not a PDF", looksLikePdf(Buffer.alloc(0)), false)
check("a truncated body is not a PDF", looksLikePdf(Buffer.from("%PD")), false)

// --- JATS to text ----------------------------------------------------------

const jats = `<?xml version="1.0"?>
<article>
  <front><article-meta><title-group><article-title>Sample</article-title></title-group>
  <abstract><p>An abstract sentence.</p></abstract></article-meta></front>
  <body>
    <sec id="s1"><title>Background</title><p>First paragraph &amp; more.</p>
      <sec id="s1a"><title>Nested</title><p>Nested paragraph.</p></sec>
    </sec>
    <sec id="s2"><title>Methods</title><p>Method text.</p></sec>
  </body>
</article>`

const text = jatsToText(jats)
checkTrue("the background section is present", text.includes("Background"))
checkTrue("the methods section is present", text.includes("Methods"))
checkTrue("the paragraph text is present", text.includes("First paragraph & more."))
checkTrue("the entity is decoded", !text.includes("&amp;"))
checkTrue("the nested subsection heading is kept", text.includes("Nested"))

// A body-less record still yields its abstract rather than nothing.
const abstractOnly = jatsToText("<article><front><abstract><p>Only an abstract.</p></abstract></front></article>")
checkTrue("an abstract is used when there is no body", abstractOnly.includes("Only an abstract."))

// --- citation keys --------------------------------------------------------

const record = emptyRecord("Short-chain fatty acids in ulcerative colitis")
record.issuedYear = 2024
record.creators = [personCreator("Smith", "Jane")]

check("the key follows the usual convention", citationKey(record, "fallback"), "smith2024short")
check("a record with no author falls back to the title", citationKey(emptyRecord("Alpha beta"), "fb"), "alpha")
check("a record with nothing at all falls back to the id", citationKey(emptyRecord(""), "Some-Id!"), "someid")

// A collision must be broken, because two papers with one key overwrite each
// other in a LaTeX build.
const colliding = uniqueKeys([
  { id: "a", record },
  { id: "b", record },
  { id: "c", record },
])
check("the first key is unchanged", colliding[0].key, "smith2024short")
check("the second is disambiguated", colliding[1].key, "smith2024shorta")
check("the third is disambiguated", colliding[2].key, "smith2024shortb")
check("the collision is reported", colliding[1].collided, true)

// --- BibTeX ----------------------------------------------------------------

const paper = emptyRecord("Inflammatory bowel disease: pathogenesis & treatment")
paper.issuedYear = 2024
paper.containerTitle = "Nature Reviews Gastroenterology"
paper.abstract = "A study of IBD."
paper.creators = [personCreator("Smith", "Jane"), personCreator("Okafor", "Chidi")]
paper.identifiers = [{ scheme: "doi", value: "10.1000/example", isPrimary: true }]
paper.itemType = "journalArticle"

const bib = toBibTeX([{ id: "doi-10.1000-example", record: paper }])
checkTrue("the entry type is an article", bib.includes("@article{"))
checkTrue("the key is used", bib.includes("{smith2024inflammatory,"))
checkTrue("the title is braced", bib.includes("title = {"))
checkTrue("the ampersand is escaped", bib.includes("\\&"))
checkTrue("the journal is written", bib.includes("journal = {Nature Reviews Gastroenterology}"))
checkTrue("the year is written", bib.includes("year = {2024}"))
checkTrue("the doi is written", bib.includes("doi = {10.1000/example}"))
checkTrue("the authors are in Family, Given form", bib.includes("author = {Smith, Jane and Okafor, Chidi}"))
checkTrue("the entry ends with a brace", bib.trim().endsWith("}"))

const thesis = emptyRecord("A thesis about colitis")
thesis.itemType = "thesis"
thesis.issuedYear = 2020
thesis.containerTitle = "University of Somewhere"
const thesisBib = toBibTeX([{ id: "t", record: thesis }])
checkTrue("a thesis is a phdthesis", thesisBib.includes("@phdthesis{"))
checkTrue("a thesis names its school", thesisBib.includes("school = {University of Somewhere}"))

const book = emptyRecord("A book about the gut")
book.itemType = "book"
book.issuedYear = 2019
book.containerTitle = "Gut Press"
const bookBib = toBibTeX([{ id: "b", record: book }])
checkTrue("a book is a book", bookBib.includes("@book{"))
checkTrue("a book names its publisher", bookBib.includes("publisher = {Gut Press}"))
checkTrue("a book does not claim a journal", !bookBib.includes("journal ="))

// --- RIS -------------------------------------------------------------------

const ris = toRis([{ id: "doi-10.1000-example", record: paper }])
checkTrue("the type is JOUR", ris.includes("TY  - JOUR"))
checkTrue("the author is Family, First", ris.includes("AU  - Smith, Jane"))
checkTrue("the title is written", ris.includes("TI  - Inflammatory bowel disease"))
checkTrue("the journal is written", ris.includes("JO  - Nature Reviews Gastroenterology"))
checkTrue("the year is written", ris.includes("PY  - 2024"))
checkTrue("the doi is written", ris.includes("DO  - 10.1000/example"))
checkTrue("the record is terminated", ris.includes("ER  -"))

const conf = emptyRecord("A conference paper")
conf.itemType = "conferencePaper"
conf.issuedYear = 2022
conf.containerTitle = "Proceedings of Something"
const confRis = toRis([{ id: "c", record: conf }])
checkTrue("a conference paper is CONF", confRis.includes("TY  - CONF"))
checkTrue("a conference paper names its proceedings", confRis.includes("T2  - Proceedings of Something"))

// --- CSL-JSON --------------------------------------------------------------

const csl = JSON.parse(toCslJson([{ id: "doi-10.1000-example", record: paper }]))
check("one entry is written", csl.length, 1)
check("the type is article-journal", csl[0].type, "article-journal")
check("the title is written", csl[0].title, paper.title)
check("the container is written", csl[0]["container-title"], "Nature Reviews Gastroenterology")
check("the doi is written", csl[0].DOI, "10.1000/example")
check("the issued date is a date-parts array", csl[0].issued["date-parts"][0][0], 2024)
check("the first author's family name is written", csl[0].author[0].family, "Smith")
check("the first author's given name is written", csl[0].author[0].given, "Jane")

const chapter = emptyRecord("A chapter")
chapter.itemType = "bookSection"
chapter.issuedYear = 2021
const chapterCsl = JSON.parse(toCslJson([{ id: "ch", record: chapter }]))
check("a chapter is a chapter in CSL", chapterCsl[0].type, "chapter")

// --- export caveats --------------------------------------------------------

const bare = emptyRecord("A record with nothing on it")
const caveats = exportCaveats([{ id: "bare", record: bare }, { id: "full", record: paper }])
check("a record with no identifier is reported", caveats.withoutIdentifier, ["bare"])
check("a record with no abstract is reported", caveats.withoutAbstract, ["bare"])
check("a record with no authors is reported", caveats.withoutAuthors, ["bare"])
check("a complete record is not reported", caveats.withoutIdentifier.length, 1)

// --- the acquisition sources say what they could not do --------------------

{
  const ctx = { workspace: "C:/tmp", sessionID: "ses-test", signal: undefined, credentials: {}, run: async () => ({ code: 0, stdout: "", stderr: "", changedFiles: [] }) }

  // Unpaywall refuses a request with no email, so it must be skipped and the
  // skip must be reported rather than passing for "no open-access copy".
  const noEmail = await unpaywallLocations("10.1000/example", ctx)
  check("Unpaywall is skipped without an email", noEmail.candidates.length, 0)
  checkTrue("the skip is explained", String(noEmail.skipped).includes("email"))

  // A record with no identifier cannot be looked up anywhere.
  const noId = await europePmcIdentifier([], ctx)
  check("no identifier means no lookup", noId, undefined)

  // Europe PMC is reachable by DOI, which is what a record collected from
  // OpenAlex actually carries.
  const byDoi = await europePmcIdentifier(
    [{ scheme: "doi", value: "10.1186/s12944-024-02203-z", isPrimary: true }],
    ctx,
  )
  checkTrue("Europe PMC is found by DOI", Boolean(byDoi?.pmcid))
  check("the source of the identifier is reported", byDoi?.source, "doi")
}

// --- download: a host that serves HTML instead of a PDF --------------------

{
  const ws = await mkdtemp(join(tmpdir(), "acquire-"))
  await mkdir(join(ws, ".opencode-science", "pdfs"), { recursive: true })

  // A real public URL that answers with an HTML page. The download must
  // refuse it rather than saving the page as the paper.
  const result = await downloadDocument(
    [{ url: "https://example.com/", source: "test", label: "an HTML page" }],
    join(ws, ".opencode-science", "pdfs", "out.pdf"),
    { workspace: ws, sessionID: "ses-test", credentials: {}, run: async () => ({ code: 0, stdout: "", stderr: "", changedFiles: [] }) },
  )
  check("an HTML page is not accepted as a PDF", result.ok, false)
  checkTrue("the attempt is reported", Array.isArray(result.attempts) && result.attempts.length === 1)
  checkTrue("the reason says it was not a PDF", String(result.attempts?.[0]?.reason).includes("rather than a PDF"))

  await rm(ws, { recursive: true, force: true })
}

// --- the export tool end to end --------------------------------------------

{
  const { LITERATURE_WORKFLOW_TOOLS } = await import("../src/literature/workflow-tools.ts")
  const { createLibrary } = await import("../src/literature/library.ts")
  const ws = await mkdtemp(join(tmpdir(), "export-tool-"))
  const library = createLibrary(ws)

  const rec = emptyRecord("Effects of butyrate on colitis in mice")
  rec.issuedYear = 2023
  rec.containerTitle = "Journal of Colitis"
  rec.creators = [personCreator("Nakamura", "Kei")]
  rec.identifiers = [{ scheme: "doi", value: "10.5555/mice", isPrimary: true }]
  rec.abstract = "Mice were given butyrate."

  await library.save([
    { id: "doi-10.5555-mice", record: rec, metadataRevision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", sources: ["pubmed"] },
  ])

  const exportTool = LITERATURE_WORKFLOW_TOOLS.find((t) => t.name === "os_literature_export")
  const ctx = { workspace: ws, sessionID: "ses-test", signal: undefined, credentials: {}, run: async () => ({ code: 0, stdout: "", stderr: "", changedFiles: [] }) }

  const bibOut = await exportTool.run({ format: "bibtex" }, ctx)
  check("one record is exported", bibOut.exported, 1)
  checkTrue("the text is returned", String(bibOut.text).includes("@article{"))
  checkTrue("the record is listed", JSON.stringify(bibOut.records).includes("10.5555/mice"))

  const written = await exportTool.run({ format: "ris", path: "refs/out.ris" }, ctx)
  check("a file is written", Boolean(written.path), true)
  const body = await readFile(join(ws, "refs", "out.ris"), "utf8")
  checkTrue("the written file holds the bibliography", body.includes("TY  - JOUR"))

  const badFormat = await exportTool.run({ format: "endnote" }, ctx)
  checkTrue("an unknown format is refused", Boolean(badFormat.error))

  // A verdict filter with no screening rule must say so rather than export
  // everything as though a filter had been applied.
  const noRule = await exportTool.run({ format: "bibtex", verdict: "match" }, ctx)
  checkTrue("a verdict filter without a rule is refused", Boolean(noRule.error))

  // A path outside the workspace is refused.
  const escape = await exportTool.run({ format: "bibtex", path: "../escape.bib" }, ctx)
  checkTrue("a path outside the workspace is refused", Boolean(escape.error))

  await rm(ws, { recursive: true, force: true })
}

// --- a large bibliography is written to a file, not returned inline ---------

{
  const { LITERATURE_WORKFLOW_TOOLS } = await import("../src/literature/workflow-tools.ts")
  const { createLibrary } = await import("../src/literature/library.ts")
  const ws = await mkdtemp(join(tmpdir(), "export-large-"))
  const library = createLibrary(ws)

  const entries = []
  for (let i = 0; i < 60; i += 1) {
    const rec = emptyRecord(`A study with a very long abstract number ${i} about colitis and the gut`)
    rec.issuedYear = 2020 + (i % 5)
    rec.containerTitle = "Journal of Colitis"
    rec.creators = [personCreator("Smith", `Jane${i}`)]
    rec.identifiers = [{ scheme: "doi", value: `10.5555/study-${i}`, isPrimary: true }]
    rec.abstract = "x".repeat(1200)
    entries.push({
      id: `doi-10.5555-study-${i}`,
      record: rec,
      metadataRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["pubmed"],
    })
  }
  await library.save(entries)

  const exportTool = LITERATURE_WORKFLOW_TOOLS.find((t) => t.name === "os_literature_export")
  const ctx = { workspace: ws, sessionID: "ses-test", signal: undefined, credentials: {}, run: async () => ({ code: 0, stdout: "", stderr: "", changedFiles: [] }) }

  const big = await exportTool.run({ format: "bibtex" }, ctx)
  check("every record is exported", big.exported, 60)
  // A bibliography this size would be cut off mid-document by the rendering
  // budget, and a cut-off JSON document cannot be parsed.
  check("the text is not returned inline", big.text, undefined)
  checkTrue("a file is written instead", Boolean(big.path))
  const written = await readFile(big.path, "utf8")
  checkTrue("the file holds the whole bibliography", written.includes("@article{"))
  check("the file holds every entry", (written.match(/@article\{/g) ?? []).length, 60)

  await rm(ws, { recursive: true, force: true })
}

// --- PubMed author names are "Family Initials" ----------------------------

{
  const { recordFromPubmed } = await import("../src/literature/tools.ts")
  const authors = recordFromPubmed({
    title: "A study",
    pubDate: "2024",
    journal: "J",
    authors: ["Firoozi D", "Mohammad-Kazem Hosseini Asl S", "Plato", "Collaborative Group"],
  })
  const byFamily = Object.fromEntries(authors.creators.map((c) => [c.familyName, c.givenName]))
  check("a simple name is split into family and initials", byFamily.Firoozi, "D")
  check("a compound family name keeps every part", byFamily["Mohammad-Kazem Hosseini Asl"], "S")
  check("a single-token name is a family name", byFamily.Plato, "")
  check("a collective name is kept whole", byFamily["Collaborative Group"], "")
}

console.log(`${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log("FAIL " + failure)
process.exit(failures.length ? 1 : 0)
