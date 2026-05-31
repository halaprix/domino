/**
 * Post-build: rewrite the `ethers-v5` import specifier to `ethers` in the
 * published ethers-v5 engine.
 *
 * The repo depends on `ethers-v5` (an npm alias for ethers@5) so it can install
 * ethers v5 and v6 side by side for testing. Consumers, however, install a single
 * `ethers` (v5 OR v6) under that real name — they have no `ethers-v5` package.
 * So the shipped v5 engine must import from `ethers`, not `ethers-v5`.
 *
 * Only the quoted specifier is replaced (ESM `from "ethers-v5"`, CJS
 * `require("ethers-v5")`, and DTS `import("ethers-v5")`), never bare substrings.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'dist/engines/ethers-v5.js',
  'dist/engines/ethers-v5.cjs',
  'dist/engines/ethers-v5.d.ts',
  'dist/engines/ethers-v5.d.cts',
]

let rewrote = 0
for (const rel of files) {
  const path = join(root, rel)
  if (!existsSync(path)) continue
  const src = readFileSync(path, 'utf8')
  const out = src.replaceAll("'ethers-v5'", "'ethers'").replaceAll('"ethers-v5"', '"ethers"')
  if (out !== src) {
    writeFileSync(path, out)
    rewrote++
  }
}

console.log(`postbuild: rewrote ethers-v5 → ethers in ${rewrote} file(s)`)
