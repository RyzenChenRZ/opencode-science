/**
 * Tests for the review and provenance guarantees.
 *
 * Each of these corresponds to a defect found in an end-to-end run: a hash that
 * was never checked, a "gate" that did not gate, a PNG pasted into a reviewer's
 * context as mojibake, and producer code stored as reproduction when it was an
 * abridged stub.
 *
 * Run with: node --experimental-strip-types scripts/test-review.mjs
 */

import { blockHash, matchesBlockHash, HASH_PREVIEW } from "../src/reviewer-tools.ts"
import { gradeProducer, environmentFromRun } from "../src/provenance.ts"
import { specialistPermissions, renderAgentFile, agentId } from "../src/specialists.ts"
import { loadSpecialists } from "../src/specialists.ts"
import { forwardedCredentials } from "../src/notebook.ts"
import { credential, credentialParams } from "../src/http.ts"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0
const failures = []

function check(name, actual, expected) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left === right) {
    passed += 1
    return
  }
  failures.push(`${name}\n    expected ${right}\n    actual   ${left}`)
}

function checkTrue(name, value) {
  check(name, Boolean(value), true)
}

// --- content hash anchoring ------------------------------------------------

const blockText = "The analysis is presented as evidence about metformin in humans."
const real = blockHash(blockText)

checkTrue("the hash is a full sha256", /^[0-9a-f]{64}$/.test(real))
checkTrue("the same text hashes to the same value", blockHash(blockText) === real)
checkTrue("different text hashes differently", blockHash(`${blockText}!`) !== real)
checkTrue("the hash is of the utf-8 bytes", blockHash("é") === blockHash("é"))
checkTrue("a leading/trailing space changes the hash", blockHash(` ${blockText}`) !== real)

// The preview read_turn prints has to be accepted, or the reviewer would have
// to recompute a hash it was never shown in full.
checkTrue("the printed prefix matches", matchesBlockHash(real.slice(0, HASH_PREVIEW), real))
checkTrue("a longer prefix matches", matchesBlockHash(real, real))
checkTrue("an sha256: prefix is accepted", matchesBlockHash(`sha256:${real.slice(0, HASH_PREVIEW)}`, real))
checkTrue("case does not matter", matchesBlockHash(real.toUpperCase(), real))

// These are the ones that used to pass. submit_findings only checked that
// contentHash was truthy, so any string stood as the anchor for a finding.
check("an all-zero hash is refused", matchesBlockHash("0".repeat(64), real), false)
check("an all-zero prefix is refused", matchesBlockHash("000000000000", real), false)
check("a wrong hash is refused", matchesBlockHash("a".repeat(64), real), false)
check("a hash of different text is refused", matchesBlockHash(blockHash("something else entirely"), real), false)
check("a hash that is a suffix rather than a prefix is refused", matchesBlockHash(real.slice(-16), real), false)
check("a too-short citation is refused", matchesBlockHash(real.slice(0, 8), real), false)
check("empty is refused", matchesBlockHash("", real), false)
check("non-hex is refused", matchesBlockHash("z".repeat(64), real), false)

// --- producer code grading -------------------------------------------------

check("complete code is available", gradeProducer("df.to_csv('a.csv')", undefined), { state: "available" })
check(
  "code with a comment but no ellipsis is available",
  gradeProducer("# see run log\ndf.to_csv('a.csv')", undefined),
  { state: "available" },
)
check("absent code with a run id points at the run", gradeProducer(undefined, "abc12345").state, "unavailable")
checkTrue(
  "absent code with a run id says where the script is",
  gradeProducer(undefined, "abc12345").reason.includes("run id"),
)
check("absent code with no run id says so", gradeProducer(undefined, undefined).state, "unavailable")

// The defect the reviewer caught: a stub with an ellipsis was stored as
// reproduction and reported as "producer code recorded".
const stub = 'import matplotlib\ndf = pd.read_csv("a.csv")\n# ... two-panel figure ...\nfig.savefig("f.png")'
const graded = gradeProducer(stub, undefined)
check("an abridged snippet is partial, not available", graded.state, "partial")
checkTrue("the partial reason explains why", graded.reason.includes("abridged"))
checkTrue("the partial reason says how to fix it", graded.reason.includes("runId"))
check("an abridged snippet with a run id is still partial", gradeProducer(stub, "abc").state, "partial")
check("a unicode ellipsis is also detected", gradeProducer("x = 1\u2026y = 2", undefined).state, "partial")
check("a spread is not an ellipsis", gradeProducer("xs = [1, 2]\nys = [3, 4]", undefined), { state: "available" })
check("whitespace-only code is unavailable", gradeProducer("   \n  ", undefined).state, "unavailable")

// A run id is the only handle a reader has to the producing script, so a claim
// that no run backs has to be distinguishable from one that does.
check(
  "an unverifed run id is not offered as a script pointer",
  gradeProducer(undefined, "deadbeef", false).reason.includes("not in this workspace's run log"),
  true,
)
check(
  "a verified run id still points at the script",
  gradeProducer(undefined, "abc12345", true).reason.includes("points at the full script"),
  true,
)

// --- environment derived from the run log ----------------------------------

const observedRun = {
  runId: "run-abc123",
  language: "python",
  interpreter: "python 3.11.4",
  version: "3.11.4",
  code: 0,
  script: "print(1)",
  stdout: "1",
  stderr: "",
  changedFiles: [],
  capturedAt: "2026-01-01T00:00:00.000Z",
  durationMs: 10,
}
const fromRun = environmentFromRun(observedRun, observedRun.runId)
check("a known run yields an available environment", fromRun.state, "available")
checkTrue("the summary names the interpreter", fromRun.summary.includes("3.11.4"))
checkTrue("the summary names the run", fromRun.summary.includes(observedRun.runId))
check("no run and no summary is unavailable", environmentFromRun(undefined, undefined).state, "unavailable")
checkTrue(
  "a missing run id is named in the reason",
  environmentFromRun(undefined, "deadbeef").reason.includes("deadbeef"),
)

// --- the reviewer boundary -------------------------------------------------

/** Applies the permission list the way OpenCode does: last matching rule wins. */
function permits(rules, action, resource = "*") {
  let effect = "allow" // the base policy
  for (const rule of rules) {
    if (!matches(rule.action, action) || !matches(rule.resource, resource)) continue
    effect = rule.effect
  }
  return effect
}

function matches(pattern, value) {
  if (pattern === "*") return true
  if (!pattern.includes("*")) return pattern === value
  const head = pattern.slice(0, pattern.indexOf("*"))
  const tail = pattern.slice(pattern.indexOf("*") + 1)
  return value.startsWith(head) && value.endsWith(tail) && value.length >= head.length + tail.length
}

const loaded = await loadSpecialists(join(REPO, "specialists"))
check("three specialists load", loaded.specialists.length, 3)
check("none are skipped", loaded.skipped, [])

const reviewer = loaded.specialists.find((s) => s.name === "Evidence Reviewer")
checkTrue("the reviewer exists", Boolean(reviewer))
const reviewerRules = specialistPermissions(reviewer)

// The defect: the reviewer was granted notebook_run and read by the base policy,
// so it could recompute the work it was auditing.
check("the reviewer cannot run code", permits(reviewerRules, "notebook_run"), "deny")
check("the reviewer cannot read arbitrary files", permits(reviewerRules, "read"), "deny")
check("the reviewer cannot write", permits(reviewerRules, "write"), "deny")
check("the reviewer cannot edit", permits(reviewerRules, "edit"), "deny")
check("the reviewer cannot use bash", permits(reviewerRules, "bash"), "deny")
check("the reviewer cannot load a skill", permits(reviewerRules, "skill", "figure-style"), "deny")
check("the reviewer cannot reach a connector", permits(reviewerRules, "os_pubmed_search"), "deny")
check("the reviewer cannot publish", permits(reviewerRules, "publish_artifact"), "deny")

// ...and it can still do the one job it exists for.
check("the reviewer can read a turn", permits(reviewerRules, "read_turn"), "allow")
check("the reviewer can read an execution log", permits(reviewerRules, "query_execution_log"), "allow")
check("the reviewer can read an artifact", permits(reviewerRules, "read_artifact"), "allow")
check("the reviewer can submit findings", permits(reviewerRules, "submit_findings"), "allow")

// The other two specialists keep working, which a deny-all would break if the
// allowlist were incomplete.
const analyst = loaded.specialists.find((s) => s.name === "Data Analyst")
const analystRules = specialistPermissions(analyst)
check("the analyst can run a script", permits(analystRules, "notebook_run"), "allow")
check("the analyst can publish", permits(analystRules, "publish_artifact"), "allow")
check("the analyst can load scvi-tools", permits(analystRules, "skill", "scvi-tools"), "allow")
check("the analyst cannot read the literature library", permits(analystRules, "os_literature_search"), "deny")
check("the analyst cannot load the literature skill", permits(analystRules, "skill", "literature-review"), "deny")

const researcher = loaded.specialists.find((s) => s.name === "Literature Researcher")
const researcherRules = specialistPermissions(researcher)
check("the researcher can search PubMed", permits(researcherRules, "os_pubmed_search"), "allow")
check("the researcher can read sections", permits(researcherRules, "os_literature_read_section"), "allow")
check("the researcher cannot run an analysis tool beyond notebooks", permits(researcherRules, "publish_artifact"), "deny")
check("the researcher cannot reach trials", permits(researcherRules, "os_clinical-trials_search"), "deny")

// --- agent file YAML -------------------------------------------------------

/**
 * A frontmatter check for the failure that occurred: a description containing
 * `Read-only: it reports...` was emitted with the colon outside the quotes, so
 * the line parsed as a nested mapping rather than a string.
 */
function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!match) throw new Error("no frontmatter")
  const out = {}
  let key = null
  for (const line of match[1].split("\n")) {
    if (/^\s{2}- /.test(line)) continue
    if (/^\s{4}\w+:/.test(line)) continue
    const kv = /^([A-Za-z_][\w-]*):(?: (.*))?$/.exec(line)
    if (!kv) throw new Error(`unparseable frontmatter line: ${JSON.stringify(line)}`)
    key = kv[1]
    let value = kv[2] ?? ""
    if (value.startsWith('"')) {
      if (!value.endsWith('"') || value.length < 2) throw new Error(`unterminated quote on ${key}`)
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

for (const specialist of loaded.specialists) {
  const file = renderAgentFile(specialist)
  let front
  try {
    front = parseFrontmatter(file)
  } catch (error) {
    check(`${agentId(specialist)} frontmatter parses`, `threw: ${error.message}`, "parses")
    continue
  }
  checkTrue(`${agentId(specialist)} frontmatter parses`, true)
  check(
    `${agentId(specialist)} description keeps its colon`,
    front.description.includes("Read-only:") || !specialist.description.includes("Read-only:"),
    true,
  )
  checkTrue(
    `${agentId(specialist)} description is the composed string`,
    front.description === `${specialist.displayName ?? specialist.name} — ${specialist.description}`,
  )
  check(`${agentId(specialist)} mode is subagent`, front.mode, "subagent")
}

// --- credentials -----------------------------------------------------------

check("an absent credential is undefined", credential({ credentials: {} }, "ncbiApiKey"), undefined)
check(
  "a present credential is returned",
  credential({ credentials: { ncbiApiKey: " abc " } }, "ncbiApiKey"),
  "abc",
)
check("a blank credential is undefined", credential({ credentials: { ncbiApiKey: "   " } }, "ncbiApiKey"), undefined)
check("no credentials means no parameters", credentialParams({ api_key: undefined, email: undefined }), "")
check("one credential contributes one parameter", credentialParams({ api_key: "k", email: undefined }), "&api_key=k")
check("both contribute", credentialParams({ api_key: "k", email: "a@b.c" }), "&api_key=k&email=a%40b.c")

// The literature-review helpers read the environment, not plugin options.
const ctx = { credentials: { openAlexApiKey: "OA-KEY", ncbiEmail: "me@example.org" } }
const forwarded = forwardedCredentials({ timeoutMs: 1000, credentialKeys: ["openAlexApiKey", "ncbiEmail"] }, ctx)
check("the OpenAlex key is forwarded", forwarded.OPENALEX_API_KEY, "OA-KEY")
check("the NCBI email is forwarded", forwarded.NCBI_EMAIL, "me@example.org")
check("the contact alias the helpers read is set", forwarded.CONTACT_EMAIL, "me@example.org")
check(
  "an unconfigured key contributes nothing",
  "NCBI_API_KEY" in forwarded,
  false,
)
check(
  "a key with no environment mapping is skipped",
  Object.keys(forwardedCredentials({ timeoutMs: 1000, credentialKeys: ["unknownKey"] }, ctx)).length,
  0,
)

// --- declared inputs that cannot be read ----------------------------------

{
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join: joinPath } = await import("node:path")
  const { publishArtifact } = await import("../src/provenance.ts")

  const ws = await mkdtemp(joinPath(tmpdir(), "prov-inputs-"))
  await mkdir(joinPath(ws, "data"), { recursive: true })
  await writeFile(joinPath(ws, "data", "present.csv"), "a,b\n1,2\n", "utf8")
  // Distinct files: republishing identical bytes returns the existing head
  // version rather than a new record, which would hide the second case here.
  await writeFile(joinPath(ws, "result-a.txt"), "done\n", "utf8")
  await writeFile(joinPath(ws, "result-b.txt"), "done\n", "utf8")
  await writeFile(joinPath(ws, "result-c.txt"), "done\n", "utf8")

  const record = await publishArtifact(ws, "ses-test", {
    path: "result-a.txt",
    // One declared input exists; the other does not. Dropping the missing one
    // silently would make "two inputs declared" read as "one input".
    inputs: ["data/present.csv", "data/absent.csv"],
  })

  check("an unreadable declared input makes the set partial", record.inputs.state, "partial")
  checkTrue(
    "the missing input is named",
    record.inputs.reason.includes("data/absent.csv"),
  )
  checkTrue("the readable input is still checksummed", record.inputs.files.some((f) => f.path === "data/present.csv"))

  const allGood = await publishArtifact(ws, "ses-test", {
    path: "result-b.txt",
    inputs: ["data/present.csv"],
  })
  check("inputs that all read are available", allGood.inputs.state, "available")

  // A runId that resolves to nothing must not be recorded as a working pointer.
  const bogus = await publishArtifact(ws, "ses-test", {
    path: "result-c.txt",
    runId: "not-a-real-run",
  })
  check("an unverified run id is marked", bogus.runVerified, false)
  checkTrue(
    "the producer reason says the run is absent",
    bogus.producer.reason.includes("not-a-real-run"),
  )

  // A runId that does resolve supplies the environment from the log, replacing
  // whatever the caller wrote.
  await mkdir(joinPath(ws, ".opencode-science", "runs"), { recursive: true })
  await writeFile(
    joinPath(ws, ".opencode-science", "runs", "run-realrun123.json"),
    JSON.stringify({
      runId: "realrun123",
      language: "python",
      interpreter: "python 3.12.1",
      version: "3.12.1",
      code: 0,
      script: "print('hi')",
      stdout: "hi",
      stderr: "",
      changedFiles: [],
      capturedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 5,
    }),
    "utf8",
  )
  await writeFile(joinPath(ws, "result-d.txt"), "done\n", "utf8")
  const verified = await publishArtifact(ws, "ses-test", {
    path: "result-d.txt",
    runId: "realrun123",
    environmentSummary: "I typed this from memory",
  })
  check("a verified run id is marked", verified.runVerified, true)
  checkTrue(
    "the recorded interpreter wins over a typed summary",
    verified.environment.summary.includes("3.12.1"),
  )
  check(
    "the typed summary is not what is recorded",
    verified.environment.summary.includes("from memory"),
    false,
  )

  const { rm } = await import("node:fs/promises")
  await rm(ws, { recursive: true, force: true })
}

// --- run history selects the recent end -----------------------------------

{
  const { mkdtemp, writeFile, mkdir, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join: joinPath } = await import("node:path")
  const { readRunHistory } = await import("../src/notebook.ts")

  const ws = await mkdtemp(joinPath(tmpdir(), "run-history-"))
  const dir = joinPath(ws, ".opencode-science", "runs")
  await mkdir(dir, { recursive: true })

  // 25 runs, written oldest to newest, so `limit` has to choose an end.
  for (let i = 0; i < 25; i += 1) {
    const id = `run-${String(i).padStart(4, "0")}`
    await writeFile(
      joinPath(dir, `${id}.json`),
      JSON.stringify({
        runId: id,
        language: "python",
        interpreter: "python 3.12.1",
        version: "3.12.1",
        code: 0,
        script: `print(${i})`,
        stdout: String(i),
        stderr: "",
        changedFiles: [],
        // One minute apart, so ordering is unambiguous.
        capturedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        durationMs: 1,
      }),
      "utf8",
    )
  }

  const limited = await readRunHistory(ws, 3)
  check("the limit returns exactly that many runs", limited.length, 3)
  check("the newest run comes first", limited[0].runId, "run-0024")
  check("the window is the recent end, not an arbitrary one", limited.map((r) => r.runId), [
    "run-0024",
    "run-0023",
    "run-0022",
  ])

  const full = await readRunHistory(ws, 100)
  check("a full read is newest first", full[0].runId, "run-0024")
  check("a full read includes every run", full.length, 25)

  await rm(ws, { recursive: true, force: true })
}

// --- a rule that is not the recorded one cannot be screened against --------

{
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join: joinPath } = await import("node:path")
  const { createLibrary, emptyRecord } = await import("../src/literature/library.ts")
  const { LITERATURE_TOOLS } = await import("../src/literature/tools.ts")

  const ws = await mkdtemp(joinPath(tmpdir(), "screen-guard-"))
  const library = createLibrary(ws)
  await library.save([
    {
      id: "doi-10.1-test",
      record: { ...emptyRecord("A test paper"), abstract: "A real abstract.", issuedYear: 2020 },
      metadataRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["pubmed"],
    },
  ])

  const byName = (name) => LITERATURE_TOOLS.find((t) => t.name === name)
  const ctx = { workspace: ws, sessionID: "ses-test", signal: undefined, credentials: {} }
  const stateTool = byName("os_literature_screening_state")
  const screenTool = byName("os_literature_screen")

  const RULE_A = { description: "A", inclusion: "alpha", exclusion: "beta" }
  const RULE_B = { description: "B", inclusion: "gamma", exclusion: "delta" }

  await stateTool.run({ action: "set-rule", rule: RULE_A, evidenceMode: "abstract" }, ctx)

  // Screening against a rule that is not the recorded one must be refused: the
  // verdicts would be stamped with the recorded rule's revision.
  const contradicted = await screenTool.run({ rule: RULE_B, limit: 10 }, ctx)
  checkTrue("a contradicting rule is refused", Boolean(contradicted.error))
  checkTrue(
    "the refusal names the recorded revision",
    String(contradicted.error).includes("revision"),
  )
  checkTrue("the refusal shows the recorded rule", String(contradicted.recordedRule).includes("alpha"))

  // The recorded rule still screens.
  const ok = await screenTool.run({ rule: RULE_A, limit: 10 }, ctx)
  check("the recorded rule screens normally", ok.screened, 1)
  check("the revision is reported alongside the results", ok.ruleRevision, 1)

  // A decision prepared against a stale revision is refused rather than
  // laundered into the current rule's results.
  const stale = await stateTool.run(
    { action: "decide", ruleRevision: 99, decisions: [{ id: "doi-10.1-test", verdict: "match", reason: "x" }] },
    ctx,
  )
  checkTrue("a stale revision is refused", Boolean(stale.error))

  const fresh = await stateTool.run(
    { action: "decide", ruleRevision: 1, decisions: [{ id: "doi-10.1-test", verdict: "match", reason: "x" }] },
    ctx,
  )
  check("a matching revision records the decision", fresh.recorded, 1)

  // A full-text screening must not take a verdict about a record that has no
  // extracted text: the mode is a claim about what the judgement was based on.
  await stateTool.run(
    { action: "set-rule", rule: { description: "ft", inclusion: "alpha", exclusion: "beta" }, evidenceMode: "abstract" },
    ctx,
  )
  const lib2 = createLibrary(ws)
  await lib2.save([
    {
      id: "doi-10.2-text",
      record: {
        ...emptyRecord("A paper with text"),
        abstract: "Abstract.",
        issuedYear: 2020,
        fullText: { extractor: "pymupdf", pages: 1, characters: 500, sections: [], path: "x", storedAt: "2026-01-01" },
      },
      metadataRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["pubmed"],
    },
    {
      id: "doi-10.3-notext",
      record: { ...emptyRecord("A paper without text"), abstract: "Abstract.", issuedYear: 2020 },
      metadataRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sources: ["pubmed"],
    },
  ])
  const ft = await stateTool.run(
    {
      action: "set-rule",
      rule: { description: "ft", inclusion: "alpha", exclusion: "beta" },
      evidenceMode: "full-text",
    },
    ctx,
  )
  check("the full-text mode is accepted when one record has text", ft.evidenceMode, "full-text")

  const mixed = await stateTool.run(
    {
      action: "decide",
      ruleRevision: ft.ruleRevision,
      decisions: [
        { id: "doi-10.2-text", verdict: "match", reason: "read the results section" },
        { id: "doi-10.3-notext", verdict: "match", reason: "the abstract says so" },
      ],
    },
    ctx,
  )
  check("only the record with text is recorded", mixed.recorded, 1)
  checkTrue(
    "the abstract-only record is refused with a reason",
    Boolean(mixed.refusedForLackOfEvidence) &&
      mixed.refusedForLackOfEvidence.ids.includes("doi-10.3-notext"),
  )
  checkTrue(
    "the refusal says how to fix it",
    String(mixed.refusedForLackOfEvidence.reason).includes("read_pdf"),
  )

  // An override for an id that is not in the library would apply to no record
  // and could never be cleared by the record it names, so it is refused.
  const bogus = await stateTool.run(
    { action: "override", overrides: [{ id: "not-in-library", decision: "include", reason: "x" }] },
    ctx,
  )
  checkTrue("an override for an unknown id is refused", Boolean(bogus.error))
  check("nothing is recorded for it", bogus.overridden, 0)

  const realOverride = await stateTool.run(
    { action: "override", overrides: [{ id: "doi-10.2-text", decision: "exclude", reason: "off topic" }] },
    ctx,
  )
  check("an override for a real record is recorded", realOverride.overridden, 1)

  // reset-overrides only needs ids, and must not invent a decision for them.
  const cleared = await stateTool.run(
    { action: "reset-overrides", overrides: [{ id: "doi-10.2-text" }] },
    ctx,
  )
  check("an id alone clears an override", cleared.overridesRemaining, 0)

  // An override with no decision is refused rather than guessed.
  const noDecision = await stateTool.run(
    { action: "override", overrides: [{ id: "doi-10.2-text" }] },
    ctx,
  )
  checkTrue("an override with no decision is refused", Boolean(noDecision.error))
  check("nothing is recorded for it", noDecision.overridden, 0)

  await rm(ws, { recursive: true, force: true })
}

// --- a PDF must belong to the record it is attached to ---------------------

{
  const { checkDocumentIdentity } = await import("../src/literature/pdf.ts")

  const record = {
    title: "Short-chain fatty acid-butyrate supplementation in active ulcerative colitis",
    identifiers: [{ scheme: "doi", value: "10.1186/s12944-024-02203-z" }],
  }

  // A DOI printed in the document confirms identity outright.
  const byDoi = checkDocumentIdentity(record, [
    "Lipids in Health and Disease\nhttps://doi.org/10.1186/s12944-024-02203-z\nAbstract\nButyrate was measured.",
  ])
  check("a DOI in the text confirms identity", byDoi.confirmedBy, "doi")

  // A matching title confirms it when no DOI is printed.
  const byTitle = checkDocumentIdentity(
    { title: "Short-chain fatty acid-butyrate supplementation in active ulcerative colitis" },
    ["Short-chain fatty acid-butyrate supplementation in active ulcerative colitis", "Methods. Participants received sodium butyrate."],
  )
  check("a matching title confirms identity", byTitle.confirmedBy, "title")

  // A different paper does not.
  const wrong = checkDocumentIdentity(record, [
    "Attention Is All You Need\nAshish Vaswani, Noam Shazeer\nAbstract\nThe dominant sequence transduction models...",
  ])
  check("a different paper is not confirmed", wrong.ok, false)
  checkTrue("the mismatch explains itself", String(wrong.reason).includes("distinctive words"))
  checkTrue("the mismatch names what was missing", Array.isArray(wrong.missingWords) && wrong.missingWords.length > 0)

  // A record with nothing to compare against is not refused.
  const unknown = checkDocumentIdentity({ title: "" }, ["Some text without a title."])
  check("an uncomparable record is allowed through", unknown.ok, true)
}

console.log(`${passed} passed, ${failures.length} failed`)
for (const failure of failures) console.log("FAIL " + failure)
process.exit(failures.length ? 1 : 0)