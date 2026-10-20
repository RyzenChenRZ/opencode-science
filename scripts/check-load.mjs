#!/usr/bin/env node
// Loads the plugin module outside OpenCode so module-resolution and syntax
// errors print in full instead of being truncated into the server log.
//
// Usage:
//   node --experimental-strip-types scripts/check-load.mjs [entry]

import { pathToFileURL } from "node:url"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const entry = process.argv[2] ?? join(ROOT, "src", "index.ts")

try {
  const mod = await import(pathToFileURL(entry).href)
  const plugin = mod.default
  if (!plugin || typeof plugin !== "object") {
    console.error("FAIL: default export is not an object")
    process.exit(1)
  }
  console.log("ok  entry      ", entry)
  console.log("ok  plugin id  ", plugin.id)
  console.log("ok  setup      ", typeof plugin.setup)
  if (typeof plugin.setup !== "function") {
    console.error("FAIL: setup is not a function")
    process.exit(1)
  }
  console.log("LOAD OK")
} catch (error) {
  console.error("LOAD FAILED:", error?.message ?? error)
  const details = error?.errors ?? []
  if (Array.isArray(details) && details.length) {
    console.error(`\n${details.length} build error(s):`)
    for (const detail of details.slice(0, 10)) {
      console.error("-", detail?.text ?? detail?.message ?? JSON.stringify(detail).slice(0, 300))
      if (detail?.location?.file) console.error("  at", detail.location.file)
    }
  }
  if (process.env.DEBUG) console.error(error)
  process.exit(1)
}