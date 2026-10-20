opencode-science
Copyright 2026 opencode-science contributors

This product includes software developed as part of an open-source scientific
research workbench by AIPOCH (https://github.com/aipoch/open-science, the
"Upstream"), licensed under the Apache License, Version 2.0.

The following components are redistributed here without modification, as
byte-identical copies fetched by scripts/sync-upstream.mjs:

  vendor/resources/skills/**        21 skill documents and their supporting files
                                    (SKILL.md, kernel.py, references/)
  vendor/resources/skills/manifest.json
  vendor/resources/specialists/**   the Specialist import manifest and authoring
                                    template. The builtin registry manifest is
                                    empty upstream, so no Specialist definitions
                                    come from there.
  vendor/packages/specialists/src/builtin-registry.ts
  vendor/packages/connector-builtins/src/catalog.ts
  vendor/src/main/skills/activation-policy.ts

They are redistributed under the Apache License, Version 2.0. Each SKILL.md
retains its own `license` and `metadata.third_party` frontmatter describing the
data services it queries.

The connector catalogue text is redistributed unmodified; the implementations in
src/connectors.ts are original work that query the same public APIs.

Modifications made by this project:

  - Skills are adapted at runtime, not on disk. src/skill-patches.ts rewrites
    references to the Upstream application's MCP tool names and `host.*` Notebook
    API to their OpenCode equivalents, and inserts an explicit note listing the
    capabilities that do not exist here. See PATCHED_SKILLS in that file.
  - src/ implements the capability layer against OpenCode V2: skill registration,
    read-only connector tools, interpreter execution, and artifact provenance.
  - specialists/ contains three Specialist definitions authored by this project,
    not taken from Upstream. Upstream ships the Specialist import mechanism and an
    authoring template, but its builtin registry manifest is empty, so there was
    nothing to vendor. src/specialists.ts and src/specialist-agents.ts convert them
    into OpenCode agent files with an enforced permission allowlist.
  - src/literature/ implements the literature workflow from Upstream's
    literature-citations, literature-discovery, literature-library, and
    literature-screening packages: identifier normalization, the bibliographic
    record shape, the revision-counted metadata completion protocol, the
    three-part collection rule, and the three-valued verdict. The structured
    pre-screen in prescreen.ts is original to this project: Upstream sends the
    whole rule to a model classifier, while here the decidable part of a rule is
    evaluated deterministically so a model is only asked about the remainder.
  - src/reviewer-tools.ts and src/turn-recorder.ts implement the reviewer's evidence
    tools. The rubric in src/reviewer-rubric.ts is adapted from Upstream's
    reviewer system-prompt append: its core discipline (trace rather than
    recompute, a retrieved contradiction convicts, an unfound source never does,
    fabricated external references are the exception) is preserved, and the
    phase-specific tool names it assumed are replaced with the tools registered here.
  - src/reviewer-rubric.ts adapts the Upstream reviewer's system-prompt append:
    its evidence rules, fail criteria, and output contract are preserved, and the
    phase-specific omissions that do not apply here are dropped.
  - specialists/ is original to this project. The three definitions and the
    loader that renders them to OpenCode agent files are written here; Upstream
    supplies the file format and the empty registry they extend.
  - src/reviewer-tools.ts, src/turn-recorder.ts, and src/specialist-agents.ts are
    original. They exist because OpenCode V2 gives a plugin no client to read a
    session back and no API to create an agent.

Trademarks: This project is not affiliated with, endorsed by, or sponsored by
AIPOCH. Upstream product names and marks are used only to identify the origin of
the redistributed files.

Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
