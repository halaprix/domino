/**
 * Snippet CI (spec D4).
 *
 * Type-checks every published TypeScript example against the BUILT dist
 * types (not src/) so export/declaration drift is caught the same way a
 * consumer would hit it.
 *
 * Sources checked:
 *   - Literal files: docs/snippets/*.ts
 *   - Fenced ```ts / ```typescript blocks extracted from README.md,
 *     MIGRATION.md, and docs/*.md (top-level only — docs/plans/*.md is
 *     internal planning material, not a published doc).
 *
 * Opt-out: a fence immediately preceded (allowing one blank line) by the
 * HTML comment `<!-- snippet: skip -->` is excluded from type-checking.
 * This is for intentionally non-compiling blocks (old-API "before"
 * examples, illustrative pseudo-code). Every skip is logged so the debt
 * stays auditable in CI output.
 *
 * Each fence is materialized as its own module file under .snippets-build/
 * so duplicate top-level identifiers across fences never collide, then
 * `tsc --noEmit -p tsconfig.snippets.json` runs over the whole directory.
 *
 * This script also runs the bundle-size badge drift check (gzips
 * dist/index.js and compares against the README badge value) — see
 * `checkBadge()` below.
 *
 * Anvil execution is intentionally NOT implemented — it's called out as
 * optional in spec D4 and out of scope for this harness.
 */

import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BUILD_DIR = join(ROOT, '.snippets-build')
const SKIP_MARKER = '<!-- snippet: skip -->'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Fence {
  /** 1-based index of this fence among all ts/typescript fences in its source file. */
  index: number
  /** 1-based line of the opening ``` fence marker. */
  startLine: number
  /** 1-based line of the closing ``` fence marker. */
  endLine: number
  content: string
  skipped: boolean
  /** 1-based line of the `<!-- snippet: skip -->` marker, when skipped. */
  skipMarkerLine?: number
}

interface CheckedFile {
  /** Path relative to repo root, for reporting. */
  relPath: string
  fences: Fence[]
}

// ─── Fence extraction ───────────────────────────────────────────────────────

/** Extracts all ```ts / ```typescript fences from markdown source, in order. */
function extractFences(markdown: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let index = 0
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const openMatch = /^```(\S+)?\s*$/.exec(line.trim())
    const lang = openMatch?.[1]

    if (openMatch && (lang === 'ts' || lang === 'typescript')) {
      const startLine = i + 1

      // Skip marker: immediately preceding line, allowing exactly one blank line.
      let skipped = false
      let skipMarkerLine: number | undefined
      let j = i - 1
      if (j >= 0 && (lines[j] ?? '').trim() === '') j -= 1
      if (j >= 0 && (lines[j] ?? '').trim() === SKIP_MARKER) {
        skipped = true
        skipMarkerLine = j + 1
      }

      // Find the closing fence.
      let k = i + 1
      const contentLines: string[] = []
      while (k < lines.length && (lines[k] ?? '').trim() !== '```') {
        contentLines.push(lines[k] ?? '')
        k++
      }
      const endLine = k + 1 // line of the closing ``` (or EOF if unterminated)

      index += 1
      fences.push({
        index,
        startLine,
        endLine,
        content: contentLines.join('\n'),
        skipped,
        ...(skipMarkerLine !== undefined ? { skipMarkerLine } : {}),
      })

      i = k + 1
      continue
    }

    i++
  }

  return fences
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Non-recursive: lists files directly inside `dir` with the given extension. */
function listFiles(dir: string, ext: string): string[] {
  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => join(dir, e.name))
    .sort()
}

function discoverMarkdownFiles(): string[] {
  const files = [join(ROOT, 'README.md'), join(ROOT, 'MIGRATION.md'), ...listFiles(join(ROOT, 'docs'), '.md')]
  return files.filter((f) => {
    try {
      return statSync(f).isFile()
    } catch {
      return false
    }
  })
}

function discoverLiteralSnippets(): string[] {
  return listFiles(join(ROOT, 'docs', 'snippets'), '.ts')
}

// ─── Materialization ────────────────────────────────────────────────────────

function relPath(p: string): string {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p
}

/** Sanitizes a doc's basename into a filesystem-safe module name stem. */
function docStem(mdPath: string): string {
  return basename(mdPath, '.md')
}

interface Manifest {
  generatedFile: string
  sourceFile: string
  sourceLines: string
}

function materialize(): { manifest: Manifest[]; checkedFiles: CheckedFile[]; totalChecked: number; totalSkipped: number } {
  rmSync(BUILD_DIR, { recursive: true, force: true })
  mkdirSync(BUILD_DIR, { recursive: true })

  const manifest: Manifest[] = []
  const checkedFiles: CheckedFile[] = []
  let totalChecked = 0
  let totalSkipped = 0

  // Literal files — copied verbatim, already self-contained modules.
  for (const file of discoverLiteralSnippets()) {
    const dest = join(BUILD_DIR, 'snippets', basename(file))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, readFileSync(file, 'utf8'))
    manifest.push({
      generatedFile: relPath(dest),
      sourceFile: relPath(file),
      sourceLines: 'whole file',
    })
    totalChecked += 1
  }

  // Fenced blocks extracted from markdown docs.
  for (const mdFile of discoverMarkdownFiles()) {
    const markdown = readFileSync(mdFile, 'utf8')
    const fences = extractFences(markdown)
    checkedFiles.push({ relPath: relPath(mdFile), fences })

    const stem = docStem(mdFile)
    for (const fence of fences) {
      if (fence.skipped) {
        totalSkipped += 1
        continue
      }
      const dest = join(BUILD_DIR, `${stem}.fence-${fence.index}.ts`)
      writeFileSync(dest, fence.content + '\n')
      manifest.push({
        generatedFile: relPath(dest),
        sourceFile: relPath(mdFile),
        sourceLines: `${fence.startLine}-${fence.endLine}`,
      })
      totalChecked += 1
    }
  }

  return { manifest, checkedFiles, totalChecked, totalSkipped }
}

// ─── tsc invocation ─────────────────────────────────────────────────────────

function runTsc(): { ok: boolean; output: string } {
  const tscBin = join(ROOT, 'node_modules', '.bin', 'tsc')
  try {
    const output = execFileSync(tscBin, ['--noEmit', '-p', 'tsconfig.snippets.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string }
    return { ok: false, output: (e.stdout ?? '') + (e.stderr ?? '') || e.message }
  }
}

// ─── Badge drift check ──────────────────────────────────────────────────────

const BADGE_RE = /gzip-([^)]+?)-brightgreen/

function measureGzipKb(): number {
  const distFile = join(ROOT, 'dist', 'index.js')
  const contents = readFileSync(distFile)
  const gzipped = gzipSync(contents)
  return gzipped.length / 1024
}

function formatKb(kb: number): string {
  return kb.toFixed(1)
}

function checkBadge(): { ok: boolean; message: string; measuredKb: number; badgeUrl: string } {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const match = BADGE_RE.exec(readme)
  const measuredKb = measureGzipKb()
  const measuredStr = formatKb(measuredKb)
  const expectedUrl = `https://img.shields.io/badge/gzip-${measuredStr}KB-brightgreen`

  if (!match) {
    return {
      ok: false,
      message: `No bundle-size badge found in README.md (expected pattern /${BADGE_RE.source}/).`,
      measuredKb,
      badgeUrl: expectedUrl,
    }
  }

  const rawValue = match[1] ?? ''
  const numericMatch = /^(\d+\.\d)KB$/.exec(rawValue)

  if (!numericMatch) {
    return {
      ok: false,
      message:
        `README badge value "${rawValue}" is not a single-decimal KB value ` +
        `(format: X.YKB). Measured: ${measuredStr}KB. Expected badge URL: ${expectedUrl}`,
      measuredKb,
      badgeUrl: expectedUrl,
    }
  }

  const badgeKb = Number(numericMatch[1])
  const drift = Math.abs(badgeKb - measuredKb)
  if (drift > 0.1) {
    return {
      ok: false,
      message:
        `Badge value ${badgeKb}KB drifts from measured ${measuredStr}KB by ${drift.toFixed(2)}KB ` +
        `(threshold 0.1KB). Expected badge URL: ${expectedUrl}`,
      measuredKb,
      badgeUrl: expectedUrl,
    }
  }

  return {
    ok: true,
    message: `Badge value ${badgeKb}KB matches measured ${measuredStr}KB (drift ${drift.toFixed(2)}KB).`,
    measuredKb,
    badgeUrl: expectedUrl,
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  console.log('── Snippet CI (spec D4) ──\n')

  const { manifest, checkedFiles, totalChecked, totalSkipped } = materialize()

  console.log(`Fences/snippets checked: ${totalChecked}`)
  console.log(`Fences skipped:          ${totalSkipped}\n`)

  if (totalSkipped > 0) {
    console.log('Skip inventory (file:line of every `<!-- snippet: skip -->` marker):')
    for (const file of checkedFiles) {
      for (const fence of file.fences) {
        if (fence.skipped) {
          console.log(
            `  ${file.relPath}:${fence.skipMarkerLine} (skips fence at ${file.relPath}:${fence.startLine}-${fence.endLine})`,
          )
        }
      }
    }
    console.log('')
  }

  if (manifest.length > 0) {
    console.log('Manifest (generated file <- source):')
    for (const m of manifest) {
      console.log(`  ${m.generatedFile} <- ${m.sourceFile}:${m.sourceLines}`)
    }
    console.log('')
  }

  console.log('Running: tsc --noEmit -p tsconfig.snippets.json ...\n')
  const tsc = runTsc()
  console.log(tsc.output.trim().length > 0 ? tsc.output.trim() : '(no output)')
  console.log('')

  console.log('── Bundle-size badge drift check ──')
  const badge = checkBadge()
  console.log(badge.message)
  console.log('')

  const ok = tsc.ok && badge.ok
  if (!ok) {
    if (!tsc.ok) console.error('FAIL: one or more snippets failed to type-check (see tsc output above).')
    if (!badge.ok) console.error('FAIL: bundle-size badge check failed (see message above).')
    process.exitCode = 1
    return
  }

  console.log('OK: all snippets type-check and the bundle-size badge is accurate.')
}

main()
