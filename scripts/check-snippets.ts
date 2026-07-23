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
 * so duplicate top-level identifiers across fences never collide. Every
 * generated file is checked with `tsc --noEmit -p tsconfig.snippets.json`,
 * which:
 *   - sets `moduleDetection: "force"` so an import/export-less fence is
 *     still its own isolated module scope rather than a "script" that
 *     shares globals with every other import/export-less fence in the
 *     same tsc invocation (that sharing is otherwise a real false-green/
 *     false-red hazard — see the checkSrcEscapes()/negative-test notes);
 *   - self-type-checks this script (included in tsconfig.snippets.json)
 *     on every run.
 *
 * This script also:
 *   - scans every materialized file's import specifiers and fails loudly
 *     if any escapes `.snippets-build/` via a relative `..` segment or
 *     resolves into the real `src/` tree — the `paths` mapping only
 *     redirects the `@halaprix/domino` specifier itself, so a snippet
 *     importing `../../src/index` directly would otherwise silently
 *     type-check against source instead of the built dist types;
 *   - runs the bundle-size badge drift check (gzips dist/index.js and
 *     compares against the README badge value) — see `checkBadge()`.
 *
 * Anvil execution is intentionally NOT implemented — it's called out as
 * optional in spec D4 and out of scope for this harness.
 */

import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join, dirname, basename, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const BUILD_DIR = join(ROOT, '.snippets-build')
const SRC_DIR = join(ROOT, 'src')
const SKIP_MARKER = '<!-- snippet: skip -->'

// ─── Types ──────────────────────────────────────────────────────────────────

interface Fence {
  /** 1-based index of this fence among all ts/typescript fences in its source file. */
  index: number
  /** 1-based line of the opening fence marker. */
  startLine: number
  /** 1-based line of the closing fence marker. */
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
//
// Handles CommonMark backtick fences generically: any run of 3+ backticks
// opens a fence, and the closing run must be at least as long as the
// opening one. The language is the *first* whitespace-delimited token of
// the info string, so ```ts, ````ts (4 backticks), and ```ts title="x"
// (extra attributes) are all recognized the same way. An info string that
// merely *looks* like a ts/typescript fence but doesn't parse into a clean
// first token (e.g. a language glued directly to an attribute with no
// separating whitespace) fails loudly rather than being silently skipped —
// unchecked published examples are worse than a noisy CI failure.

const OPEN_RE = /^(`{3,})(.*)$/
const TS_LOOKALIKE_RE = /^(ts|typescript)(?=$|[\s:{])/i

function extractFences(markdown: string, sourceLabel: string): Fence[] {
  const lines = markdown.split('\n')
  const fences: Fence[] = []
  let index = 0
  let i = 0

  while (i < lines.length) {
    const trimmed = (lines[i] ?? '').trim()
    const openMatch = OPEN_RE.exec(trimmed)

    if (!openMatch) {
      i++
      continue
    }

    const fenceRun = openMatch[1] ?? '```'
    const infoString = (openMatch[2] ?? '').trim()
    const firstToken = infoString.split(/\s+/)[0] ?? ''
    const isTs = firstToken === 'ts' || firstToken === 'typescript'
    const closeRe = new RegExp(`^\`{${fenceRun.length},}$`)

    if (!isTs) {
      if (TS_LOOKALIKE_RE.test(infoString)) {
        throw new Error(
          `Unsupported fence syntax at ${sourceLabel}:${i + 1} — info string "${infoString}" ` +
            `looks like a TypeScript fence but its first token isn't cleanly "ts" or "typescript" ` +
            `(check for a missing space before attributes). Refusing to silently skip it.`,
        )
      }
      // Not a fence we care about — skip past its body using the SAME
      // backtick-count rule so an embedded ``` inside a 4+-backtick fence
      // isn't mistaken for that fence's closing line.
      let k = i + 1
      while (k < lines.length && !closeRe.test((lines[k] ?? '').trim())) k++
      i = k + 1
      continue
    }

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

    // Find the closing fence (a run of backticks at least as long as the opening).
    let k = i + 1
    const contentLines: string[] = []
    while (k < lines.length && !closeRe.test((lines[k] ?? '').trim())) {
      contentLines.push(lines[k] ?? '')
      k++
    }
    const endLine = k + 1 // line of the closing fence (or EOF if unterminated)

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
  }

  return fences
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/** Non-recursive: lists files directly inside `dir` with the given extension. */
function listFiles(dir: string, ext: string): string[] {
  let entries: Dirent[]
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
    const relMdFile = relPath(mdFile)
    const markdown = readFileSync(mdFile, 'utf8')
    const fences = extractFences(markdown, relMdFile)
    checkedFiles.push({ relPath: relMdFile, fences })

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
        sourceFile: relMdFile,
        sourceLines: `${fence.startLine}-${fence.endLine}`,
      })
      totalChecked += 1
    }
  }

  return { manifest, checkedFiles, totalChecked, totalSkipped }
}

// ─── src/ escape check ──────────────────────────────────────────────────────
//
// The tsconfig `paths` mapping only redirects the `@halaprix/domino`
// specifier to dist/index.d.ts. Nothing stops a snippet from importing
// e.g. `../../src/index` directly, which would type-check against source
// (with its stricter tsconfig — a different pass/fail outcome than a real
// consumer would ever see) instead of the built public surface. Every
// materialized file's import specifiers are scanned for that.

const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
]

function findImportSpecifiers(content: string): string[] {
  const specs: string[] = []
  for (const re of IMPORT_SPECIFIER_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(content))) {
      if (m[1]) specs.push(m[1])
    }
  }
  return specs
}

interface SrcEscape {
  generatedFile: string
  sourceFile: string
  sourceLines: string
  specifier: string
  reason: string
}

function findSrcEscapes(manifest: Manifest[]): SrcEscape[] {
  const escapes: SrcEscape[] = []
  for (const entry of manifest) {
    const absGeneratedFile = join(ROOT, entry.generatedFile)
    const content = readFileSync(absGeneratedFile, 'utf8')
    for (const spec of findImportSpecifiers(content)) {
      if (spec.startsWith('.')) {
        if (spec.split('/').includes('..')) {
          escapes.push({
            ...entry,
            specifier: spec,
            reason: 'relative import escapes .snippets-build/ via ".."',
          })
          continue
        }
        const resolved = resolve(dirname(absGeneratedFile), spec)
        if (resolved === SRC_DIR || resolved.startsWith(SRC_DIR + sep)) {
          escapes.push({ ...entry, specifier: spec, reason: 'resolves into src/ instead of dist' })
        }
      } else if (spec === 'src' || spec.startsWith('src/') || spec.includes('/src/')) {
        escapes.push({ ...entry, specifier: spec, reason: 'references src/ directly instead of dist' })
      }
    }
  }
  return escapes
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

  console.log('── src/ escape check ──')
  const srcEscapes = findSrcEscapes(manifest)
  if (srcEscapes.length === 0) {
    console.log('OK: no snippet imports escape .snippets-build/ or reach into src/.\n')
  } else {
    for (const esc of srcEscapes) {
      console.error(
        `SRC ESCAPE: ${esc.sourceFile}:${esc.sourceLines} (via ${esc.generatedFile}) imports "${esc.specifier}" — ${esc.reason}`,
      )
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

  const ok = tsc.ok && badge.ok && srcEscapes.length === 0
  if (!ok) {
    if (srcEscapes.length > 0) console.error('FAIL: one or more snippets import outside the public dist surface.')
    if (!tsc.ok) console.error('FAIL: one or more snippets failed to type-check (see tsc output above).')
    if (!badge.ok) console.error('FAIL: bundle-size badge check failed (see message above).')
    process.exitCode = 1
    return
  }

  console.log('OK: all snippets type-check and the bundle-size badge is accurate.')
}

try {
  main()
} catch (err) {
  console.error((err as Error).message ?? String(err))
  process.exitCode = 1
}
