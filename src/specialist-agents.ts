/**
 * Writes the plugin's specialists out as OpenCode agent files.
 *
 * OpenCode discovers subagents as Markdown under `<config>/agent/*.md`, and
 * there is no plugin API for adding one: `agent.transform` can update, remove,
 * and re-default an existing agent but cannot create a new id. Rendering the
 * specialist to a file is therefore the only way the declared skill and
 * connector allowlist can become an enforcement boundary rather than a
 * suggestion.
 *
 * The rendered rules are appended after OpenCode's base policy, and the last
 * matching rule wins, so a leading deny-all here is not reordered away by the
 * default `{"action":"*","resource":"*","allow"}`.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { loadSpecialists, renderAgentFile, agentId, type Specialist } from "./specialists.ts"

/** Agent files this plugin owns, so a removed specialist stops being offered. */
const MANAGED_MARKER = "<!-- generated-by: opencode-science -->"

/**
 * Writes one agent file per specialist.
 *
 * Returns the agent ids registered, and any specialist that could not be
 * loaded with the reason. A specialist whose skills or connectors name
 * something this plugin does not register is still written: the deny-all and
 * the allow then simply do not correspond to anything, which is visible in the
 * rendered scope block rather than silently narrowing the agent.
 */
export async function installSpecialistAgents(
  specialistRoot: string,
  agentDir: string,
): Promise<{ registered: string[]; skipped: { name: string; reason: string }[] }> {
  const { specialists, skipped } = await loadSpecialists(specialistRoot)
  if (!specialists.length) return { registered: [], skipped }

  await mkdir(agentDir, { recursive: true })

  const registered: string[] = []
  for (const specialist of specialists) {
    const id = agentId(specialist)
    const file = join(agentDir, `${id}.md`)
    await writeFile(file, `${renderAgentFile(specialist)}\n${MANAGED_MARKER}\n`, "utf8")
    registered.push(id)
  }

  // A specialist deleted from the source would otherwise stay registered
  // forever, since nothing else cleans the agent directory.
  await pruneStaleAgents(agentDir, new Set(registered))

  return { registered, skipped }
}

async function pruneStaleAgents(agentDir: string, keep: Set<string>): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(agentDir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue
    const id = entry.slice(0, -3)
    if (keep.has(id)) continue
    const file = join(agentDir, entry)
    const { readFile, rm } = await import("node:fs/promises")
    try {
      const text = await readFile(file, "utf8")
      if (text.includes(MANAGED_MARKER)) await rm(file, { force: true })
    } catch {
      // A file we cannot read is not ours to delete.
    }
  }
}

export type { Specialist }