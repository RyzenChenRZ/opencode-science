import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Converts upstream Specialist definitions into OpenCode agent definitions.
 *
 * A Specialist is a system prompt plus an explicit allowlist of skills,
 * connectors and plain tools. `loadSpecialists` takes the directory holding one
 * `<id>/specialist.json` per specialist, not a repository root. OpenCode
 * expresses the same thing with an agent file whose `permissions` list denies
 * everything and then re-allows the named items, so the Specialist's declared
 * scope is an enforcement boundary rather than a suggestion.
 *
 * Tool permission actions in OpenCode V2 are `<server>_<tool>`, so a connector
 * id becomes an `os_<id>_*` wildcard.
 */

export type Specialist = {
  name: string
  displayName?: string
  description: string
  systemPrompt: string
  skillIds: string[]
  connectorIds: string[]
  /**
   * Non-science tools the specialist may call, by exact action name.
   *
   * This exists because the deny-all is real. Without it the reviewer inherited
   * `notebook_run` and `read` from the base policy and could recompute the very
   * work it was auditing, which is what it exists to avoid.
   */
  toolIds: string[]
}

export type LoadedSpecialists = {
  specialists: Specialist[]
  skipped: { name: string; reason: string }[]
}

export async function loadSpecialists(dir: string): Promise<LoadedSpecialists> {
  const specialists: Specialist[] = []
  const skipped: { name: string; reason: string }[] = []

  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return { specialists, skipped }
  }

  for (const name of names) {
    try {
      const raw = await readFile(join(dir, name, "specialist.json"), "utf8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      for (const field of ["name", "description", "system_prompt"]) {
        if (typeof parsed[field] !== "string" || !parsed[field]) {
          throw new Error(`missing or non-string field "${field}"`)
        }
      }
      specialists.push({
        name: String(parsed.name),
        ...(typeof parsed.display_name === "string" ? { displayName: parsed.display_name } : {}),
        description: String(parsed.description),
        systemPrompt: String(parsed.system_prompt),
        skillIds: Array.isArray(parsed.skill_ids) ? (parsed.skill_ids as string[]) : [],
        connectorIds: Array.isArray(parsed.connector_ids) ? (parsed.connector_ids as string[]) : [],
        toolIds: Array.isArray(parsed.tool_ids) ? (parsed.tool_ids as string[]) : [],
      })
    } catch (error) {
      skipped.push({ name, reason: (error as Error).message })
    }
  }

  return { specialists, skipped }
}

export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" }

/**
 * Builds the permission rules that scope a Specialist.
 *
 * OpenCode V2 permission semantics that this depends on:
 *   - a rule is `{action, resource, effect}`; the last matching rule wins;
 *   - agent rules are appended after the base policy, so a deny here is not
 *     reordered away by the default `{"action":"*","resource":"*","allow"}`;
 *   - a tool's action is the full `<server>_<tool>` name and its resource is
 *     always `*`. The resource carries the value being acted on (a path, a
 *     command, a URL) or the skill id, never a tool-name suffix.
 *
 * The opening rule denies everything rather than naming the categories to
 * exclude. Denying `skill` and `os_*` left every other tool open: the reviewer
 * was granted `notebook_run` and `read` by the base policy and could recompute
 * the work it was auditing, which is the one thing an independent reviewer must
 * not be able to do. A deny-all only works if the allows that follow name
 * everything the specialist legitimately needs, so `toolIds` is that list.
 */
export function specialistPermissions(specialist: Specialist): PermissionRule[] {
  const rules: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }]
  for (const skill of specialist.skillIds) {
    rules.push({ action: "skill", resource: skill, effect: "allow" })
  }
  for (const connector of specialist.connectorIds) {
    rules.push({ action: `os_${connector}_*`, resource: "*", effect: "allow" })
  }
  for (const tool of specialist.toolIds) {
    rules.push({ action: tool, resource: "*", effect: "allow" })
  }
  return rules
}

/** Renders a Specialist as an OpenCode agent Markdown file. */
export function renderAgentFile(specialist: Specialist): string {
  const permissions = specialistPermissions(specialist)
    .map((rule) => `  - action: ${yamlString(rule.action)}\n    resource: ${yamlString(rule.resource)}\n    effect: ${rule.effect}`)
    .join("\n")

  const scope: string[] = []
  if (specialist.skillIds.length) scope.push(`- skills: ${specialist.skillIds.join(", ")}`)
  if (specialist.connectorIds.length) scope.push(`- connectors: ${specialist.connectorIds.join(", ")}`)
  if (specialist.toolIds.length) scope.push(`- tools: ${specialist.toolIds.join(", ")}`)
  scope.push("- every other tool, skill and science connector is denied by the rules above")

  // Composed first, quoted second. Quoting each fragment separately left the
  // `Read-only: it reports findings...` colon outside the quotes, so a strict
  // YAML parser read the description as a nested mapping and two of the three
  // agent files failed to parse.
  const description = `${specialist.displayName ?? specialist.name} — ${specialist.description}`

  return [
    "---",
    `description: ${yamlString(description)}`,
    "mode: subagent",
    "permissions:",
    permissions,
    "---",
    "",
    specialist.systemPrompt.trim(),
    "",
    "<specialist_scope>",
    "This agent may use only the following science capabilities:",
    ...scope,
    "</specialist_scope>",
    "",
  ].join("\n")
}

/**
 * Quotes a scalar for YAML when it would otherwise not be one.
 *
 * The test is applied to the whole composed value, never to a fragment, and it
 * covers every way a plain scalar can end: leading indicator, an interior
 * `: `, an interior ` #`, trailing whitespace, or a value that is empty.
 */
function yamlString(value: string): string {
  const needsQuote =
    value === "" ||
    /^[\s>|*&!%@`{}[\],#?:-]/.test(value) ||
    /[:#]\s/.test(value) ||
    /\s$/.test(value) ||
    /\n/.test(value)
  if (!needsQuote) return value
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
}

/** Agent ids must be path-like and stable, so they are normalised here. */
export function agentId(specialist: Specialist): string {
  const slug = specialist.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return `science-${slug}`
}