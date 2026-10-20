/**
 * Adapts vendored skills to the tools this plugin actually provides.
 *
 * Upstream skills assume an application-owned tool surface: an MCP server with
 * fixed tool names (`notebook_execute`, `write_artifact_file`, ...) plus a
 * `host.*` Python API inside a managed Notebook kernel. Neither exists here.
 *
 * Two rules govern this file:
 *   1. Only rename a name to a tool this plugin actually registers.
 *   2. A workflow that depends on something unavailable is stated as such in an
 *      explicit note, rather than renamed into a procedure that cannot run.
 *
 * Patching at load time rather than rewriting `vendor/` keeps the vendored
 * files byte-identical to upstream, so re-syncing stays a clean operation and
 * the whole adaptation is reviewable here.
 */

const NOTEBOOK_RUN = "notebook_run"
const PUBLISH_ARTIFACT = "publish_artifact"

/**
 * Application tool name -> the tool this plugin registers.
 *
 * Longest names first so `notebook_bind_runtime` cannot be matched by a shorter
 * prefix.
 */
const TOOL_RENAMES: Record<string, string> = {
  notebook_bind_runtime: "the interpreter set in the plugin options",
  notebook_switch_runtime: "the interpreter set in the plugin options",
  list_notebook_runtimes: "`notebook_run`, which reports the interpreter it used",
  notebook_restart: "a new `notebook_run` (each run is a fresh process)",
  notebook_shutdown: "nothing; notebook runs are stateless processes",
  notebook_state: "`/os-status`",
  manage_environments: "the interpreter set in the plugin options",
  manage_packages: "a package install you confirm with the user first",
  inspect_packages: "a version check you run through `notebook_run`",
  write_artifact_file: PUBLISH_ARTIFACT,
  notebook_execute: NOTEBOOK_RUN,
  repl_execute: NOTEBOOK_RUN,
  bash_execute: NOTEBOOK_RUN,
  request_network_access: "an approval prompt",
  ask_user_question: "the `question` tool",
  begin_activity_group: "the `subagent` tool",
  generate_plan: "the todo tool",
  update_step_status: "the todo tool",
  search_library: "a web fetch on the resolved record URL",
  format_references: "a citation you build from verified records",
  format_citation_document: "a citation you build from verified records",
  read_document: "the `read` tool",
  list_pdf_elements: "the `pdf` skill",
  read_pdf_element: "the `pdf` skill",
  read_library_abstract: "a web fetch on the resolved record URL",
  search_memories: "workspace files you can read",
  list_memory_categories: "workspace files you can read",
  request_skill_import: "a project `.opencode/skills` directory",
  send_message: "a reply in the conversation",
}

/** `host.*` members, mapped to the OpenCode equivalent. */
const HOST_RENAMES: Record<string, string> = {
  "host.compute.create": "no remote-compute tool; run locally instead",
  "host.compute.listHosts": "no remote-compute tool",
  "host.compute.listRegistered": "no remote-compute tool",
  "host.compute.listPreferred": "no remote-compute tool",
  "host.compute.details": "no remote-compute tool",
  "host.compute": "no remote-compute tool",
  "host.viewImage": "the `read` tool",
  "host.delegate": "the `subagent` tool",
  "host.submitOutput": "a returned value",
  "host.llm": "the main agent",
  "host.collect": "a returned value",
  "host.artifacts": "`publish_artifact`",
  "host.artifactPath": "the published artifact path",
  "host.lineage": "`/os-provenance`",
  "host.lineage.graph": "`/os-provenance`",
  "host.lineage.get": "`/os-provenance`",
  "host.capabilities": "the tool list",
  "host.help": "the tool list",
  "host.role": "the active agent",
  "host.currentModel": "the session model",
  "host.listModels": "the model list",
  "host.skills.list": "the skill list",
  "host.skills.read": "the skill's SKILL.md",
  "host.skills.publish": "a project `.opencode/skills` directory",
  "host.agents.attachSkill": "an explicit skill load",
  "host.agents.create": "the `subagent` tool",
  "host.agents.listSkills": "the skill list",
  "host.sessions.read": "the session transcript",
  "host.frames": "the conversation tree",
  "host.mcp": "the MCP server list",
}

const REPLACEMENTS: Record<string, string> = { ...TOOL_RENAMES, ...HOST_RENAMES }

/** Longest-first so the most specific name wins. */
const NAMES = Object.keys(REPLACEMENTS).sort((a, b) => b.length - a.length)
const TOOL_PATTERN = new RegExp(
  `\\b(${NAMES.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`,
  "g",
)

/**
 * Rewrites prose only. Fenced blocks and inline spans are left alone, so a code
 * sample that legitimately mentions a name is not silently rewritten.
 */
function rewriteOutsideCode(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  return segments
    .map((segment, index) =>
      index % 2 === 1 ? segment : segment.replace(TOOL_PATTERN, (match) => REPLACEMENTS[match] ?? match),
    )
    .join("")
}

type Note = { heading: string; body: string[] }

const NOTES: Record<string, Note> = {
  "env-management": {
    heading: "Package and environment management",
    body: [
      "There is no app-managed runtime here. The interpreter is the one set in the plugin",
      "options, or the first found on PATH, and every run is a fresh process.",
      "",
      "- A missing import is fixed by installing the package the task needs, not by rewriting",
      "  the analysis to avoid it.",
      "- Ask before installing into a shared or system interpreter; propose a project virtual",
      "  environment when isolation matters.",
      "- Installing into a named environment, selecting a runtime, and the target receipt are",
      "  app concepts with no equivalent here. Do not describe a package as installed unless an",
      "  install command actually ran successfully.",
    ],
  },
  remote_compute: {
    heading: "Remote compute",
    body: [
      "No remote-compute tools are provided, so the job submission workflow below cannot be",
      "followed as written. Run the workload locally with `notebook_run` when it fits in the",
      "available memory; otherwise state what hardware the task needs and stop.",
      "",
      "There is no `host.*` API inside the notebook. Never invent a job id, a queue position, or",
      "a completion status.",
    ],
  },
  figure_pipeline: {
    heading: "Figure and document pipeline",
    body: [
      "Upstream orchestrated these stages across application-owned conversation frames with a",
      "model call between them. Here, carry out each stage explicitly: use the `subagent` tool",
      "for delegated work, `notebook_run` for code, and `publish_artifact` for any result the",
      "user will cite later.",
      "",
      "The review-and-revise loop below is a procedure to follow, not a host capability. Read",
      "images with the `read` tool and record what you actually observed.",
    ],
  },
  literature_review: {
    heading: "Literature tools",
    body: [
      "The DOI and citation helpers in `kernel.py` run unchanged. Load them with `notebook_run`:",
      "exec the file, then call `verify_dois`, `extract_dois` and `crossref_lookup`.",
      "",
      "`search_openalex` and `expand_citations` raise unless `OPENALEX_API_KEY` is set, because",
      "upstream records keyless calls as rejected. That is no longer true of the public API,",
      "and this plugin reaches it without a key. When no key is configured, use",
      "`os_literature_search_openalex` for OpenAlex searches and `os_literature_search` for",
      "PubMed plus OpenAlex in one call, rather than treating the step as unavailable.",
      "",
      "`verify_dois` reports `retracted`; treat it as the retraction check. No plugin tool",
      "performs one, so a record screened without it has not been checked for retraction.",
    ],
  },
}

const SKILL_NOTES: Record<string, keyof typeof NOTES> = {
  "env-management": "env-management",
  "compute-env-setup": "remote_compute",
  "remote-compute-ssh": "remote_compute",
  scgpt: "remote_compute",
  borzoi: "remote_compute",
  evo2: "remote_compute",
  "fair-esm2": "remote_compute",
  "figure-composer": "figure_pipeline",
  "figure-style": "figure_pipeline",
  "paper-narrative": "figure_pipeline",
  "literature-review": "literature_review",
}

const NOTE_MARKER = "<!-- opencode-adaptation -->"

/** Inserts the note directly after the frontmatter block. */
function insertNote(text: string, note: Note): string {
  if (text.includes(NOTE_MARKER)) return text
  const frontmatterEnd = text.indexOf("\n---", 3)
  if (frontmatterEnd < 0) return text
  const insertAt = frontmatterEnd + 4
  const block = [
    "",
    NOTE_MARKER,
    `> **OpenCode adaptation: ${note.heading}.**`,
    ...note.body.map((line) => (line ? `> ${line}` : ">")),
  ].join("\n")
  return `${text.slice(0, insertAt)}\n${block}\n${text.slice(insertAt)}`
}

/** Applies the rewrite and adaptation note registered for a skill id. */
export function patchSkill(skillId: string, text: string): string {
  const rewritten = rewriteOutsideCode(text)
  const noteKey = SKILL_NOTES[skillId]
  return noteKey ? insertNote(rewritten, NOTES[noteKey]) : rewritten
}

/** Skill ids that receive a rewrite and/or an adaptation note. */
export const PATCHED_SKILLS = Object.keys(SKILL_NOTES)

export { rewriteOutsideCode, TOOL_RENAMES, HOST_RENAMES }
