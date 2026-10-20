#!/usr/bin/env node
// Sync vendored Open-Science skills and specialists from the upstream repository.
//
// Upstream is Apache-2.0. This script downloads a pinned set of files through the
// jsDelivr mirror, because direct git access is not always available, and records
// per-file checksums in upstream.lock.json so later runs can report drift.
//
// Usage:
//   node scripts/sync-upstream.mjs            # download missing/changed files
//   node scripts/sync-upstream.mjs --check    # report drift without writing

import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const VENDOR = join(ROOT, "vendor")
const LOCK = join(ROOT, "upstream.lock.json")

const UPSTREAM = {
  owner: "aipoch",
  repo: "open-science",
  ref: "main",
  license: "Apache-2.0",
}

const MIRRORS = [
  (path) => `https://cdn.jsdelivr.net/gh/${UPSTREAM.owner}/${UPSTREAM.repo}@${UPSTREAM.ref}/${path}`,
  (path) => `https://raw.githubusercontent.com/${UPSTREAM.owner}/${UPSTREAM.repo}/${UPSTREAM.ref}/${path}`,
]

// Skills ported from upstream. Tier A skills are self-contained; tier B skills
// referenced host-owned notebook tools and are adapted by patches.ts. Tier C
// skills (self-awareness, customize, skill-creator, remote-compute-ssh) are
// app-coupled and are not ported yet.
const PORTED_SKILLS = [
  "alphafold2",
  "boltz",
  "borzoi",
  "chai1",
  "compute-env-setup",
  "diffdock",
  "env-management",
  "esmfold2",
  "evo2",
  "fair-esm2",
  "figure-composer",
  "figure-style",
  "indication-dossier",
  "ligandmpnn",
  "literature-review",
  "openfold3",
  "paper-narrative",
  "proteinmpnn",
  "scgpt",
  "scvi-tools",
  "solublempnn",
]

const EXTRA_FILES = [
  "packages/connector-builtins/src/catalog.ts",
  "packages/specialists/src/builtin-registry.ts",
  "src/main/skills/activation-policy.ts",
]

// Upstream ships the Specialist import mechanism and an authoring template, but
// its builtin registry manifest is empty (`"specialists": []`). Vendoring it
// keeps the loader pointed at a real upstream layout; the specialists this
// plugin actually installs are authored in `specialists/` and are original work.
const SPECIALIST_FILES = [
  "resources/specialists/manifest.json",
  "resources/specialists/template/v1/README.txt",
]

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex")

async function fetchWithMirrors(path, attempts = 2) {
  let lastError
  for (const build of MIRRORS) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(build(path), {
          signal: AbortSignal.timeout(60_000),
          headers: { "user-agent": "opencode-science-sync" },
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
      } catch (error) {
        lastError = error
      }
    }
  }
  throw new Error(`could not fetch ${path}: ${lastError?.message ?? "unknown error"}`)
}

async function loadLock() {
  if (!existsSync(LOCK)) return { version: 1, files: {} }
  return JSON.parse(await readFile(LOCK, "utf8"))
}

/**
 * Resolves the upstream branch to a commit id.
 *
 * The per-file hashes already prove what is vendored, but on their own they
 * only fix content, not provenance: `ref` is a branch name, so the same lock
 * describes two different upstream states over time. Recording the commit
 * makes the lock reproducible and lets a later run say what changed.
 *
 * A failed lookup is not fatal. The hashes remain authoritative; the commit is
 * simply carried forward from the previous lock when one exists.
 */
async function resolveCommit() {
  const url = `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/commits/${UPSTREAM.ref}`
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "opencode-science-sync" },
      signal: AbortSignal.timeout(45_000),
    })
    if (!response.ok) return undefined
    const body = await response.json()
    return typeof body?.sha === "string" ? body.sha : undefined
  } catch {
    return undefined
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check")
  const lock = await loadLock()
  // Carry the previous commit forward when the lookup fails, so an offline run
  // does not erase the record of which upstream state was vendored.
  const commit = (await resolveCommit()) ?? lock.commit
  const next = { version: 1, upstream: UPSTREAM, ...(commit ? { commit } : {}), files: {} }

  // Discover the upstream file list for the skills we port.
  let inventory
  const cached = join(ROOT, ".skill-files.json")
  if (existsSync(cached)) {
    inventory = JSON.parse(await readFile(cached, "utf8"))
  } else {
    const response = await fetch(
      `https://api.github.com/repos/${UPSTREAM.owner}/${UPSTREAM.repo}/git/trees/${UPSTREAM.ref}?recursive=1`,
      { headers: { "user-agent": "opencode-science-sync" }, signal: AbortSignal.timeout(90_000) },
    )
    const tree = await response.json()
    inventory = tree.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path)
    await writeFile(cached, JSON.stringify(inventory, null, 1))
  }

  const wanted = new Set()
  for (const path of inventory) {
    if (!path.startsWith("resources/skills/")) continue
    const parts = path.split("/")
    if (parts.length < 4) continue
    if (PORTED_SKILLS.includes(parts[2])) wanted.add(path)
  }
  for (const path of EXTRA_FILES) wanted.add(path)
  for (const path of SPECIALIST_FILES) wanted.add(path)

  const skillsManifest = inventory.find((p) => p === "resources/skills/manifest.json")
  if (skillsManifest) wanted.add(skillsManifest)

  let downloaded = 0
  let unchanged = 0
  const changed = []
  const failed = []

  for (const upstreamPath of [...wanted].sort()) {
    let buffer
    try {
      buffer = await fetchWithMirrors(upstreamPath)
    } catch (error) {
      failed.push({ path: upstreamPath, error: error.message })
      continue
    }

    const digest = sha256(buffer)
    const target = join(VENDOR, upstreamPath)
    const previous = lock.files[upstreamPath]

    // In sync requires all three: upstream still matches the lock, the file is
    // present, and the bytes on disk still match the lock. Checking only the
    // lock would leave a locally edited file in place forever, which is exactly
    // what happens if something writes to vendor/ by mistake.
    const present = existsSync(target)
    const diskDigest = present ? sha256(await readFile(target)) : undefined
    const inSync = previous?.sha256 === digest && present && diskDigest === digest

    if (inSync) unchanged += 1
    else changed.push(upstreamPath)
    next.files[upstreamPath] = { sha256: digest, bytes: buffer.byteLength }

    if (!checkOnly && !inSync) {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, buffer)
      downloaded += 1
    }
  }

  if (!checkOnly) {
    // The commit says which upstream state this lock was taken from. The file
    // hashes still prove the content; the commit makes the lock reproducible
    // instead of a snapshot of whatever `main` happened to be at the time.
    await writeFile(LOCK, JSON.stringify(next, null, 2) + "\n")
  }

  console.log(`upstream: ${UPSTREAM.owner}/${UPSTREAM.repo}@${UPSTREAM.ref}`)
  console.log(`commit  : ${next.commit ?? "unresolved (hashes remain authoritative)"}`)
  console.log(`tracked files : ${wanted.size}`)
  console.log(`downloaded    : ${downloaded}`)
  console.log(`unchanged     : ${unchanged}`)
  console.log(`drifted       : ${changed.length}`)
  if (failed.length) {
    console.log(`failed        : ${failed.length}`)
    for (const item of failed.slice(0, 10)) console.log(`  - ${item.path}: ${item.error}`)
    process.exitCode = 1
  }
  if (checkOnly && changed.length) {
    console.log("\nchanged files:")
    for (const path of changed) console.log(`  ${path}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})