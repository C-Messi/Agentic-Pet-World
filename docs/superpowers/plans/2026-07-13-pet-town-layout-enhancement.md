# Pet Town Layout Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Pet Town zone in design section 2.3 visually distinct and readable in the Phaser world without changing the stable navigation contract.

**Architecture:** Keep `TOWN_ZONES` as the source of truth for IDs, bounds, and entrances. Add a focused scene-layout catalog that maps those IDs to presentation metadata and landmark placements, then render the catalog over a richer pixel-art background using the existing town atlas asset boundary.

**Tech Stack:** TypeScript, Phaser 3, Vitest, Vite, PNG pixel assets, Playwright

---

### Task 1: Define the visual zone contract

**Files:**
- Modify: `apps/web/src/game/scenes/town-scene-layout.ts`
- Modify: `apps/web/src/game/scenes/town-scene.test.ts`

- [ ] **Step 1: Write a failing test** asserting all seven stable zone IDs have unique labels, landmarks, and entrances within their declared zone bounds.
- [ ] **Step 2: Run** `pnpm --filter @cat-house/web test -- src/game/scenes/town-scene.test.ts` and confirm the new assertions fail because visual metadata does not exist.
- [ ] **Step 3: Add typed `TOWN_ZONE_PRESENTATIONS` and landmark placement data** for gate, plaza, fortune pavilion, market, garden, build plots, and arcade house.
- [ ] **Step 4: Re-run the focused test** and confirm it passes.

### Task 2: Render recognizable town districts

**Files:**
- Modify: `apps/web/src/game/scenes/town-scene.ts`
- Modify: `apps/web/public/assets/town/town-background.png`
- Modify: `apps/web/public/assets/town/town-atlas.png`
- Modify: `apps/web/public/assets/town/manifest.json`

- [ ] **Step 1: Generate a 640x360 pixel-art background** with district-specific ground treatment, continuous paths, river edge, and a visible gate/bridge.
- [ ] **Step 2: Generate atlas frames** for the fortune pavilion, market stalls, garden feature, build plot, closed arcade house, plaza feature, signs, and build recipes while preserving the 64x64 frame grid.
- [ ] **Step 3: Render landmarks and compact Chinese zone labels** from the presentation catalog at stable world positions and depths.
- [ ] **Step 4: Keep resident sprites, modification rendering, follow camera, bubbles, and event playback above the environmental layers.**
- [ ] **Step 5: Run the focused scene and navigation tests** and confirm they pass.

### Task 3: Verify the full experience

**Files:**
- Modify only if verification exposes a defect: `apps/web/src/game/scenes/town-scene.ts`, `apps/web/src/game/scenes/town-scene-layout.ts`, or town assets

- [ ] **Step 1: Run** `pnpm --filter @cat-house/web test` and confirm zero failures.
- [ ] **Step 2: Run** `pnpm --filter @cat-house/web build` and confirm TypeScript and Vite complete successfully.
- [ ] **Step 3: Start the existing development stack** and open the town through the real UI.
- [ ] **Step 4: Capture desktop and mobile screenshots** and verify all seven regions are visually identifiable, paths remain unobstructed, resident labels/bubbles and bottom command bar do not overlap, and the canvas is nonblank.
- [ ] **Step 5: Fix any visual defects and repeat tests, build, and screenshot verification.**
