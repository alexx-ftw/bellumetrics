# GitHub Pages Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Commander Elo from `alexx-ftw/commander-elo` at `https://alexx-ftw.github.io/commander-elo/` with automatic GitHub Pages deployments.

**Architecture:** Keep the existing Next-compatible application and add a separate static export path using `next build`. The Pages build enables `output: "export"`, `basePath: "/commander-elo"`, and trailing-slash routes without changing the existing Sites build. GitHub Actions validates and deploys the generated `out/` directory.

**Tech Stack:** Next.js 16, React 19, Node.js 22, GitHub Actions, GitHub Pages

## Global Constraints

- Repository is public at `alexx-ftw/commander-elo`.
- Default branch is `main`.
- Existing Sites deployment remains functional.
- Scores and source counts remain clearly labeled as demonstration data.
- No backend or persistent contribution form is added in this phase.

---

### Task 1: Static export configuration

**Files:**
- Modify: `next.config.ts`
- Modify: `package.json`
- Create: `tests/pages-export.test.mjs`

**Interfaces:**
- Consumes: existing App Router pages and `generateStaticParams()` from `app/commander/[slug]/page.tsx`
- Produces: `npm run build:pages`, which writes a deployable site to `out/`

- [ ] **Step 1: Write a failing export test**

Create a Node test that verifies `out/index.html`, `out/network/index.html`, `out/rankings/index.html`, and `out/commander/napoleon-bonaparte/index.html` exist and that generated HTML references `/commander-elo/` assets and links.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/pages-export.test.mjs`
Expected: FAIL because `out/` has not been generated.

- [ ] **Step 3: Add the Pages-only Next configuration**

When `GITHUB_PAGES=1`, set `output: "export"`, `basePath: "/commander-elo"`, `assetPrefix: "/commander-elo/"`, `trailingSlash: true`, and `images.unoptimized: true`. Leave the default configuration unchanged for Sites.

- [ ] **Step 4: Add the build command**

Add `"build:pages": "GITHUB_PAGES=1 next build"` to `package.json`.

- [ ] **Step 5: Build and run the export test**

Run: `npm run build:pages && node --test tests/pages-export.test.mjs`
Expected: PASS with all static routes present.

- [ ] **Step 6: Commit**

Run: `git add next.config.ts package.json tests/pages-export.test.mjs && git commit -m "Add GitHub Pages static export"`

### Task 2: Automated Pages deployment

**Files:**
- Create: `.github/workflows/pages.yml`

**Interfaces:**
- Consumes: `npm run build:pages` and the generated `out/` directory
- Produces: a GitHub Pages deployment for every push to `main`

- [ ] **Step 1: Add the workflow**

Create a workflow with `contents: read`, `pages: write`, and `id-token: write`; use Node 22, `npm ci`, `npm test`, `npm run lint`, `npm run build:pages`, `actions/upload-pages-artifact`, and `actions/deploy-pages`.

- [ ] **Step 2: Validate workflow structure locally**

Run a Node YAML-text test that asserts the workflow targets `main`, uses the Pages artifact actions, and uploads `./out`.

- [ ] **Step 3: Commit**

Run: `git add .github/workflows/pages.yml tests/pages-export.test.mjs && git commit -m "Deploy Commander Elo with GitHub Pages"`

### Task 3: Open-source documentation

**Files:**
- Modify: `README.md`
- Create: `CONTRIBUTING.md`
- Create: `.github/ISSUE_TEMPLATE/data-correction.yml`

**Interfaces:**
- Produces: contributor instructions for corrections, new commanders, sources, local setup, and pull requests

- [ ] **Step 1: Replace the starter README**

Document the live site, provisional-data warning, features, local commands, data locations, and contribution routes.

- [ ] **Step 2: Add contribution guidance and issue form**

Require a source URL or bibliographic reference, affected commander or battle, proposed correction, and rationale. Explain that accepted evidence triggers recalculation rather than direct manual score editing.

- [ ] **Step 3: Verify documentation**

Run: `rg "provisional|fuente|npm run build:pages|pull request" README.md CONTRIBUTING.md .github/ISSUE_TEMPLATE/data-correction.yml`
Expected: each required concept appears.

- [ ] **Step 4: Commit**

Run: `git add README.md CONTRIBUTING.md .github/ISSUE_TEMPLATE/data-correction.yml && git commit -m "Document Commander Elo contributions"`

### Task 4: Repository creation and production verification

**Files:**
- No source changes expected

**Interfaces:**
- Consumes: clean, verified `main` history
- Produces: public repository and verified GitHub Pages URL

- [ ] **Step 1: Run fresh verification**

Run: `npm test && npm run lint && npm run build:pages && node --test tests/pages-export.test.mjs`
Expected: all commands exit 0.

- [ ] **Step 2: Create the public repository**

Create `alexx-ftw/commander-elo` without starter files so the existing history can become `main`.

- [ ] **Step 3: Transfer the repository**

Push the exact local `main` commit and tags, preserving the existing commit history. Configure Pages to use GitHub Actions.

- [ ] **Step 4: Verify GitHub Actions**

Inspect the workflow run for the pushed commit and wait for the Pages deployment job to succeed.

- [ ] **Step 5: Verify the public URL**

Open the exact URL returned by GitHub, verify the homepage, `/network/`, and `/commander/napoleon-bonaparte/`, and test one ranking-mode change and one connection search.
