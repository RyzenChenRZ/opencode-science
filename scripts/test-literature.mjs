/**
 * Tests for the literature library and screening layers.
 *
 * Run with: node --experimental-strip-types scripts/test-literature.mjs
 */

import {
  addRecords,
  completeMetadata,
  createLibrary,
  emptyRecord,
  findByIdentifier,
  getById,
  inferItemType,
  inferYear,
  mergeInto,
  personCreator,
} from "../src/literature/library.ts"
import {
  checkEvidenceMode,
  checkRule,
  createScreeningState,
  deriveEvidenceMode,
  formatRule,
  parseRule,
  readRule,
  rulePrompt,
  RULE_MAX_LENGTH,
} from "../src/literature/screening.ts"
import { evaluateCriterion, parseCriteria, screenRecord } from "../src/literature/prescreen.ts"
import { recordKey } from "../src/literature/identifiers.ts"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
const failures = []
function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed += 1
  else failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

const workspace = await mkdtemp(join(tmpdir(), "lit-test-"))
const library = createLibrary(workspace)

// --- record helpers ------------------------------------------------------

check("a year is read from an ISO date", inferYear("2021-07-15"), 2021)
check("a year is read from a month-year", inferYear("Jul 2021"), 2021)
check("a year is read from a year-only value", inferYear("2021"), 2021)
check("a missing year is undefined", inferYear("n.d."), undefined)
check("a plausible-looking year outside the range is rejected", inferYear("1200"), 1200)

check("journal-article maps to journalArticle", inferItemType({ typeFields: { type: "journal-article" }, containerTitle: "" }), "journalArticle")
check("proceedings-article maps to conferencePaper", inferItemType({ typeFields: { type: "proceedings-article" }, containerTitle: "" }), "conferencePaper")
check("book-chapter maps to bookSection", inferItemType({ typeFields: { type: "book-chapter" }, containerTitle: "" }), "bookSection")
check("an unknown type defaults to journalArticle", inferItemType({ typeFields: {}, containerTitle: "" }), "journalArticle")

// --- merging -------------------------------------------------------------

{
  const stored = { ...emptyRecord("A"), abstract: "the full abstract" }
  const incoming = { ...emptyRecord("A"), abstract: "", containerTitle: "Nature", issuedYear: 2021 }
  const result = mergeInto(stored, incoming)
  check("an existing abstract is not overwritten by an empty one", result.record.abstract, "the full abstract")
  check("a missing journal is filled", result.record.containerTitle, "Nature")
  check("the filled fields are reported", result.filled.sort(), ["containerTitle", "issuedYear"])
}

{
  const stored = emptyRecord("A")
  const incoming = {
    ...emptyRecord("A"),
    identifiers: [{ scheme: "doi", value: "10.1/x", isPrimary: true }],
    creators: [personCreator("Smith", "Jane")],
  }
  const result = mergeInto(stored, incoming)
  check("creators are filled when absent", result.record.creators.length, 1)
  check("identifiers are unioned", result.record.identifiers.length, 1)
}

{
  const stored = emptyRecord("A")
  stored.identifiers = [{ scheme: "doi", value: "10.1038/nature12373", isPrimary: true }]
  const incoming = emptyRecord("A")
  incoming.identifiers = [{ scheme: "pmid", value: "33283989", isPrimary: true }]
  const result = mergeInto(stored, incoming)
  check("a second identifier scheme is added, not replaced", result.record.identifiers.length, 2)
  check("both schemes survive", result.record.identifiers.map((i) => i.scheme).sort(), ["doi", "pmid"])
}

// --- store: add, dedupe, load --------------------------------------------

{
  const first = await addRecords(
    library,
    [{ ...emptyRecord("Sickle cell disease"), issuedYear: 2021,
       identifiers: [{ scheme: "pmid", value: "33283989", isPrimary: true }] }],
    "pubmed",
  )
  check("the first record is added", first.added, 1)
  check("nothing merged yet", first.merged, 0)

  // The same DOI under three different spellings is one identifier, so it
  // merges without any lookup.
  const sameDoi = await addRecords(
    library,
    [{ ...emptyRecord("Another paper"), abstract: "Full abstract.",
       identifiers: [{ scheme: "doi", value: "https://doi.org/10.1038/nature12373.", isPrimary: true }] }],
    "crossref",
  )
  check("a DOI that differs only in spelling is a new work here", sameDoi.added, 1)

  const entries = await library.load()
  check("the store holds two entries", entries.length, 2)

  // Re-adding the same DOI in another spelling must merge.
  const again = await addRecords(
    library,
    [{ ...emptyRecord("Another paper"), identifiers: [{ scheme: "doi", value: "doi: 10.1038/NATURE12373", isPrimary: true }] }],
    "openalex",
  )
  check("a differently spelled DOI merges", again.merged, 1)
  check("no entry is added for it", again.added, 0)
  check("the store still holds two entries", (await library.load()).length, 2)

  const doiEntry = (await library.load()).find((e) => e.record.identifiers.some((i) => i.scheme === "doi"))
  check("the second source is recorded on the merged entry", doiEntry.sources.sort(), ["crossref", "openalex"])
}

{
  // Cross-source deduplication is a two-step operation. A PubMed hit and a
  // Crossref hit of one paper carry disjoint identifiers, so the only way to
  // learn they are the same work is to supply one identifier to the other.
  const entries = await library.load()
  const pmidEntry = entries.find((e) => e.record.identifiers.some((i) => i.scheme === "pmid"))
  check("the PMID-only record is stored", pmidEntry.record.title, "Sickle cell disease")

  const linked = await completeMetadata(
    library,
    pmidEntry.id,
    pmidEntry.metadataRevision,
    { identifiers: [...pmidEntry.record.identifiers, { scheme: "doi", value: "10.1016/S0140-6736(21)00000-0", isPrimary: true }] },
  )
  check("the second identifier is recorded", linked.status, "committed")

  const nowDoi = recordKey(pmidEntry.record.identifiers.find((i) => i.scheme === "pmid") ? pmidEntry.record : library)
  check("the record now carries both schemes",
    getById(await library.load(), pmidEntry.id).record.identifiers.map((i) => i.scheme).sort(),
    ["doi", "pmid"])

  // Once both identifiers are on one record, another source supplying either
  // one resolves to that same entry.
  const viaDoi = await addRecords(
    library,
    [{ ...emptyRecord("Same work, third sighting"), identifiers: [{ scheme: "doi", value: "https://doi.org/10.1016/S0140-6736(21)00000-0", isPrimary: true }] }],
    "europe-pmc",
  )
  check("a later sighting merges into the linked entry", viaDoi.merged, 1)
  check("the store did not grow", (await library.load()).length, 2)

  const found = findByIdentifier(await library.load(), "doi", "10.1016/S0140-6736(21)00000-0")
  check("the merged record is findable by the new DOI", found.length, 1)
  check("and by the original PMID", findByIdentifier(await library.load(), "pmid", "33283989").length, 1)
}

// --- optimistic concurrency ----------------------------------------------

{
  const entries = await library.load()
  const entry = entries[0]

  const stale = await completeMetadata(library, entry.id, entry.metadataRevision - 1, { abstract: "x" })
  check("a stale revision is refused", stale.status, "stale")

  const ok = await completeMetadata(
    library,
    entry.id,
    entry.metadataRevision,
    { containerTitle: "The Lancet", language: "en" },
  )
  check("the matching revision commits", ok.status, "committed")

  const after = getById(await library.load(), entry.id)
  check("the committed field is present", after.record.containerTitle, "The Lancet")
  check("the revision advanced", after.metadataRevision, entry.metadataRevision + 1)

  const overwrite = await completeMetadata(
    library,
    entry.id,
    after.metadataRevision,
    { containerTitle: "Nature" },
    ["containerTitle"],
  )
  check("a named overwrite is applied", overwrite.status === "committed" && getById(await library.load(), entry.id).record.containerTitle, "Nature")

  const ignored = await completeMetadata(library, entry.id, getById(await library.load(), entry.id).metadataRevision, { containerTitle: "Elsevier" })
  check("an unnamed field is not overwritten", getById(await library.load(), entry.id).record.containerTitle, "Nature")
  check("the refused overwrite reports nothing filled", ignored.status === "committed" && ignored.filled.length, 0)

  check("an unknown id is reported", (await completeMetadata(library, "nope", 1, {})).status, "not-found")
}

// --- honest reporting of fills --------------------------------------------

{
  // A fresh workspace so the revision bookkeeping is not shared with the
  // earlier cases.
  const scratch = await mkdtemp(join(tmpdir(), "lit-fill-"))
  const lib = createLibrary(scratch)

  await addRecords(
    lib,
    [{ ...emptyRecord("Sparse record"),
       identifiers: [{ scheme: "doi", value: "10.1000/sparse", isPrimary: true }] }],
    "openalex",
  )
  const stored = (await lib.load())[0]

  // The provider supplies empty strings for fields it does not have. Reporting
  // those as fills would tell the caller the record is complete.
  const result = await completeMetadata(
    lib,
    stored.id,
    stored.metadataRevision,
    { abstract: "", language: "", containerTitle: "A Real Journal", extra: "" },
  )

  check("the write commits", result.status, "committed")
  check("only the field that actually changed is reported as filled", result.filled, ["containerTitle"])
  check("the fields the provider did not supply are named", result.notSupplied.sort(), ["abstract", "extra", "language"])

  const after = getById(await lib.load(), stored.id)
  check("the filled field really landed", after.record.containerTitle, "A Real Journal")
  check("an empty string did not overwrite", after.record.abstract, "")
  check("an empty string did not fill", after.record.language, "")

  await rm(scratch, { recursive: true, force: true })
}

// --- evidence mode --------------------------------------------------------

// The mode is derived from the library, never asserted by the caller. It used to
// be a free setting written straight into the screening record, so a session
// could claim full-text screening while every decision had come from an
// abstract.
{
  const empty = deriveEvidenceMode([]);
  check("an empty library supports no evidence", empty.mode, "unavailable");
  check("an empty library has nothing with text", empty.withAbstract, 0);

  const abstractsOnly = deriveEvidenceMode([{ abstract: "some text" }, { abstract: "more" }]);
  check("abstracts alone give abstract mode", abstractsOnly.mode, "abstract");
  check("both records count as having evidence", abstractsOnly.withAbstract, 2);
  check("neither has full text", abstractsOnly.withFullText, 0);

  const withText = deriveEvidenceMode([
    { abstract: "some text" },
    { abstract: "", fullText: { characters: 5000 } },
  ]);
  check("any full text raises the mode", withText.mode, "full-text");
  check("exactly one record has full text", withText.withFullText, 1);

  // A record with extracted text counts as having evidence even with no abstract.
  const textOnly = deriveEvidenceMode([{ abstract: "   ", fullText: { characters: 10 } }]);
  check("full text alone is enough evidence", textOnly.mode, "full-text");

  // Requesting full text the library cannot supply is refused with a reason.
  check(
    "full-text on an abstract-only library is refused",
    checkEvidenceMode("full-text", abstractsOnly).ok,
    false,
  );
  check(
    "full-text on an empty library is refused",
    checkEvidenceMode("full-text", empty).ok,
    false,
  );
  check("abstract on an abstract-only library is served", checkEvidenceMode("abstract", abstractsOnly).ok, true);
  check("abstract on an empty library is refused", checkEvidenceMode("abstract", empty).ok, false);
  check("full-text is served once the text exists", checkEvidenceMode("full-text", withText).ok, true);

  const refusal = checkEvidenceMode("full-text", abstractsOnly);
  check("the refusal names the tool that fixes it", refusal.ok === false && refusal.reason.includes("read_pdf"), true);

  // The stored state can only hold a derived mode.
  const state = createScreeningState({ description: "d", inclusion: "i", exclusion: "e" }, "full-text");
  check("state starts at the derived mode given to it", state.evidenceMode, "full-text");
}

{
  const rule = parseRule({ description: "gene therapy", inclusion: "trial", exclusion: "review" })
  check("a well-formed rule parses", rule.inclusion, "trial")
  check("a rule without inclusion is rejected", parseRule({ description: "d", inclusion: "", exclusion: "" }), undefined)
  check("a non-object is rejected", parseRule("nope"), undefined)
  check(
    "an over-long rule is rejected",
    parseRule({ description: "x".repeat(RULE_MAX_LENGTH), inclusion: "y", exclusion: "" }),
    undefined,
  )

  // The refusal has to name the field at fault. A rule with a fine inclusion
  // and no exclusion used to be refused with a message blaming inclusion, which
  // sent the caller to fix the one field that was already correct.
  check("a missing inclusion is named as such", checkRule({ inclusion: "", exclusion: "x" }), "missing-inclusion")
  check("a missing exclusion is named as such", checkRule({ inclusion: "x" }), "missing-exclusion")
  check("an empty exclusion is a missing exclusion", checkRule({ inclusion: "x", exclusion: "   " }), "missing-exclusion")
  check("a non-object is named as such", checkRule("nope"), "not-an-object")
  check("an over-long rule is named as such", checkRule({ inclusion: "y".repeat(RULE_MAX_LENGTH), exclusion: "z" }), "too-long")
  // `description` is background prose and genuinely optional; only the two
  // criteria are required. Defaulting it is safe because it changes nothing.
  check("a rule without a description parses", checkRule({ inclusion: "x", exclusion: "y" }), {
    description: "",
    inclusion: "x",
    exclusion: "y",
  })

  const stored = formatRule(rule)
  check("a rule round-trips", readRule(stored)?.exclusion, "review")
  check("corrupt text reads as undefined", readRule("{not json"), undefined)

  const prompt = rulePrompt(stored)
  check("the prompt states the conjunction", prompt.includes("all must be met"), true)
  check("the prompt states the exclusion", prompt.includes("none may apply"), true)
  check("a corrupt rule cannot produce a prompt", (() => { try { rulePrompt("{"); return false } catch { return true } })(), true)
}

// --- structured criteria -------------------------------------------------

{
  const record = {
    ...emptyRecord("Gene therapy for sickle cell"),
    issuedYear: 2021,
    language: "en",
    itemType: "journalArticle",
    containerTitle: "Nature Medicine",
    abstract: "A trial of gene therapy.",
    identifiers: [{ scheme: "doi", value: "10.1038/x", isPrimary: true }],
  }

  check("a matching year passes", evaluateCriterion({ kind: "year-range", from: 2015, to: 2023 }, record).passed, true)
  check("a year outside the range fails", evaluateCriterion({ kind: "year-range", from: 2022 }, record).passed, false)
  check("an allowed language passes", evaluateCriterion({ kind: "language", languages: ["en", "fr"] }, record).passed, true)
  check("a disallowed language fails", evaluateCriterion({ kind: "language", languages: ["de"] }, record).passed, false)
  check("a journal allowlist matches by substring", evaluateCriterion({ kind: "journal", journals: ["Nature"] }, record).passed, true)
  check("an absent year is skipped, not failed", evaluateCriterion({ kind: "year-range", from: 2020 }, { ...record, issuedYear: undefined }).skipped, true)
  check("an allowed item type passes", evaluateCriterion({ kind: "item-type", types: ["journalArticle"] }, record).passed, true)

  const outcome = screenRecord(record, parseCriteria([
    { kind: "year-range", from: 2015 },
    { kind: "language", languages: ["en"] },
  ]))
  check("passing structured checks is still uncertain", outcome.verdict, "uncertain")
  check("the prose remainder is flagged", outcome.needsJudgement, true)

  const excluded = screenRecord(record, parseCriteria([
    { kind: "year-range", from: 2022 },
  ]))
  check("a decisive failure excludes", excluded.verdict, "no-match")
  check("no judgement is needed once excluded", excluded.needsJudgement, false)

  const nothing = screenRecord(record, [])
  check("no criteria leaves everything uncertain", nothing.verdict, "uncertain")

  const partial = screenRecord({ ...record, issuedYear: undefined }, parseCriteria([
    { kind: "year-range", from: 2015 },
    { kind: "language", languages: ["en"] },
  ]))
  check("a skipped criterion does not exclude", partial.verdict, "uncertain")
  check("the skip is reported", partial.skipped.length, 1)

  check("an unparseable criterion is dropped", parseCriteria([{ kind: "nope" }, { kind: "year-range", from: 2020 }]).length, 1)
  check("type aliases resolve", parseCriteria([{ kind: "item-type", types: ["journal article"] }])[0].types, ["journalArticle"])
  check("an unknown type alias is dropped", parseCriteria([{ kind: "item-type", types: ["nonsense"] }]).length, 0)
}

// --- a corrupt store is not an empty store -------------------------------

{
  // load() used to return [] for anything it could not parse, which is right
  // for a missing file and destructive for a damaged one: the next search would
  // save only its own records over the top of the library.
  const damaged = await mkdtemp(join(tmpdir(), "lit-corrupt-"))
  const brokenLibrary = createLibrary(damaged)
  await brokenLibrary.save([
    {
      id: "keep-me",
      record: emptyRecord("A paper worth keeping"),
      metadataRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["pubmed"],
    },
  ])

  const { writeFile } = await import("node:fs/promises")
  await writeFile(brokenLibrary.path, '{"schema_version": 1, "entries": [ truncated', "utf8")

  let raised = null
  try {
    await brokenLibrary.load()
  } catch (error) {
    raised = error
  }
  check("a damaged store is reported rather than read as empty", Boolean(raised), true)
  check("the error names the store path", String(raised?.message ?? "").includes(brokenLibrary.path), true)
  check("the error says nothing was overwritten", String(raised?.message ?? "").includes("left untouched"), true)

  // The damaged bytes are still on disk: a silent fallback would have let the
  // next save replace them, destroying whatever the file still held.
  const { readFile } = await import("node:fs/promises")
  check(
    "the damaged store was not modified",
    (await readFile(brokenLibrary.path, "utf8")).includes("truncated"),
    true,
  )

  await rm(damaged, { recursive: true, force: true })
}

// --- the full-text refusal tells the truth --------------------------------

{
  // The two branches of this refusal used to carry the same sentence, which
  // claimed that no record had an abstract when most of them did.
  const abstractsOnly = deriveEvidenceMode([
    { abstract: "A real abstract." },
    { abstract: "Another real abstract." },
  ])
  const refused = checkEvidenceMode("full-text", abstractsOnly)
  check("full-text on an abstract-only library is refused", refused.ok, false)
  check(
    "the refusal does not claim the library holds no evidence at all",
    !refused.reason.includes("no record in this library has an abstract"),
    true,
  )
  check("the refusal counts the abstracts that do exist", refused.reason.includes("2"), true)
  check(
    "the refusal says no record has extracted text",
    refused.reason.includes("0 have extracted text"),
    true,
  )

  const nothing = checkEvidenceMode("full-text", deriveEvidenceMode([{ abstract: "" }]))
  check(
    "with no evidence at all, the refusal says so",
    nothing.reason.includes("abstract or extracted text"),
    true,
  )

  const withText = checkEvidenceMode(
    "full-text",
    deriveEvidenceMode([{ abstract: "a", fullText: { characters: 500 } }]),
  )
  check("full-text is allowed once text exists", withText.ok, true)
  check("the mode reported is the derived one", withText.mode, "full-text")
}

// --- cleanup -------------------------------------------------------------

await rm(workspace, { recursive: true, force: true })

console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure)
  process.exit(1)
}