# Contributing

Thank you for looking at this. A few things about the shape of the project will
save you time.

## What this is

A plugin for [OpenCode](https://opencode.ai) V2 that gives an agent a scientific
research workbench: 21 vendored skills from an upstream open-source project,
read-only connectors to the bibliographic and biological databases, notebook
execution against the interpreter the user already has, an immutable artifact
ledger with provenance records, and a literature workflow that searches, screens
and exports.

The code is TypeScript, run by OpenCode's plugin host. It has one runtime
dependency (`@opencode/plugin`) and one dev dependency (TypeScript).

## Getting set up

```sh
git clone https://github.com/<owner>/opencode-science.git
cd opencode-science
npm install
npm run verify
```

`npm run verify` is the gate: it audits the vendored skills, type-checks,
runs every test, loads the module graph, and installs the plugin into
`~/.config/opencode/plugins/opencode-science/`.

### What the test suite needs

The tests run in the user's own interpreter, so they need Python on the path.
The static analysers and the PDF extractor use only the standard library, so
any Python 3.8 or newer will do.

Two of the test scripts need more:

- `scripts/test-pdf-extract.py` builds its own probe document, so it needs
  `matplotlib`, and a PDF reader (`pymupdf`, `pypdf`, `pdfminer` or
  `pdfplumber`) for the extractor to use.
- `scripts/test-r-effects.py` needs `Rscript`. If R is not installed it prints
  that the R analyser was skipped and exits successfully — announced rather
  than silent, because a green run that quietly tested nothing is worse than a
  loud one. CI installs R, so the analyser is exercised there.

Node 22 or newer is required: the plugin is loaded with Node's type stripping,
and the source is written as TypeScript that Node runs directly.

## The commands

| Command | What it does |
| --- | --- |
| `npm run verify` | Everything below, in order. This is what CI runs. |
| `npm run audit` | Reports which vendored skills still refer to application-owned tools, and which are adapted |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | All seven test suites |
| `npm run check` | Loads the module graph outside OpenCode, printing full errors |
| `npm run install:plugin` | Copies the plugin into OpenCode's plugin directory |
| `npm run sync` | Re-fetches the vendored skills from upstream and reports drift against the lock |

## The vendored skills

`vendor/` holds 21 skills copied byte-identically from
[aipoch/open-science](https://github.com/aipoch/open-science) (Apache-2.0).
They are **not** edited in place. The upstream project has its own tool
surface — an MCP server with fixed tool names, and a `host.*` Python API
inside a managed kernel — and neither exists here.

So the adaptation lives in `src/skill-patches.ts`, which rewrites the
application-owned names to what this plugin actually registers, and inserts a
short note into the nine skills whose workflow depends on something
unavailable. `npm run audit` fails the build if a skill refers to a name that
is neither rewritten nor replaced.

**Do not edit a file under `vendor/`.** The next `npm run sync` will overwrite
it, and `upstream.lock.json` records a sha256 per file so drift is visible.

To add a skill from upstream, add it to `PORTED_SKILLS` in
`scripts/sync-upstream.mjs`, run `npm run sync`, and check what `npm run audit`
says about it.

## The shape of the code

| Directory | What lives there |
| --- | --- |
| `src/` | The plugin. `index.ts` is the entry point and registers everything. |
| `src/literature/` | The library, screening, PDF text layer, acquisition, citation network, and export |
| `src/notebook-analysis/` | The Python and R static analysers that determine a script's file effects |
| `specialists/` | Three subagent definitions, rendered to `<config>/agent/*.md` at load time |
| `vendor/` | The upstream skills, byte-identical |
| `scripts/` | Tests, the upstream sync, the installer, the audit |

Two conventions are worth knowing before you change something:

- **A record never states more than it knows.** Where a fact could not be
  established, it is reported as unavailable with a reason, rather than
  inferred. This runs through the whole codebase: an evidence mode that cannot
  be supported is refused rather than recorded, an unverified document is not
  attached to a record, an override for a record that is not in the library is
  refused. If you add a capability, keep that property.
- **The plugin is read-only about the world.** Connectors fetch; they never
  write to a service. The only files the plugin writes are the ones it owns in
  the workspace, and the only commands it runs are the user's own interpreter
  and the static analysers shipped alongside it.

## Pull requests

1. Open an issue first for anything larger than a fix, so the approach can be
   agreed before the work.
2. Keep a change to one thing. A fix and a refactor in the same commit are
   hard to review and hard to revert.
3. Add a test that fails without your change. Every bug fixed in this project
   came with a regression test, and several of them are the only thing that
   would catch a repeat.
4. Run `npm run verify` before pushing.
5. Write the commit message in the imperative: "Refuse an override for a
   record that is not in the library", not "Fixed override bug".

## Reporting a security problem

Please do not open a public issue. See [SECURITY.md](./SECURITY.md).

## License

Apache-2.0. The vendored skills are Apache-2.0 as well; see
[NOTICE.md](./NOTICE.md) for attribution and the list of what was changed.
