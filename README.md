# opencode-science

A scientific research workbench for [OpenCode](https://opencode.ai) V2: vendored
skills from an open-source research application, read-only database connectors,
notebook execution against the interpreter you already have, and immutable
artifact versions with provenance records.

The point of the provenance records is that a result can be checked later. A
figure published with `publish_artifact` carries a checksum, the code that
produced it, its input files, and the environment it ran in. Where one of
those could not be established, the record says so and says why — it does not
fill the gap with a plausible-sounding value.

Not affiliated with AIPOCH. See [NOTICE.md](./NOTICE.md) for attribution and the
list of modifications.

**Status:** 0.1.0, first public release. See [CHANGELOG.md](./CHANGELOG.md).

**Requires:** OpenCode V2, Node 22+, and — for the notebook and PDF features —
Python 3.8+ in your own environment. Nothing is installed on your behalf.

## What it does

| Capability | Tools | Notes |
| --- | --- | --- |
| Skills | 21 vendored `SKILL.md` sets | Structure prediction, literature review, indication dossiers, figure and paper workflows |
| Connectors | `os_pubmed_search`, `os_literature_search_openalex`, `os_literature_crossref_lookup`, `os_uniprot_search`, `os_zenodo_search`, `os_clinical-trials_search`, `os_cellosaurus_lookup` | Read-only, anonymous by default; optional keys raise rate limits |
| Notebook | `notebook_run`, `notebook_run_history` | Python or R, against your own interpreter; every run is logged |
| Provenance | `publish_artifact`, `list_provenance`, `/os-provenance` | Immutable, checksummed versions |
| Literature workflow | `os_literature_search`, `os_literature_list`, `os_literature_complete`, `os_literature_lookup`, `os_literature_screen`, `os_literature_screening_state` | Stores records, deduplicates across sources, screens them against a rule |
| Document acquisition | `os_literature_fetch_pdf` | Finds an open-access copy, downloads it, verifies it is really the paper |
| Citation network | `os_literature_citations` | The works a paper cites, and the works that cite it |
| Bibliography export | `os_literature_export` | BibTeX, RIS, or CSL-JSON, optionally filtered by screening verdict |
| Reviewer | `read_turn`, `query_execution_log`, `read_artifact`, `submit_findings` | An independent audit agent that traces claims against records |
| Specialists | `science-literature-researcher`, `science-data-analyst`, `science-evidence-reviewer` | Subagents whose skill and connector allowlists are enforced, not suggested |

Commands: `/os-status` reports what is active, `/os-provenance <id>` prints a
provenance record.

### Literature workflow

A search is not the deliverable; a citable, deduplicated, screened set is. The
six tools form that path:

- `os_literature_search` queries PubMed and OpenAlex and **stores** what comes
  back, merging anything already in the library.
- `os_literature_complete` fills missing metadata from Crossref or PubMed using
  the record's own identifier.
- `os_literature_screen` applies a collection rule.
- `os_literature_screening_state` records judgements and reads back the tally.

**Deduplication is two-step, and the reason is worth knowing.** A PubMed hit
carries a PMID; a Crossref hit of the same paper carries a DOI. Their identifier
sets are disjoint, so nothing local can tell they are one work — merging on
title similarity would eventually fuse two different papers. So the first
search stores both, and `os_literature_complete` resolves one identifier against
the other. After that, either source finds the same entry. Until then a
retrieval of the same topic leaves duplicates, which the tool reports rather
than hiding.

**A screening verdict is three-valued.** `match`, `no-match`, and `uncertain`
are all real outcomes, and `uncertain` is a bucket rather than a failure: it
means the structured checks did not decide the record and the prose criteria
still need reading. Structured criteria you state exactly — year range, language,
item type, journal, title terms — are applied deterministically first, so the
model is only asked about what genuinely requires judgement. A record that
passes those checks is still `uncertain`, never an automatic match.

### Getting the paper, and its neighbourhood

A library of abstracts is not a review. Three tools close the remaining distance.

**`os_literature_fetch_pdf`** finds an open-access copy of a paper and downloads
it. It asks Unpaywall, which indexes every open-access copy there is, and
OpenAlex, which needs no key; for a preprint it goes to arXiv directly. Every
candidate is downloaded and checked by its first bytes, because the common
failure is a host answering a request for a PDF with an HTML page — a publisher's
bot-block, or a login wall. A page is not a paper, so it is reported as a failed
attempt rather than saved as one. When no PDF is served at all, the full text
comes from Europe PMC's JATS XML instead, which is the one source that does not
block.

A downloaded document is attached to its record only after the same check that
guards a hand-supplied PDF: the text has to contain the record's DOI, or enough
of its title. A copy of the wrong paper attached to the right record is worse
than no copy, because every later judgement is then made about a paper the
record does not name.

**`os_literature_citations`** returns a paper's neighbourhood: the works it
cites, and the works that cite it. The two directions come from different
services and are never inferred from one another — OpenAlex's `cites:` filter
and its `referenced_works` field do not mean opposite things, and reading them
as if they did returns the same list twice. The totals the source holds are
reported even when only part of the list is returned.

**`os_literature_export`** writes the library out as BibTeX, RIS, or CSL-JSON.
Records can be selected by id or by their screening verdict, so a review can
export the studies it included rather than everything it looked at. A
bibliography longer than the tool-output budget is written to a file and the
path returned, because a truncated JSON document cannot be parsed by the caller
that asked for it.

### The reviewer

The reviewer exists because an agent that reports its own work is not evidence
that the work was done. It is given four read-only tools and no way to reach
anything else:

- `read_turn` — the ordered text and tool activity of the session under review
- `query_execution_log` — the script, stdout, stderr, and exit status behind one
  run, or the input and output behind one tool call
- `read_artifact` — the stored contents of a published artifact
- `submit_findings` — its only deliverable

It cannot read arbitrary files, run code, or edit anything. That is deliberate:
a reviewer able to recompute stops being able to tell the agent's mistake from
its own. The enforcement is a deny-all followed by the four allows above — the
earlier version denied only `skill` and `os_*`, which left `notebook_run` and
`read` open, so the claim did not hold. Its verdict rule follows the rubric it
is given — a contradiction that was actually retrieved convicts, an absence of
evidence never does.

The gate is keyed on the pair (reviewed session, this reviewer's own session), so
a resubmission by the same reviewer is refused while a second, independent
reviewer of the same turn may file its own. That makes re-auditing possible after
a fix, which keying on the reviewed session alone did not.

OpenCode V2 gives a plugin no client to read a session back, so the turn is
recorded as it happens rather than fetched afterwards.

### Specialists

A specialist is a system prompt plus an allowlist of skills, connectors and
plain tools. The allowlist is written into the agent's permission rules as
deny-all followed by specific allows, so an agent that has only been given
`literature-review` cannot
reach any other skill or any science connector, and cannot be talked into
reaching one. OpenCode V2 has no plugin API for creating an agent, so the
definitions in `specialists/` are rendered to `<config>/agent/*.md` at load time.

These are original to this plugin. Upstream ships the Specialist import
mechanism and an authoring template, but its builtin registry manifest is empty.

## Install

```sh
git clone https://github.com/OWNER/opencode-science.git
cd opencode-science
npm install
npm run sync          # fetch vendored skills, pinned by upstream.lock.json
npm run install:plugin
opencode service restart
```

`install:plugin` copies `src/`, `vendor/`, and `specialists/` into
`~/.config/opencode/plugins/opencode-science/`, which OpenCode discovers
automatically. No entry in `opencode.json` is required. OpenCode does not follow
directory junctions, which is why the plugin is copied rather than linked.

Verify with `npm run verify`, which runs the skill audit, `tsc --noEmit`, every
test suite, a module load check, a check that the vendored files still match
their recorded hashes, and the install.

`npm run sync` is only needed for a fresh clone: the vendored skills are
committed, so the install works without it. Run it to pick up a change
upstream, and review the diff it produces — the vendored files are copies, and
the adaptation to this environment lives in `src/skill-patches.ts`.

## Options

All optional, under `plugins` in `opencode.json`:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-science",
      "options": {
        "skills": true,
        "connectors": true,
        "notebook": true,
        "provenance": true,
        "reviewer": true,
        "specialists": true,
        "python": "py -3",
        "rscript": "Rscript",
        "timeoutMs": 300000,
        "openAlexApiKey": "…",
        "ncbiApiKey": "…",
        "ncbiEmail": "…"
      }
    }
  ]
}
```

Credentials resolve from options first, then `OPENALEX_API_KEY`, `NCBI_API_KEY`,
and `NCBI_EMAIL`. No secret is written into an OpenCode configuration file.

All three are optional, and none of them unlocks a capability:

| Option | Effect when set | Without it |
| --- | --- | --- |
| `ncbiApiKey` | PubMed limit rises from 3 to 10 requests/second | 3 requests/second |
| `ncbiEmail` | Sent as `email` to E-utilities, `mailto` to Crossref, and as the contact address Unpaywall requires | anonymous caller; Unpaywall is skipped, and OpenAlex is the only open-access index consulted |
| `openAlexApiKey` | OpenAlex queries are keyed | keyless search still works |

Configured keys are also forwarded into `notebook_run` as `OPENALEX_API_KEY`,
`NCBI_API_KEY`, `NCBI_EMAIL` and `CONTACT_EMAIL`, because the vendored skills
read their configuration from the environment. Without the forward, the
literature-review helpers raise `RuntimeError` rather than degrade. `/os-status`
reports which keys are in use and where each came from.

All three are optional, because each one improves a request rather than
unlocking it. An NCBI key raises the PubMed limit from 3 to 10 requests a second
and the email identifies the caller; an OpenAlex key moves search into the keyed
pool, which is also what the `literature-review` helpers require before
`search_openalex` or `expand_citations` will run. Configured keys are also
forwarded into `notebook_run`'s environment under the names those helpers read,
so setting one in the plugin options is enough — nothing has to be exported in
the shell. `/os-status` lists which are in use.

Capabilities can be turned off individually: `skills`, `connectors`,
`literature`, `notebook`, `provenance`, `reviewer`, `specialists`.

## Design notes

**`vendor/` stays pristine.** Adaptation happens at load time in
`src/skill-patches.ts`, never by rewriting the vendored files. That keeps
`npm run sync` a clean operation and the whole adaptation reviewable in one
file. Never edit `vendor/` by hand: the next sync would silently overwrite it,
and a hand-edited file no longer matches `upstream.lock.json`.

**The audit is the guard.** `npm run audit` reads the same rewrite table the
plugin uses, so it cannot drift from runtime behaviour. It fails when a skill
references an application-only API that is neither rewritten nor replaced.
Three skills currently carry an adaptation note: `env-management` (no
app-managed runtimes), `figure-composer`, and `paper-narrative`.

**Notebook runs are stateless.** Each run is a fresh interpreter process, so
variables do not survive between calls. This keeps the implementation honest
about state at the cost of no persistent kernel.

**Missing evidence is never inferred.** A provenance record marks anything it
could not observe as `unavailable` with a reason, and anything partly observed
as `partial`. A checksum confirms file identity, not scientific validity.

**Evidence is read from records, not from the caller.** A `runId` that resolves
in the run log supplies the environment, so a hand-written `environmentSummary`
cannot overwrite what actually ran; one that does not resolve is recorded as
unverified rather than as a working pointer to the script. Declared inputs that
cannot be read are named in the record instead of being dropped, and the set
becomes `partial`.

**Stores are written atomically.** The literature library, the screening record
and the artifact index are written beside their target and renamed over it, so
an interrupted write leaves the previous contents intact. A store that exists
but will not parse is reported rather than read as empty — treating corruption
as absence would let the next write replace it.

**Outbound requests are URL-admitted.** Connectors reject non-HTTP(S) schemes and
loopback, link-local, and private addresses, so an identifier taken from model
output cannot redirect a lookup at an internal service.

## Development

```sh
npm run verify        # the whole gate: audit, typecheck, tests, load, vendor check, install
npm run check         # load the module graph outside OpenCode, printing full errors
npm run audit         # report application coupling per vendored skill
npm run check:vendor  # prove the vendored files still match their recorded hashes
npm run sync          # re-fetch upstream, reporting drift against the lock
```

`sync-upstream.mjs` records a sha256 per file in `upstream.lock.json`, so a
second run reports zero drift and an upstream change appears as a diff. It
tries jsDelivr first and falls back to raw.githubusercontent.

The vendored files under `vendor/` are copies and must not be edited by hand.
The adaptation to this environment lives in `src/skill-patches.ts` and is
applied when the skills are loaded, so the next sync stays a clean operation
and the whole change is reviewable in one place. `npm run check:vendor` fails
the build if a vendored file has been edited, because a hand edit would
otherwise be silently discarded by the next sync — or, worse, survive into a
release and diverge from the upstream copy it claims to be.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

## Not implemented

Remote GPU compute, the app-managed environment layer, `.science` package
export, and the specialist marketplace.

Two gaps are worth naming because a skill advertises them:

- **No retraction flag in the connector set.** The `literature-review` skill
  covers retractions, and its `verify_dois` helper reports a `retracted` field
  that is correct — a retracted paper is flagged, a control is not. But no
  plugin tool calls it, so a record screened through the connector set has not
  been checked for retraction. The skill's own note says so.
- **No reference-list export from a single record.** A record's references are
  reachable through `os_literature_citations` and Crossref, but there is no
  "references as a bibliography" output for one paper.

`specialists/` holds three original specialists, rendered to
`<config>/agent/*.md` at load time.

## License

[Apache-2.0](./LICENSE). The vendored skills are Apache-2.0 as well; see
[NOTICE.md](./NOTICE.md) for attribution and the list of what was changed.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Bug reports and feature requests are
welcome through the issue tracker; the design rule the project holds to — that
a record never states more than it knows — is worth reading before proposing a
change.

Security problems should not go in the issue tracker. See
[SECURITY.md](./SECURITY.md).
