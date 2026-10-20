/**
 * Tests for identifier normalization.
 *
 * Run with: node --experimental-strip-types scripts/test-identifiers.mjs
 *
 * These cases come from the shapes that actually break deduplication in
 * practice: values pasted out of a PDF, a browser address bar, or a reference
 * list where the trailing characters belong to the citation, not the DOI.
 */

import {
  detectScheme,
  identifierUrl,
  isValidIdentifier,
  normalizeIdentifierValue,
  normalizeIdentifiers,
  parseIdentifier,
  recordKey,
  stripSchemePrefix,
} from "../src/literature/identifiers.ts"

let passed = 0
const failures = []

function check(name, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed += 1
  else failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

// --- DOI -----------------------------------------------------------------

check(
  "doi: prefix is stripped",
  normalizeIdentifierValue("doi", "doi: 10.1038/nature12373"),
  "10.1038/nature12373",
)

check(
  "doi.org URL becomes a bare DOI",
  normalizeIdentifierValue("doi", "https://doi.org/10.1038/nature12373"),
  "10.1038/nature12373",
)

check(
  "dx.doi.org URL becomes a bare DOI",
  normalizeIdentifierValue("doi", "http://dx.doi.org/10.1038/nature12373"),
  "10.1038/nature12373",
)

check(
  "trailing citation punctuation is removed",
  normalizeIdentifierValue("doi", "10.1038/nature12373."),
  "10.1038/nature12373",
)

check(
  "trailing bracket is removed",
  normalizeIdentifierValue("doi", "10.1038/nature12373)"),
  "10.1038/nature12373",
)

check(
  "a copyright block on the last line is removed",
  normalizeIdentifierValue("doi", "10.1038/nature12373\nCopyright 2021 Springer"),
  "10.1038/nature12373",
)

check(
  "copyright is only stripped from the final line",
  // The word "Copyright" mid-value is not a rights line and must survive.
  normalizeIdentifierValue("doi", "10.1000/Copyright-Stud\n10.1038/nature12373"),
  "10.1000/Copyright-Stud\n10.1038/nature12373",
)

check(
  "a DOI that legitimately ends in a period-adjacent character keeps its suffix",
  normalizeIdentifierValue("doi", "10.1016/j.cell.2021.01.001"),
  "10.1016/j.cell.2021.01.001",
)

// --- PMID ----------------------------------------------------------------

check("PMID: prefix is stripped", normalizeIdentifierValue("pmid", "PMID: 33283989"), "33283989")

check(
  "a PubMed URL becomes a bare PMID",
  normalizeIdentifierValue("pmid", "https://pubmed.ncbi.nlm.nih.gov/33283989/"),
  "33283989",
)

check(
  "a PubMed URL with a query string becomes a bare PMID",
  normalizeIdentifierValue("pmid", "https://pubmed.ncbi.nlm.nih.gov/33283989/?format=pubmed"),
  "33283989",
)

// --- PMCID ---------------------------------------------------------------

check(
  "PMCID without a prefix gains one",
  normalizeIdentifierValue("pmcid", "1234567"),
  "PMC1234567",
)

check(
  "PMCID: prefix is stripped and re-added",
  normalizeIdentifierValue("pmcid", "PMCID: PMC1234567"),
  "PMC1234567",
)

check(
  "a lowercase pmcid is upper-cased",
  normalizeIdentifierValue("pmcid", "pmc1234567"),
  "PMC1234567",
)

check(
  "a PMC article URL becomes a bare PMCID",
  normalizeIdentifierValue("pmcid", "https://pmc.ncbi.nlm.nih.gov/articles/PMC1234567/"),
  "PMC1234567",
)

// --- arXiv ---------------------------------------------------------------

check(
  "arXiv: prefix and version are stripped",
  normalizeIdentifierValue("arxiv", "arXiv:2103.00020v2"),
  "2103.00020",
)

check(
  "an arXiv abs URL becomes a bare id",
  normalizeIdentifierValue("arxiv", "https://arxiv.org/abs/2103.00020"),
  "2103.00020",
)

check(
  "an arXiv pdf URL loses the .pdf",
  normalizeIdentifierValue("arxiv", "https://arxiv.org/pdf/2103.00020v1.pdf"),
  "2103.00020",
)

check(
  "an old-style arXiv id keeps its slash",
  normalizeIdentifierValue("arxiv", "hep-th/9901001v1"),
  "hep-th/9901001",
)

// --- validity and URLs ---------------------------------------------------

check("a well-formed DOI is valid", isValidIdentifier("doi", "10.1038/nature12373"), true)
check("a DOI-shaped string with no registrant is invalid", isValidIdentifier("doi", "10.1/x"), false)
check("an all-digit PMID is valid", isValidIdentifier("pmid", "33283989"), true)
check("a non-numeric PMID is invalid", isValidIdentifier("pmid", "not-a-number"), false)

check(
  "a DOI URL keeps the slash unescaped",
  identifierUrl("doi", "10.1016/j.cell.2021.01.001"),
  "https://doi.org/10.1016/j.cell.2021.01.001",
)

check(
  "a malformed DOI has no URL rather than a broken one",
  identifierUrl("doi", "not a doi"),
  undefined,
)

check("a PMID URL ends with a slash", identifierUrl("pmid", "33283989"), "https://pubmed.ncbi.nlm.nih.gov/33283989/")

// --- detection -----------------------------------------------------------

check("a doi.org URL is detected", detectScheme("https://doi.org/10.1038/nature12373"), "doi")
check("a bare DOI is detected", detectScheme("10.1038/nature12373"), "doi")
check("a PubMed URL is detected", detectScheme("https://pubmed.ncbi.nlm.nih.gov/33283989/"), "pmid")
check("a bare PMID is detected", detectScheme("33283989"), "pmid")
check("an arXiv id is detected", detectScheme("2103.00020"), "arxiv")
check("free text is not an identifier", detectScheme("sickle cell anemia"), undefined)

// --- scheme:value prefixes -------------------------------------------------
//
// These are the form os_literature_list prints ({scheme, value} pairs), so a
// reader copying one back out writes exactly this. Accepting what we print is
// the whole point; before this, `doi:10.1038/nature12373` was reported as "not a
// recognizable identifier" while the bare form resolved the same record.

check("a doi: prefix is detected", detectScheme("doi:10.1038/nature12373"), "doi")
check("a lowercase doi: prefix is detected", detectScheme("doi: 10.1038/nature12373"), "doi")
check("a pmid: prefix is detected", detectScheme("PMID:33283989"), "pmid")
check("a spaced pmid: prefix is detected", detectScheme("PMID: 33283989"), "pmid")
check("a lowercase pmid: prefix is detected", detectScheme("pmid:33283989"), "pmid")
check("a pmcid: prefix is not read as pmid", detectScheme("PMCID:PMC33283989"), "pmcid")
check("an arxiv: prefix is detected", detectScheme("arXiv:2103.00020"), "arxiv")
check("a bare pmid: label with no value is not an identifier", detectScheme("pmid:"), undefined)

check(
  "parseIdentifier normalizes a doi: prefix",
  parseIdentifier("doi:10.1038/nature12373"),
  { scheme: "doi", value: "10.1038/nature12373", isPrimary: true },
)
check(
  "parseIdentifier normalizes a spaced pmid: prefix",
  parseIdentifier("PMID: 33283989"),
  { scheme: "pmid", value: "33283989", isPrimary: true },
)
check(
  "parseIdentifier normalizes a pmcid: prefix",
  parseIdentifier("PMCID: PMC33283989"),
  { scheme: "pmcid", value: "PMC33283989", isPrimary: true },
)
check(
  "a prefixed identifier equals its bare form",
  recordKey({
    identifiers: [
      { scheme: "doi", value: "10.1038/nature12373", isPrimary: true },
      { scheme: "doi", value: "doi:10.1038/nature12373", isPrimary: false },
    ],
  }),
  recordKey({ identifiers: [{ scheme: "doi", value: "https://doi.org/10.1038/nature12373", isPrimary: true }] }),
)

// An unrelated `word:` prefix must survive: `arctan:1` is not a broken PMID.
check("an unrecognized prefix does not become an identifier", parseIdentifier("arctan:1"), undefined)
check(
  "an unrecognized prefix is left intact by the stripper",
  stripSchemePrefix("arctan:1"),
  { rest: "arctan:1" },
)

check(
  "parseIdentifier yields a primary identifier",
  parseIdentifier("https://doi.org/10.1038/nature12373."),
  { scheme: "doi", value: "10.1038/nature12373", isPrimary: true },
)

check("parseIdentifier rejects free text", parseIdentifier("sickle cell anemia"), undefined)

// --- preference ----------------------------------------------------------

check(
  "only one primary survives per scheme",
  normalizeIdentifiers([
    { scheme: "doi", value: "10.1038/nature12373", isPrimary: true },
    { scheme: "doi", value: "10.1038/NATURE12373", isPrimary: true },
  ]).filter((identifier) => identifier.isPrimary).length,
  1,
)

check(
  "values are normalized while preferences are resolved",
  normalizeIdentifiers([{ scheme: "doi", value: "https://doi.org/10.1038/nature12373.", isPrimary: false }]),
  [{ scheme: "doi", value: "10.1038/nature12373", isPrimary: false }],
)

check(
  "two spellings of one DOI collapse to one primary",
  normalizeIdentifiers([
    { scheme: "doi", value: "10.1038/nature12373", isPrimary: true },
    { scheme: "doi", value: "10.1038/NATURE12373", isPrimary: true },
  ]).find((identifier) => identifier.isPrimary)?.value.toLowerCase(),
  "10.1038/nature12373",
)

// --- record keys ---------------------------------------------------------

check(
  "a record keyed by DOI",
  recordKey({ identifiers: [{ scheme: "doi", value: "10.1038/nature12373", isPrimary: true }] }),
  "doi:10.1038/nature12373",
)

check(
  "the same work found two ways gets one key",
  recordKey({
    identifiers: [
      { scheme: "pmid", value: "33283989", isPrimary: true },
      { scheme: "doi", value: "10.1038/nature12373", isPrimary: false },
    ],
  }),
  "doi:10.1038/nature12373",
)

check(
  "a record with only a non-identity scheme has no key",
  recordKey({ identifiers: [{ scheme: "issn", value: "1234-5678", isPrimary: true }] }),
  undefined,
)

check(
  "a malformed identifier does not produce a key",
  recordKey({ identifiers: [{ scheme: "doi", value: "not a doi", isPrimary: true }] }),
  undefined,
)

// --- report --------------------------------------------------------------

console.log(`${passed} passed, ${failures.length} failed`)
if (failures.length) {
  for (const failure of failures) console.error("FAIL " + failure)
  process.exit(1)
}