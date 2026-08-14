# Commander Elo MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a deployed, responsive Commander Elo MVP with realistic demonstration data, rankings, commander profiles, comparison, methodology, and degrees-of-separation exploration.

**Architecture:** Vinext/Next routes render from a shared typed demonstration dataset. Pure graph and ranking helpers stay framework-independent and receive direct Node tests; UI behavior uses focused client components while static content remains server-rendered.

**Tech Stack:** Sites Vinext starter, Next.js 16, React 19, TypeScript 5.9, Tailwind CSS 4, Node test runner.

## Global Constraints

- Preserve `.openai/hosting.json` and the starter build/deployment scripts.
- Render the authoritative title `Commander Elo` and Spanish interface copy.
- Match the approved historical-analytical direction: near-black background, restrained warm-gold accents, serif display typography, sans-serif interface typography.
- Label all seeded scores as demonstration data and avoid presenting invented numbers as historical conclusions.
- Provide keyboard-visible focus, semantic controls, responsive layouts, and reduced-motion support.
- Do not add persistence, authentication, external connectors, or a specialized graph database in this MVP.

---

### Task 1: Domain model and graph calculations

**Files:**
- Create: `lib/commanders.mjs`
- Test: `tests/commander-model.test.mjs`

**Interfaces:**
- Produces: `commanders`, `battles`, `rankCommanders(mode)`, and `shortestPath(startId, endId)`.
- `rankCommanders(mode)` returns descending commander records with a `score` field for `historical`, `adjusted`, `tactical`, or `strategic`.
- `shortestPath(startId, endId)` returns an ordered commander array or `null` when disconnected.

- [ ] **Step 1: Write failing tests** for descending rankings, a direct connection, an indirect connection, identical endpoints, and disconnected nodes.
- [ ] **Step 2: Run `node --test tests/commander-model.test.mjs`** and verify failure because `lib/commanders.mjs` does not exist.
- [ ] **Step 3: Implement the demonstration dataset and minimal breadth-first graph traversal.** Include at least 20 geographically and chronologically diverse commanders, explicit battle edges, confidence values, domains, eras, rating dimensions, and source-count metadata.
- [ ] **Step 4: Run the model tests** and verify all pass.
- [ ] **Step 5: Commit the tested domain model.**

### Task 2: Shared shell and homepage

**Files:**
- Modify: `app/layout.tsx`
- Modify: `app/globals.css`
- Modify: `app/page.tsx`
- Create: `components/site-header.tsx`
- Create: `components/ranking-table.tsx`
- Create: `components/network-search.tsx`
- Test: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: ranking and graph functions from `lib/commanders.mjs`.
- Produces: accessible navigation, the approved hybrid homepage, interactive ranking tabs, and commander connection search.

- [ ] **Step 1: Extend the rendered HTML test** to require `Commander Elo`, `Mide. Compara. Conecta.`, `Ranking histórico`, `Grados de separación`, and a demonstration-data disclosure.
- [ ] **Step 2: Run `npm test`** and verify the test fails against the starter page.
- [ ] **Step 3: Implement metadata, tokens, typography, responsive shell, homepage, ranking tabs, and connection search.** Use code-native UI and inline SVG only for interface icons and graph lines.
- [ ] **Step 4: Run `npm test` and `npm run lint`** and verify both pass.
- [ ] **Step 5: Commit the visible homepage milestone.**

### Task 3: Rankings, profiles, network, and methodology routes

**Files:**
- Create: `app/rankings/page.tsx`
- Create: `app/network/page.tsx`
- Create: `app/methodology/page.tsx`
- Create: `app/commander/[slug]/page.tsx`
- Create: `components/commander-profile.tsx`
- Create: `components/network-explorer.tsx`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes: the shared dataset and pure model helpers.
- Produces: filterable rankings, a two-person comparison path, dynamic commander profiles, and an understandable methodology page.

- [ ] **Step 1: Add rendered-route assertions** for `/rankings`, `/network`, `/methodology`, and `/commander/napoleon-bonaparte`.
- [ ] **Step 2: Run `npm test`** and verify route assertions fail because the pages are absent.
- [ ] **Step 3: Implement the four route families** with shared components, confidence indicators, career/event summaries, source counts, and historical-versus-adjusted explanations.
- [ ] **Step 4: Run `npm test` and `npm run lint`** and verify all checks pass.
- [ ] **Step 5: Commit the complete navigable experience.**

### Task 4: Visual and interaction verification

**Files:**
- Modify only files implicated by observed defects.

**Interfaces:**
- Consumes: all implemented routes and the accepted concept.
- Produces: a checkpoint-ready responsive site with verified primary interactions.

- [ ] **Step 1: Start the Sites agent preview** and inspect the homepage, rankings, network search, profile, methodology, desktop layout, and mobile layout.
- [ ] **Step 2: Capture the rendered homepage** at a desktop viewport close to the accepted concept.
- [ ] **Step 3: Compare the accepted concept and implementation with image inspection** across copy, composition, typography, palette, containers, spacing, responsive behavior, and interaction states.
- [ ] **Step 4: Fix every material mismatch or accessibility defect** and repeat preview checks.
- [ ] **Step 5: Run `npm test`, `npm run lint`, and the production build gate** with clean output.
- [ ] **Step 6: Create and verify the final Sites checkpoint deployment.**
