#!/usr/bin/env node
/**
 * Checks that the vendored skills are still byte-identical to upstream.
 *
 * The vendored files are copies. The adaptation that makes them work here
 * lives in src/skill-patches.ts, applied at load time, so that the next
 * upstream sync is a clean operation and the whole change is reviewable in
 * one place. That only holds while nobody edits a file under vendor/ by hand.
 *
 * upstream.lock.json records a sha256 per vendored file, so a hand edit shows
 * up here rather than being silently discarded by the next sync — or, worse,
 * surviving in a release and diverging from the upstream copy it claims to be.
 *
 * Usage: node --experimental-strip-types scripts/check-vendor.mjs
 */

import { createHash } from "node:crypto"
import { readFile, readdir, stat } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const VENDOR = join(ROOT, "vendor")
const LOCK = join(ROOT, "upstream.lock.json")

/** Every file under the vendor tree, relative to it. */
async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await walk(full, base)))
      continue
    }
    out.push(relative(base, full).split(/[\\/]/).join("/"))
  }
  return out
}

async function main() {
  const lock = JSON.parse(await readFile(LOCK, "utf8"))
  const expected = lock.files ?? {}

  const present = await walk(VENDOR)
  const problems = []

  // A file in the tree that the lock does not know about was added by hand.
  for (const path of present) {
    if (!(path in expected)) {
      problems.push(`${path} is in vendor/ but not in upstream.lock.json`)
    }
  }

  // A file the lock knows about that is missing or has been changed.
  let checked = 0
  for (const [path, record] of Object.entries(expected)) {
    const full = join(VENDOR, path)
    try {
      const info = await stat(full)
      if (!info.isFile()) {
        problems.push(`${path} is not a file`)
        continue
      }
      const bytes = await readFile(full)
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (digest !== record.sha256) {
        problems.push(
          `${path} does not match the lock (expected ${record.sha256.slice(0, 12)}, got ${digest.slice(0, 12)})`,
        )
        continue
      }
      if (typeof record.bytes === "number" && bytes.byteLength !== record.bytes) {
        problems.push(`${path} is ${bytes.byteLength} bytes, the lock says ${record.bytes}`)
        continue
      }
      checked += 1
    } catch {
      problems.push(`${path} is in the lock but missing from vendor/`)
    }
  }

  if (problems.length) {
    console.error(`FAIL: the vendored tree does not match upstream.lock.json (${problems.length} problem(s)):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error("")
    console.error("The vendored files are copies. Edit them through src/skill-patches.ts,")
    console.error("which adapts them at load time, and run 'npm run sync' to refetch them.")
    process.exit(1)
  }

  console.log(`OK: ${checked} vendored files match upstream.lock.json byte for byte.`)
}

main().catch((error) => {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
})
