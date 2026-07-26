# Domino Landing Page Redesign Design Document

**Date**: 2026-07-26  
**Status**: Approved  
**Target Project**: `@halaprix/domino` (`/home/halaprix/Projects/domino`)  
**Target Files**: `docs/styles.css`, `docs/index.html`

## Overview

Redesign the `@halaprix/domino` documentation page (`docs/index.html`) to match the visual style, typography, interactive SVG diagrams, procedure layout, definition lists, status matrix, and dark/light mode system of `agent-relay/site`, adapted with Domino's signature electric indigo color accent (`#494bd6` / `#8183ff`).

## Goals

1. **Visual Parity with Agent-Relay**: Replicate the exact design tokens, monospace rail header, hero grid background, procedure step lists, definition rows, status matrix tables, and footer.
2. **Zero External CSS Dependency**: Eliminate the external Tailwind CDN dependency (`<script src="https://cdn.tailwindcss.com..."></script>`) in favor of a clean, performant, standalone vanilla CSS file (`docs/styles.css`).
3. **Accurate & Up-to-Date Technical Claims**:
   - Version: `v1.3.0`
   - Size: `16.8 KB gzipped`
   - License: `MIT`
   - Core Features: FSM executor, EIP-1193 native (`viem`, `window.ethereum`, `ethers` adapter), single-use tasks (`DominoTaskReuseError`), memoized human-readable ABIs, multichain parallel resolution (`MultichainResolver`).
4. **Interactive SVG Hero Component**: Custom SVG diagram illustrating the FSM multicall pipeline step execution (`balanceOf` → `convertToAssets` → `derive`).

## Design System Specifications

### Typography
- Body font (`--sans`): `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`
- Code & Monospace font (`--mono`): `ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", "JetBrains Mono", Menlo, Consolas, monospace`

### Color Palette & Tokens
- Light / Dark system support via CSS `@media (prefers-color-scheme: dark)`:
  - `--enclosure`: `#090d0e` (dark) / `#e5e8e4` (light)
  - `--card`: `#111819` (dark) / `#f4f6f3` (light)
  - `--ink`: `#e3e9e6` (dark) / `#101614` (light)
  - `--muted`: `#94a5a0` (dark) / `#4e5b57` (light)
  - `--line`: `rgba(227, 233, 230, 0.16)` (dark) / `rgba(16, 22, 20, 0.14)` (light)
  - `--hair`: `rgba(227, 233, 230, 0.09)` (dark) / `rgba(16, 22, 20, 0.08)` (light)
  - `--panel`: `#0a0d14`
  - `--panel-line`: `rgba(192, 193, 255, 0.16)`
  - `--panel-ink`: `#e0e3ff`
  - `--panel-muted`: `#9094c4`
  - Primary Accent (`--indigo` / `--patina` equivalent): `#494bd6`
  - Accent Lift (`--indigo-lift` / `--patina-lift` equivalent): `#8183ff`
  - Signal (`--signal`): `#e0a02a`
  - Stop (`--halt`): `#b0432c`

## Page Architecture & Layout Breakdown

### 1. Top Rail Navbar (`.rail`)
- Sticky top navbar with backdrop blur (`backdrop-filter: blur(10px)`).
- Title: `domino`
- Links: `Topology`, `Workflow`, `Capabilities`, `Benchmarks`, `Setup`, `GitHub`
- Metadata: `v1.3.0`

### 2. Hero Section (`.hero`)
- Left column:
  - Eyebrow: `FSM Multicall Executor · EIP-1193 Native`
  - Headline: `Batched on-chain reads without the compromise.`
  - Lede: `domino solves the N×M RPC problem. Sequential, self-triggering reads resolved in M multicalls.`
  - Actions: Buttons for `Install domino` (`.btn--live`) and `See the topology` (`.btn`).
- Right column:
  - `.chain` SVG diagram visualizing the FSM execution graph:
    - `TASK SEED` → `FSM EXECUTOR` → `STEP 1: balanceOf` → `STEP 2: convertToAssets` → `DERIVE: hasBalance` → `RESULT GRAPH`.
  - `.log` status feedback panel displaying real-time execution telemetry.

### 3. Content Bands
- **Topology (`#topology`)**: Definition list (`.defs`) detailing FSM graph resolution, EIP-1193 engine compatibility, and Multichain parallel execution.
- **Workflow (`#workflow`)**: Numbered procedure list (`.steps`) from `01` to `04` covering package setup, client creation, `defineTask` builder, and `runMultistepTasks`.
- **Capabilities (`#capabilities`)**: Status table (`.codes`) documenting gzipped bundle size ceiling, single-use task protection (`DominoTaskReuseError`), memoized ABI cache, and TypeScript type inference.
- **Benchmarks (`#benchmarks`)**: Comparison section illustrating N×M RPC calls vs M Domino multicalls.
- **Setup (`#setup`)**: Terminal command block (`.term`) for npm installation and quick start snippet.

### 4. Footer (`.foot`)
- Brand mark, version `v1.3.0`, MIT License, and links to GitHub, npm, Changelog, and Issues.

## Verification & Self-Review Checklist

- [x] No placeholders or TBDs.
- [x] Exact version (`v1.3.0`) and bundle size (`16.8 KB gzipped`) match project source of truth.
- [x] All 341 vitest unit tests passing.
- [x] HTML & CSS follow accessibility and SEO standards (semantic tags, skip link, viewport meta, color-scheme meta).
