#!/usr/bin/env node
// Installs the plugin into the OpenCode plugin directory.
//
// OpenCode discovers plugin packages as immediate directories under
// <config>/plugins/. It does not follow directory junctions, so the plugin is
// deployed as a real directory rather than linked. Keep this project's
// canonical source in place and re-run this script after changes.
//
// Usage:
//   node scripts/install.mjs [--source <dir>] [--dry-run]

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sourceFlag = process.argv.indexOf("--source")
const SOURCE = sourceFlag >= 0 ? process.argv[sourceFlag + 1] : ROOT
const DRY_RUN = process.argv.includes("--dry-run")

const TARGET = join(homedir(), ".config", "opencode", "plugins", "opencode-science")

/** Directories skipped anywhere in the deployed tree. */
const PRUNED = new Set(["node_modules", ".git", ".DS_Store", "__pycache__"])

// `src` keeps its own layout so the entry's relative imports (`./foo.ts`)
// resolve from inside `src/`. The package entry is written separately as a
// re-export rather than copied, so the module graph has a single home.
const DEPLOY = [
  // The .py and .R files under src/notebook-analysis/ are the static analyzers,
  // run by the user's own interpreter to determine a script's file effects. They
  // have to ship with the plugin or notebook_run cannot attribute its outputs.
  { from: "src", to: "src", include: (name) => name.endsWith(".ts") || name.endsWith(".py") || name.endsWith(".R") },
  { from: "vendor/resources", to: "vendor/resources", include: () => true },
  // Specialist definitions are original to this plugin, not vendored, and are
  // rendered to agent files at load time from SPECIALIST_ROOT.
  { from: "specialists", to: "specialists", include: (name) => name.endsWith(".json") },
]

async function copyTree(from, to, include) {
  await mkdir(to, { recursive: true })
  let copied = 0
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (PRUNED.has(entry.name)) continue
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      // A nested tree is always copied whole: an extension filter meant for
      // files must never prune a directory that contains one.
      copied += await copyTree(source, destination, include)
      continue
    }
    if (!include(entry.name)) continue
    await cp(source, destination)
    copied += 1
  }
  return copied
}

async function countFiles(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += await countFiles(join(dir, entry.name))
    else total += 1
  }
  return total
}

async function main() {
  for (const item of DEPLOY) {
    const from = join(SOURCE, item.from)
    if (!existsSync(from)) {
      console.error(`missing source: ${from}`)
      if (item.from.startsWith("vendor")) console.error("run scripts/sync-upstream.mjs first")
      process.exit(1)
    }
  }

  console.log(`source: ${SOURCE}`)
  console.log(`target: ${TARGET}`)

  if (DRY_RUN) {
    for (const item of DEPLOY) {
      console.log(`  would copy ${item.from} -> ${item.to} (${await countFiles(join(SOURCE, item.from))} files)`)
    }
    return
  }

  // Replace wholesale: a stale file from a previous version would otherwise
  // linger and register tools the current source no longer defines.
  await rm(TARGET, { recursive: true, force: true })
  await mkdir(TARGET, { recursive: true })

  let total = 0
  for (const item of DEPLOY) {
    total += await copyTree(join(SOURCE, item.from), join(TARGET, item.to), item.include)
  }

  const pkg = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(SOURCE, "package.json"), "utf8")))
  await writeFile(
    join(TARGET, "package.json"),
    JSON.stringify(
      { name: "opencode-science", version: pkg.version, private: true, type: "module", main: "./index.ts", exports: { ".": "./index.ts" } },
      null,
      2,
    ) + "\n",
  )

  // OpenCode resolves a plugin directory to ./index.ts. Re-exporting keeps the
  // implementation under src/ with one canonical module graph.
  await writeFile(
    join(TARGET, "index.ts"),
    "// Install entry. OpenCode resolves a plugin directory to this file;\n" +
      "// the implementation lives under ./src so its imports resolve once.\n" +
      'export { default } from "./src/index.ts"\n',
  )

  console.log(`installed ${total + 2} files (${(await countFiles(TARGET))} on disk)`)
  console.log("next: opencode service restart")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})