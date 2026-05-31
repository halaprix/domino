# Versioning & Package Publishing Guide

## Overview

`multicall-resolver` follows [Semantic Versioning](https://semver.org/). The package ships with three engine entry points under one version — all engines are bumped together. Tree-shaking means consumers pay for only the engine they import, so a breaking change to one engine bumps the whole package.

---

## Versioning Policy

### Bump rules

| Change | Bump | Example |
|---|---|---|
| New engines, new handlers, new API surface | Minor | 0.1.0 → 0.2.0 |
| Breaking API change (resolver signature, return types) | Major | 0.x.y → 1.0.0 |
| New optional parameters, new chain support | Patch | 0.1.0 → 0.1.1 |
| Bug fixes, perf improvements, test additions | Patch | 0.1.0 → 0.1.1 |

**Pre-release tagging:** use `-beta.N`, `-rc.N`. Example: `0.2.0-beta.1`. Publish from a `beta` branch, not `main`.

### Per-engine considerations

Since each engine is a separate entry point with its own peer dependency:

- A breaking change in the `ethers-v6` engine bumps **major** (not minor), because existing users of that engine may break.
- A new engine addition (e.g. `ethers-v7`) bumps **minor** (existing engines unchanged).
- Tree-shaking means consumers who import `multicall-resolver/engines/viem` are unaffected by ethers engine changes — but we still bump together to keep the version meaningful across the repo.

---

## Release Checklist

For every release, complete all steps in order:

```
1. Update package.json version
2. Write/append CHANGELOG.md
3. Run tests and build
4. Tag commit
5. Publish to npm
6. Push tags
```

---

## Step-by-step Release Process

### 1. Update version

```bash
# Pick one:
npm version patch   # bug fix / perf
npm version minor   # new features, new engines
npm version major  # breaking changes
```

This bumps `version` in `package.json` and creates a git commit automatically.

### 2. Update changelog

Create or append to `CHANGELOG.md`:

```md
## [0.2.0] — YYYY-MM-DD

### Added
- New engine: `ethers-v6` entry point

### Changed
- Handler factories refactored into `src/handlers/`

### Fixed
- `resolveErc20` now correctly passes `owner` to `balanceOf`
```

Or use [release-please](https://github.com/googleapis/release-please) to auto-generate from conventional commits.

### 3. Run tests and build

```bash
npm test
npm run build
```

Verify `dist/` has all three engines:
```bash
ls dist/engines/
# ethers-v5.cjs  ethers-v5.js  ethers-v5.d.cts  ethers-v5.d.ts
# ethers-v6.cjs  ethers-v6.js  ethers-v6.d.cts  ethers-v6.d.ts
# viem.cjs       viem.js       viem.d.cts       viem.d.ts
```

### 4. Tag the commit

```bash
git tag v0.2.0
git push origin main --tags
```

### 5. Publish to npm

```bash
# Dry run (always do this first)
npm publish --dry-run

# Public package
npm publish

# Pre-release
npm publish --tag beta
```

The package is `private: false` — no `.npmrc` credentials needed on the publish machine; just `npm login` first.

### 6. Push tags

```bash
git push origin main --tags
```

---

## CI/CD Setup (GitHub Actions)

Recommended workflow at `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          registry-url: "https://registry.npmjs.org"

      - name: Install
        run: npm ci

      - name: Tests
        run: npm test

      - name: Build
        run: npm run build

      - name: Publish to npm
        run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Requirements:**
- Add `NPM_TOKEN` as a GitHub Actions secret (from [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)).
- Token type: **Automation** (for GitHub Actions).
- Scopes: only the `multicall-resolver` package scope.

Trigger: push a version tag (`git tag v0.2.0 && git push origin v0.2.0`). The workflow runs tests → build → publish. Nothing happens on regular commits.

---

## Publishing from a beta branch

```bash
git checkout beta
npm version preminor --preid=beta
# Edit package.json to set version, e.g. 0.2.0-beta.1

git tag v0.2.0-beta.1
git push origin beta --tags

# Beta users can install:
npm install multicall-resolver@beta
```

---

## Package Exports Map

Current export entries in `package.json`:

| Entry | File | Peer deps bundled |
|---|---|---|
| `multicall-resolver` | `dist/index.js` | all (viem + ethers) |
| `multicall-resolver/engines/viem` | `dist/engines/viem.js` | viem only |
| `multicall-resolver/engines/ethers-v6` | `dist/engines/ethers-v6.js` | ethers v6 only |
| `multicall-resolver/engines/ethers-v5` | `dist/engines/ethers-v5.js` | ethers v5 only |

Each engine entry includes its peer deps via tsup's `treeshake: true` + format splitting. The CJS entry (`dist/index.cjs`) is for Node.js `require()` compatibility.

---

## npm Package Metadata

| Field | Value |
|---|---|
| Name | `multicall-resolver` |
| Version | current (from `package.json`) |
| License | MIT |
| Repository | `github.com/halaprix/multistep-multicall` |
| Keywords | `ethereum`, `multicall`, `evm`, `viem`, `ethers`, `blockchain`, `rpc`, `batch` |
| Main | `./dist/index.cjs` |
| Module | `./dist/index.js` |
| Types | `./dist/index.d.ts` |

---

## GitHub Releases

After publishing, create a GitHub Release for the tag:

```bash
# Via CLI
gh release create v0.2.0 \
  --title "multicall-resolver v0.2.0" \
  --notes "$(cat CHANGELOG.md)"
```

Or use [release-please](https://github.com/googleapis/release-please) to auto-create releases from the commit history — it also creates the tag and the GitHub Release in one step.

---

## Quick Reference Card

```bash
# Patch (bug fix)
npm version patch && git push --tags

# Minor (new feature)
npm version minor && git push --tags

# Major (breaking)
npm version major && git push --tags

# Beta release
npm version preminor --preid=beta && git push beta --tags

# Install latest beta
npm install multicall-resolver@beta

# Verify publish
npm publish --dry-run

# Install released version
npm install multicall-resolver
```

---

## FAQ

**Q: Do I need to publish all three engines separately?**  
No. `npm publish` publishes the whole package. Consumers who `import { createResolver } from "multicall-resolver/engines/viem"` only get the viem bundle via tree-shaking — they never see ethers code.

**Q: Can I publish with a different tag for each engine?**  
No — npm packages are published as a whole with one version. If you need per-engine versioning, split into separate packages (`multicall-resolver-viem`, etc.). We don't do this because it breaks the unified SDK story.

**Q: How do I publish a hotfix?**  
```bash
git checkout main
git cherry-pick <fix-commit>
npm version patch
git push --tags
```

**Q: What if the build fails but tests pass?**  
Do not publish. Fix the build first. A failed build means `dist/` is stale or corrupted — consumers will get broken code. Run `npm run build` locally and inspect `dist/` before every publish.

**Q: Should I ship `engines/` files as separate tarballs?**  
No. The tsup output in `dist/engines/` is consumed directly via the `exports` field in `package.json`. The npm package contains the whole `dist/` tree.