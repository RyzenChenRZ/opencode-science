import { readdir, readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { patchSkill } from "./skill-patches.ts"

/**
 * Loads the vendored Open-Science skills and adapts them for OpenCode.
 *
 * Skills are registered by pointing at their file on disk, so the
 * directory-relative references inside each SKILL.md (`references/`,
 * `kernel.py`, — keep resolving when the model reads them.
 *
 * The upstream catalogue marks a few skills as always-on (they describe the
 * ambient environment rather than a task) and a few as internal (implementation
 * detail, not for the model's list). Both flags are preserved.
 */

export type SkillInfo = {
  id: string
  name: string
  description: string
  path: string
  content: string
  directory: string
  /** Upstream `activationPolicy: always-on`. */
  alwaysOn: boolean
  /** Upstream `exposure: internal`. */
  hidden: boolean
  license?: string
}

export type CatalogEntry = {
  id: string
  name: string
  source: string
  activationPolicy?: string
  exposure?: string
  updatedAt: string
}

export type Catalog = { version: number; skills: CatalogEntry[] }

/** Splits YAML-ish frontmatter without a YAML dependency. */
function frontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const out: Record<string, string> = {}
  let key: string | undefined
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line)
    if (pair) {
      key = pair[1]
      out[key] = pair[2].trim()
    } else if (key && /^\s+\S/.test(line)) {
      // Nested metadata block: keep appending so a description is not truncated.
      out[key] = `${out[key]} ${line.trim()}`.trim()
    }
  }
  return out
}

/** Removes frontmatter so the model receives the body only. */
function body(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart()
}

export type LoadResult = {
  skills: SkillInfo[]
  skipped: { id: string; reason: string }[]
  catalog?: Catalog
}

/**
 * Reads every vendored skill, applies the runtime patch, and returns entries
 * ready for the skill editor.
 */
export async function loadSkills(root: string): Promise<LoadResult> {
  const catalog = await readCatalog(join(root, "resources", "skills", "manifest.json"))
  const byId = new Map((catalog?.skills ?? []).map((s) => [s.id, s]))

  let dirs: string[]
  try {
    dirs = (await readdir(join(root, "resources", "skills"), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch (error) {
    return { skills: [], skipped: [{ id: root, reason: `vendor directory unreadable: ${(error as Error).message}` }] }
  }

  const skills: SkillInfo[] = []
  const skipped: { id: string; reason: string }[] = []

  for (const id of dirs) {
    const directory = join(root, "resources", "skills", id)
    const path = join(directory, "SKILL.md")
    let raw: string
    try {
      raw = await readFile(path, "utf8")
    } catch (error) {
      skipped.push({ id, reason: `SKILL.md unreadable: ${(error as Error).message}` })
      continue
    }

    const patched = patchSkill(id, raw)
    const meta = frontmatter(patched)
    const entry = byId.get(id)
    const description = meta.description || entry?.name || id
    if (!description) {
      skipped.push({ id, reason: "no description in frontmatter or catalogue" })
      continue
    }

    skills.push({
      id,
      name: meta.name || entry?.name || id,
      description,
      path,
      content: body(patched),
      directory,
      alwaysOn: entry?.activationPolicy === "always-on",
      hidden: entry?.exposure === "internal",
      ...(meta.license ? { license: meta.license } : {}),
    })
  }

  skills.sort((a, b) => a.id.localeCompare(b.id))
  return { skills, skipped, ...(catalog ? { catalog } : {}) }
}

async function readCatalog(path: string): Promise<Catalog | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Catalog
  } catch {
    return undefined
  }
}

/**
 * Builds the short catalogue injected into the system prompt.
 *
 * Upstream keeps always-on skills resident so the ambient environment is always
 * described. OpenCode has no equivalent flag, so the list is injected through
 * the context hook: a title, one line of intent, and a pointer to the rest.
 */
export function renderAlwaysOnCatalogue(skills: SkillInfo[]): string {
  const alwaysOn = skills.filter((s) => s.alwaysOn)
  if (!alwaysOn.length) return ""
  return [
    "<opencode-science-skills>",
    "These skills are always available in this project. Load one with the `skill` tool using",
    "its id when the task at hand matches its scope:",
    ...alwaysOn.map((s) => `- \`${s.id}\` —${firstSentence(s.description)}`),
    "</opencode-science-skills>",
  ].join("\n")
}

function firstSentence(text: string): string {
  const line = text.split(/\r?\n/)[0].trim()
  const stop = line.search(/[.!?](\s|$)/)
  return stop > 40 ? line.slice(0, stop + 1) : line
}

export { basename }