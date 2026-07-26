# Domino Landing Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Domino documentation landing page to match the Agent-Relay design system, typography, interactive SVG diagrams, procedure lists, definition lists, status matrix, and dark/light system adaptation, using Domino's signature electric indigo accent color (`#494bd6` / `#8183ff`).

**Architecture:** Create a standalone `docs/styles.css` containing all design system tokens, typography rules, layout grids, hero background patterns, interactive SVG animations, and responsive media queries. Update `docs/index.html` to adopt this design system with updated semantic HTML, skip navigation link, top rail header, hero section, content bands, benchmark tables, and setup blocks without any external Tailwind CDN dependency.

**Tech Stack:** Vanilla HTML5, Vanilla CSS3 (Custom Properties, CSS Grid, Flexbox, SVG animations, backdrop-filter, prefers-color-scheme).

---

### Task 1: Create `docs/styles.css` Design System

**Files:**
- Create: `docs/styles.css`

- [ ] **Step 1: Write `docs/styles.css`**

Create the comprehensive stylesheet defining design tokens, root variables, media queries for light/dark modes, base styles, top rail navbar, hero section, interactive SVG chain diagram, content bands, definition lists, procedure steps, status table, terminal blocks, and footer.

- [ ] **Step 2: Verify CSS validity and file existence**

Run: `test -f docs/styles.css`  
Expected: Exit code 0.

- [ ] **Step 3: Commit `docs/styles.css`**

```bash
git add docs/styles.css
git commit -m "feat(docs): create standalone agent-relay style design system in docs/styles.css"
```

---

### Task 2: Update `docs/index.html` Page Structure

**Files:**
- Modify: `docs/index.html`

- [ ] **Step 1: Write `docs/index.html` content**

Update `docs/index.html` with:
- Updated meta tags (color-scheme, description, title).
- Link to `./styles.css` (removing the Tailwind CDN script).
- Skip link (`<a class="skip" href="#main">Skip to content</a>`).
- Sticky top rail header (`.rail`).
- Hero section (`.hero`) with eyebrow, title, lede, actions, and animated SVG FSM diagram (`.chain`).
- Content bands:
  - `#topology` ("One graph, M multicalls")
  - `#workflow` ("Procedure / Workflow" with steps 01-04)
  - `#capabilities` ("Guarantees & Exit matrix")
  - `#benchmarks` ("Performance & Call Reduction")
  - `#setup` ("Setup / Install")
- Footer (`.foot`).

- [ ] **Step 2: Verify `check:snippets` and tests pass**

Run: `npm run check:snippets && npm test`  
Expected: All 31 snippet checks pass, badge drift check passes, and all 341 tests pass.

- [ ] **Step 3: Commit `docs/index.html`**

```bash
git add docs/index.html
git commit -m "feat(docs): redesign domino landing page to agent-relay style"
```

---

### Task 3: Final Verification & Git Push

**Files:**
- None (Verification & Push)

- [ ] **Step 1: Run full project verification suite**

Run: `npm run build && npm test && npm run check:snippets`  
Expected: All build, test, and snippet checks exit 0 cleanly.

- [ ] **Step 2: Push changes to remote repository**

Run: `git push origin main`  
Expected: Branch pushed successfully.
