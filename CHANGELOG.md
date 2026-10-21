# Changelog

All notable changes to this project are recorded here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-20

First public release.

### Added

**Capabilities**

- 21 vendored skills from [aipoch/open-science][upstream], adapted at load
  time rather than edited in place. Nine of them carry an explicit note about
  what this environment cannot do, so an agent following one is told rather
  than left to infer.
- Seven read-only database connectors: PubMed, OpenAlex, Crossref, UniProt,
  Zenodo, ClinicalTrials.gov, Cellosaurus. Anonymous by default; an optional
  key raises a rate limit or moves a request into a faster pool.
- A literature library that stores what a search returns, deduplicates it
  across sources by identifier, and applies a collection rule to it.
  Screening verdicts are three-valued — `match`, `no-match`, `uncertain` —
  and a structured check that passes is never an automatic match.
- Document acquisition: `os_literature_fetch_pdf` finds an open-access copy
  through Unpaywall, OpenAlex, or arXiv, verifies the download is really a
  PDF rather than a bot-block page, and attaches it only if the text matches
  the record's DOI or title.
- A citation network: `os_literature_citations` returns the works a paper
  cites and the works that cite it, read from separate sources, with the
  source's own totals reported.
- Bibliography export as BibTeX, RIS, or CSL-JSON, selectable by identifier
  or by screening verdict.
- Notebook execution in the user's own Python or R, with every run logged, and
  a static analyser in each language that determines a script's file effects.
- An artifact ledger: `publish_artifact` records an immutable, checksummed
  version of a result file with the code that produced it, its input files,
  and the environment. Evidence that could not be recorded is marked
  unavailable with a reason rather than inferred.
- An independent review agent with four read-only tools, denied everything
  else by rule rather than by suggestion.
- Three subagents whose skill and connector allowlists are enforced.

**Tooling**

- `npm run verify` as a single gate: a skill audit, a type check, seven test
  suites, a module-graph load, a vendored-tree integrity check, and an
  install.
- `scripts/check-vendor.mjs`, which proves the vendored files are still
  byte-identical to the copies recorded in `upstream.lock.json`.
- `npm run sync`, which refetches the vendored skills and reports drift.

### Notes

- Not affiliated with AIPOCH. See [NOTICE.md](NOTICE.md).
- Remote GPU compute, an app-managed environment layer, `.science` package
  export, and the specialist marketplace are not implemented.

[upstream]: https://github.com/aipoch/open-science
[Unreleased]: https://github.com/RyzenChenRZ/opencode-science/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/RyzenChenRZ/opencode-science/releases/tag/v0.1.0
