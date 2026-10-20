#!/usr/bin/env node
// Audits vendored skills for dependence on the upstream desktop application.
//
// Skills copied from upstream name tools that exist only inside that
// application: its MCP tool names and the `host.*` Notebook Python API.
// src/skill-patches.ts rewrites every such name at load time. This audit reads
// that same table, so it cannot drift from what the plugin actually does, and
// fails when a skill references something neither rewritten nor replaced.
//
// Usage:
//   node --experimental-strip-types scripts/audit-skills.mjs

import { readdir, readFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// The plugin's own rewrite table is the authority for what is handled.
const { TOOL_RENAMES, HOST_RENAMES, PATCHED_SKILLS } = await import("../src/skill-patches.ts")

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const SKILLS = join(ROOT, "vendor", "resources", "skills")

/** Application-owned MCP tool names, from upstream app-mcp-names.ts. */
const APP_TOOLS = [
  "begin_activity_group",
  "write_artifact_file",
  "ask_user_question",
  "notebook_execute",
  "repl_execute",
  "bash_execute",
  "request_network_access",
  "notebook_state",
  "list_notebook_runtimes",
  "notebook_bind_runtime",
  "notebook_switch_runtime",
  "notebook_restart",
  "notebook_shutdown",
  "inspect_packages",
  "manage_packages",
  "manage_environments",
  "list_memory_categories",
  "search_memories",
  "request_skill_import",
  "generate_plan",
  "update_step_status",
  "read_document",
  "list_pdf_elements",
  "read_pdf_element",
  "search_library",
  "read_library_abstract",
  "read_library_pdf",
  "format_references",
  "format_citation_document",
  "prepare_latex_bundle",
  "save_to_inbox",
  "acquire_pdf",
  "send_message",
]

const TOOL_PATTERN = new RegExp(`\\b(${APP_TOOLS.join("|")})\\b`, "g")
const HOST_PATTERN = /\bhost\.[a-zA-Z][a-zA-Z0-9_]*/g

const patched = new Set(PATCHED_SKILLS)
const handled = new Set([...Object.keys(TOOL_RENAMES), ...Object.keys(HOST_RENAMES)])

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (/\.(md|py)$/i.test(entry.name)) out.push(path)
  }
  return out
}

async function main() {
  if (!existsSync(SKILLS)) {
    console.error(`no vendored skills at ${SKILLS}; run scripts/sync-upstream.mjs first`)
    process.exit(1)
  }

  const findings = []
  for (const skill of (await readdir(SKILLS, { withFileTypes: true })).filter((e) => e.isDirectory())) {
    const found = new Set()
    for (const file of await walk(join(SKILLS, skill.name))) {
      const text = await readFile(file, "utf8")
      for (const m of text.matchAll(TOOL_PATTERN)) found.add(m[1])
      for (const m of text.matchAll(HOST_PATTERN)) found.add(m[0])
    }
    findings.push({ id: skill.name, found: [...found].sort(), isPatched: patched.has(skill.name) })
  }

  findings.sort((a, b) => b.found.length - a.found.length)

  console.log("skill                 patched  application references rewritten")
  console.log("-".repeat(96))
  for (const f of findings) {
    if (!f.found.length) continue
    console.log(`${f.id.padEnd(22)} ${(f.isPatched ? "yes" : "NO").padEnd(8)}  ${f.found.join(", ")}`)
  }

  const problems = []
  for (const f of findings) {
    const unexpected = f.found.filter((name) => !handled.has(name))
    if (unexpected.length) {
      problems.push(`${f.id}: ${unexpected.join(", ")} — absent from the rewrite table`)
    } else if (!f.isPatched && f.found.length) {
      problems.push(`${f.id}: references ${f.found.length} name(s) but has no patch entry`)
    }
  }

  const clean = findings.filter((f) => !f.found.length)
  console.log("")
  if (problems.length) {
    console.error("FAIL: unhandled application references")
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }

  const withNotes = findings.filter((f) => f.isPatched && f.found.length)
  const noteOnly = findings.filter((f) => f.isPatched && !f.found.length)
  console.log(
    `OK: ${findings.length} skills audited. ${clean.length - noteOnly.length} need no adaptation; ` +
      `${withNotes.length} are rewritten and carry an adaptation note` +
      (noteOnly.length
        ? `; ${noteOnly.length} carry an adaptation note without a rewrite (${noteOnly.map((f) => f.id).join(", ")}).`
        : "."),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})