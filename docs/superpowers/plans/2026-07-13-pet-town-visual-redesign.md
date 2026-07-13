# Pet Town Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat Pet Town resource composition with the approved layered village while preserving the seven area identities, deterministic navigation, full-town camera framing, and existing event playback.

**Architecture:** Keep the `20 x 11` navigation grid and `640 x 360` background. Move zone bounds to the approved composition, add deterministic static collision, expand the script-owned town atlas to an append-only `8 x 8` grid, and render declarative multi-part landmarks through Phaser depth bands. Incorporate the existing uncommitted `TOWN_CAMERA_LAYOUT` work instead of overwriting it.

**Tech Stack:** TypeScript, Phaser 3, Vitest, Node.js PNG generator, Vite, Playwright

---

## File Map

- Create `packages/shared/src/town-layout.ts`: approved cross-process grid, zone entrances, static collision, and encounter pairs.
- Create `packages/shared/src/town-layout.test.ts`: exact geometry and walkability invariants.
- Modify `packages/shared/src/index.ts`: export the shared layout.
- Modify `apps/web/src/game/town/town-navigation.ts`: consume shared geometry and provide deterministic pathfinding.
- Modify `apps/web/src/game/town/town-navigation.test.ts`: exact layout and reachability coverage.
- Modify `apps/web/src/game/scenes/town-scene-layout.ts`: camera, spawns, and declarative render-part catalog.
- Modify `apps/web/src/game/scenes/town-scene.test.ts`: layout, frame, collision, and camera contracts.
- Modify `scripts/generate-pixel-assets.mjs`: reusable town drawing primitives and deterministic outputs.
- Modify `apps/web/public/assets/town/town-background.png`: generated layered terrain.
- Modify `apps/web/public/assets/town/town-atlas.png`: generated `512 x 512` append-only atlas.
- Modify `apps/web/public/assets/town/manifest.json`: exact new dimensions and frame names.
- Modify `apps/web/src/game/assets/asset-manifest.test.ts`: PNG and manifest invariants.
- Modify `apps/web/src/game/scenes/town-scene.ts`: multi-part environment, depth bands, facing, and label removal.
- Modify `tests/e2e/pet-town.spec.ts`: visual density, full-town framing, and desktop screenshot assertions.
- Modify `tests/e2e/mobile-touch.spec.ts`: mobile town framing and control-overlap assertion.

### Task 1: Lock the approved grid and static walkability

**Files:**
- Create: `packages/shared/src/town-layout.test.ts`
- Create: `packages/shared/src/town-layout.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/web/src/game/town/town-navigation.test.ts`
- Modify: `apps/web/src/game/town/town-navigation.ts`

- [ ] **Step 1: Replace the zone/reachability test with the approved contract**

```ts
import { describe, expect, it } from 'vitest';

import { TOWN_STATIC_BLOCKED_CELLS, TOWN_ZONE_LAYOUT } from '@cat-house/shared';
import { TOWN_ZONES, TownNavigation } from './town-navigation';

const expected = {
  'fortune-pavilion': { bounds: { x: 1, y: 1, width: 5, height: 3 }, entrance: { x: 4, y: 3 } },
  garden: { bounds: { x: 7, y: 1, width: 6, height: 3 }, entrance: { x: 10, y: 3 } },
  market: { bounds: { x: 14, y: 1, width: 5, height: 4 }, entrance: { x: 15, y: 4 } },
  'arcade-house': { bounds: { x: 1, y: 5, width: 5, height: 3 }, entrance: { x: 5, y: 7 } },
  plaza: { bounds: { x: 7, y: 4, width: 6, height: 4 }, entrance: { x: 10, y: 6 } },
  'build-plots': { bounds: { x: 14, y: 5, width: 5, height: 3 }, entrance: { x: 15, y: 7 } },
  gate: { bounds: { x: 8, y: 8, width: 4, height: 3 }, entrance: { x: 10, y: 9 } },
} as const;

describe('TownNavigation', () => {
  it('uses the approved layered-village bounds and reachable entrances', () => {
    expect(Object.fromEntries(TOWN_ZONES.map(({ id, bounds, entrance }) => [id, { bounds, entrance }]))).toEqual(expected);
    const navigation = new TownNavigation();
    for (const zone of TOWN_ZONES) {
      expect(navigation.findPath(expected.gate.entrance, zone.entrance).length).toBeGreaterThan(0);
    }
  });

  it('blocks buildings and water while preserving the bridge', () => {
    const navigation = new TownNavigation();
    expect(TOWN_STATIC_BLOCKED_CELLS).toContainEqual({ x: 0, y: 10 });
    expect(navigation.isBlocked({ x: 0, y: 10 })).toBe(true);
    expect(navigation.isBlocked({ x: 10, y: 10 })).toBe(false);
    expect(navigation.findPath({ x: 10, y: 10 }, { x: 10, y: 6 })).not.toEqual([]);
  });

  it('adds and replaces dynamic build occupancy without clearing static collision', () => {
    const navigation = new TownNavigation();
    navigation.restoreModifications([{ occupiedCells: [{ x: 11, y: 7 }], collision: true }]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(true);
    navigation.restoreModifications([]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(false);
    expect(navigation.isBlocked({ x: 0, y: 10 })).toBe(true);
  });
});
```

Create `packages/shared/src/town-layout.test.ts` with the same exact `expected` object plus assertions that every encounter pair contains two distinct, in-bounds, non-blocked positions.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm --filter @cat-house/shared test -- src/town-layout.test.ts && pnpm --filter @cat-house/web exec vitest run src/game/town/town-navigation.test.ts`

Expected: FAIL because the current bounds differ and static collision is not exported.

- [ ] **Step 3: Implement the approved zones and generated static collision**

```ts
export const TOWN_GRID = { width: 20, height: 11, tileSize: 32 } as const;

export type TownZoneLayout = {
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly entrance: Position;
};
export type EncounterPair = readonly [Position, Position];

export const TOWN_ZONE_LAYOUT = {
  gate: { bounds: { x: 8, y: 8, width: 4, height: 3 }, entrance: { x: 10, y: 9 } },
  plaza: { bounds: { x: 7, y: 4, width: 6, height: 4 }, entrance: { x: 10, y: 6 } },
  'fortune-pavilion': { bounds: { x: 1, y: 1, width: 5, height: 3 }, entrance: { x: 4, y: 3 } },
  market: { bounds: { x: 14, y: 1, width: 5, height: 4 }, entrance: { x: 15, y: 4 } },
  garden: { bounds: { x: 7, y: 1, width: 6, height: 3 }, entrance: { x: 10, y: 3 } },
  'build-plots': { bounds: { x: 14, y: 5, width: 5, height: 3 }, entrance: { x: 15, y: 7 } },
  'arcade-house': { bounds: { x: 1, y: 5, width: 5, height: 3 }, entrance: { x: 5, y: 7 } },
} as const satisfies Readonly<Record<TownZoneId, TownZoneLayout>>;

export const TOWN_ENCOUNTER_PAIRS = {
  gate: [[{ x: 9, y: 9 }, { x: 10, y: 9 }]],
  plaza: [[{ x: 9, y: 6 }, { x: 11, y: 6 }], [{ x: 10, y: 5 }, { x: 10, y: 7 }]],
  'fortune-pavilion': [[{ x: 3, y: 3 }, { x: 5, y: 3 }]],
  market: [[{ x: 15, y: 4 }, { x: 16, y: 4 }]],
  garden: [[{ x: 9, y: 3 }, { x: 11, y: 3 }]],
  'build-plots': [[{ x: 15, y: 7 }, { x: 16, y: 7 }]],
  'arcade-house': [[{ x: 4, y: 7 }, { x: 5, y: 7 }]],
} as const satisfies Readonly<Record<TownZoneId, readonly EncounterPair[]>>;

const cells = (bounds: { x: number; y: number; width: number; height: number }) =>
  Array.from({ length: bounds.width * bounds.height }, (_, index) => ({
    x: bounds.x + (index % bounds.width),
    y: bounds.y + Math.floor(index / bounds.width),
  }));

const water = cells({ x: 0, y: 8, width: 20, height: 3 }).filter(
  ({ x }) => x < 8 || x > 11,
);
const structures = [
  { x: 1, y: 1, width: 5, height: 2 },
  { x: 7, y: 1, width: 6, height: 2 },
  { x: 14, y: 1, width: 5, height: 2 },
  { x: 1, y: 5, width: 5, height: 2 },
  { x: 14, y: 5, width: 5, height: 2 },
].flatMap(cells);

export const TOWN_STATIC_BLOCKED_CELLS = Object.freeze([...water, ...structures]);

export class TownNavigation {
  readonly #staticBlocked = new Set(TOWN_STATIC_BLOCKED_CELLS.map(key));
  readonly #dynamicBlocked = new Set<string>();

  restoreModifications(modifications: readonly Occupancy[]): void {
    this.#dynamicBlocked.clear();
    for (const modification of modifications) {
      if (!modification.collision) continue;
      for (const cell of modification.occupiedCells) this.#dynamicBlocked.add(key(cell));
    }
  }

  isBlocked(position: Position): boolean {
    return position.x < 0 || position.y < 0
      || position.x >= TOWN_GRID.width || position.y >= TOWN_GRID.height
      || this.#staticBlocked.has(key(position))
      || this.#dynamicBlocked.has(key(position));
  }
}
```

Put `TOWN_GRID`, `TOWN_ZONE_LAYOUT`, `TOWN_ENCOUNTER_PAIRS`, and `TOWN_STATIC_BLOCKED_CELLS` in `packages/shared/src/town-layout.ts`, export them from `packages/shared/src/index.ts`, and import them into `town-navigation.ts`. Build `TOWN_ZONES` from the stable order `gate`, `plaza`, `fortune-pavilion`, `market`, `garden`, `build-plots`, `arcade-house`.

Replace `TOWN_ZONES` with the exact values from the test and keep the existing `findPath`, `neighbors`, and `reconstruct` logic.

- [ ] **Step 4: Run navigation tests**

Run: `pnpm --filter @cat-house/shared test -- src/town-layout.test.ts && pnpm --filter @cat-house/web exec vitest run src/game/town/town-navigation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the navigation contract**

```bash
git add packages/shared/src/town-layout.ts packages/shared/src/town-layout.test.ts packages/shared/src/index.ts apps/web/src/game/town/town-navigation.ts apps/web/src/game/town/town-navigation.test.ts
git commit -m "feat: adopt layered pet town navigation"
```

### Task 2: Define multi-part scene presentations

**Files:**
- Modify: `apps/web/src/game/scenes/town-scene.test.ts`
- Modify: `apps/web/src/game/scenes/town-scene-layout.ts`

- [ ] **Step 1: Write failing render-part assertions**

Replace single-frame assertions with:

```ts
it('defines ordered render parts for every town zone', () => {
  const byId = new Map(TOWN_ZONES.map((zone) => [zone.id, zone]));
  const presentations = Object.values(TOWN_ZONE_PRESENTATIONS);
  expect(Object.keys(TOWN_ZONE_PRESENTATIONS).sort()).toEqual(TOWN_ZONES.map(({ id }) => id).sort());
  for (const presentation of presentations) {
    const zone = byId.get(presentation.zoneId)!;
    expect(presentation.entrance).toEqual(zone.entrance);
    expect(presentation.parts.length).toBeGreaterThanOrEqual(2);
    expect(presentation.parts.every(({ frame, collisionCells }) =>
      Number.isInteger(frame) && frame >= 0 && collisionCells.every((cell) => isInsideZone(cell, zone.bounds)),
    )).toBe(true);
  }
});

it('keeps all spawns unique, walkable, and near their authored districts', () => {
  const navigation = new TownNavigation();
  const spawns = Object.values(DEFAULT_TOWN_SPAWNS);
  expect(new Set(spawns.map(({ x, y }) => `${x}:${y}`)).size).toBe(5);
  expect(spawns.every((spawn) => !navigation.isBlocked(spawn))).toBe(true);
});
```

Add the `TownNavigation` import.

- [ ] **Step 2: Run the scene test and verify it fails**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/scenes/town-scene.test.ts`

Expected: FAIL because `parts` does not exist.

- [ ] **Step 3: Replace the presentation type**

```ts
export type TownRenderPart = {
  frame: number;
  anchor: Position;
  offset: Position;
  depthOffset: number;
  collisionCells: readonly Position[];
  foreground: boolean;
};

export type TownZonePresentation = {
  zoneId: TownZoneId;
  entrance: Position;
  signFrame: number;
  parts: readonly TownRenderPart[];
};
```

Update `DEFAULT_TOWN_SPAWNS` to walkable positions:

```ts
export const DEFAULT_TOWN_SPAWNS = {
  'player-cat': { x: 10, y: 9 },
  'resident-mikan': { x: 10, y: 6 },
  'resident-huihui': { x: 4, y: 3 },
  'resident-lanlan': { x: 15, y: 4 },
  'resident-doubao': { x: 15, y: 7 },
} as const;
```

Define each zone with at least its appended building frames plus its physical sign. Use indices `28..31` for the fortune pavilion, `32..34` for the greenhouse, `35..37` for market awnings, `38..41` for the arcade, `42..44` for the workshop, `45..47` for the gate/bridge, and `61..62` for the plaza. Use empty collision arrays for non-blocking decorative parts. Retain the existing `TOWN_CAMERA_LAYOUT` object and its `1.2` zoom.

- [ ] **Step 4: Run scene and navigation tests**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/scenes/town-scene.test.ts src/game/town/town-navigation.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the presentation contract**

```bash
git add apps/web/src/game/scenes/town-scene-layout.ts apps/web/src/game/scenes/town-scene.test.ts
git commit -m "feat: define layered town scene parts"
```

### Task 3: Expand the deterministic town asset contract

**Files:**
- Modify: `apps/web/src/game/assets/asset-manifest.test.ts`
- Modify: `apps/web/public/assets/town/manifest.json`
- Modify: `scripts/generate-pixel-assets.mjs`

- [ ] **Step 1: Add a failing exact-frame manifest test**

```ts
const appendedTownFrames = [
  'fortune-roof-left', 'fortune-roof-right', 'fortune-base-left', 'fortune-base-right',
  'greenhouse-left', 'greenhouse-right', 'greenhouse-door',
  'market-awning-red', 'market-awning-yellow', 'market-awning-blue',
  'arcade-roof-left', 'arcade-roof-right', 'arcade-base-left', 'arcade-base-right',
  'workshop-left', 'workshop-right', 'workshop-yard',
  'gate-roof-left', 'gate-roof-right', 'bridge-rail',
  'tree-green', 'tree-blossom', 'tree-canopy-foreground',
  'hedge-horizontal', 'hedge-vertical', 'fence-horizontal', 'fence-vertical',
  'lamp-post', 'bench-detailed', 'flower-bed', 'planter',
  'market-crates-detailed', 'dock', 'plaza-fountain-detailed',
  'plaza-banner', 'shoreline-reeds',
] as const;

it('keeps old town frames stable and appends the approved 8x8 atlas', () => {
  expect(townManifest.atlas).toMatchObject({
    frame: { width: 64, height: 64 }, columns: 8, rows: 8,
  });
  expect(Object.values(townManifest.atlas.frames).slice(0, 28)).toEqual(
    Array.from({ length: 28 }, (_, index) => index),
  );
  expect(Object.keys(townManifest.atlas.frames).slice(28)).toEqual(appendedTownFrames);
  expect(Object.values(townManifest.atlas.frames).slice(28)).toEqual(
    Array.from({ length: 36 }, (_, index) => index + 28),
  );
});
```

- [ ] **Step 2: Run the asset test and verify it fails**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/assets/asset-manifest.test.ts`

Expected: FAIL because the atlas is still four rows.

- [ ] **Step 3: Add reusable pixel primitives to the generator**

Add these deterministic helpers below `canvas()`:

```js
function checker(image, x, y, width, height, first, second, size = 4) {
  for (let py = 0; py < height; py += size)
    for (let px = 0; px < width; px += size)
      image.rect(x + px, y + py, Math.min(size, width - px), Math.min(size, height - py),
        (px / size + py / size) % 2 === 0 ? first : second);
}

function roof(image, x, y, width, color, highlight, ink) {
  for (let row = 0; row < 18; row += 2)
    image.rect(x + row, y + row / 2, width - row * 2, 2, row % 4 === 0 ? highlight : color);
  image.rect(x + 4, y + 18, width - 8, 4, ink);
}

function tree(image, x, y, leaf, leafLight, trunk, ink) {
  image.rect(x + 13, y + 25, 8, 25, ink);
  image.rect(x + 15, y + 27, 4, 23, trunk);
  for (const [dx, dy, size] of [[2, 12, 22], [12, 4, 22], [22, 13, 19]]) {
    image.rect(x + dx, y + dy, size, size, ink);
    image.rect(x + dx + 3, y + dy + 3, size - 6, size - 6, leaf);
    image.rect(x + dx + 6, y + dy + 5, 6, 4, leafLight);
  }
}
```

- [ ] **Step 4: Expand `drawTownAtlas()` and manifest generation**

Change the atlas canvas to `canvas(512, 512)`, preserve existing drawing branches, and add a `switch` for each appended name. Compose building halves with `roof`, outlined wall rectangles, windows, doors, and district colors; render tree frames with `tree`; render fence/hedge frames edge-to-edge so adjacent parts join; leave pixels outside each object transparent. Update `manifest.json` to `rows: 8` and append the exact names/indices from Step 1.

- [ ] **Step 5: Regenerate assets**

Run: `node scripts/generate-pixel-assets.mjs`

Expected: rewrites the town PNGs and manifest; `town-atlas.png` reports `512 x 512` RGBA.

- [ ] **Step 6: Run asset tests**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/assets/asset-manifest.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit generator, manifest, and generated atlas contract**

```bash
git add scripts/generate-pixel-assets.mjs apps/web/public/assets/town/manifest.json apps/web/public/assets/town/town-atlas.png apps/web/src/game/assets/asset-manifest.test.ts
git commit -m "feat: expand deterministic town pixel atlas"
```

### Task 4: Draw the layered village background

**Files:**
- Modify: `scripts/generate-pixel-assets.mjs`
- Modify: `apps/web/public/assets/town/town-background.png`
- Modify: `apps/web/src/game/assets/asset-manifest.test.ts`

- [ ] **Step 1: Add failing density assertions**

Extend `pngInfo()` to expose decoded RGB samples, then add:

```ts
it('renders a dense layered town background instead of large flat fields', () => {
  const png = pngInfo('public/assets/town/town-background.png');
  const colors = new Set<string>();
  for (let y = 0; y < png.height; y += 4) {
    for (let x = 0; x < png.width; x += 4) {
      const offset = y * (png.width * 4 + 1) + 1 + x * 4;
      colors.add(`${png.pixels[offset]}:${png.pixels[offset + 1]}:${png.pixels[offset + 2]}`);
    }
  }
  expect(colors.size).toBeGreaterThan(28);
});
```

- [ ] **Step 2: Run the asset test and verify it fails**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/assets/asset-manifest.test.ts`

Expected: FAIL on the new density threshold.

- [ ] **Step 3: Replace `drawTownBackground()` with the approved composition**

Draw in this order using only deterministic primitives: grass base and small clustered texture; dark tree-line band across the top; upper horizontal road; vertical garden-plaza-gate spine; lower loop; fortune, greenhouse, market, arcade, and workshop ground pads; plaza paving; water from pixel row 276 to 359; shoreline reeds; bridge at grid columns 8..11; flower clusters, fence shadows, and path edge highlights. Keep all interactive building bodies and foreground canopies in the atlas, not baked into this image.

- [ ] **Step 4: Regenerate and inspect the PNG**

Run: `node scripts/generate-pixel-assets.mjs`

Expected: `town-background.png` remains `640 x 360` RGBA and visually matches the approved layered layout.

- [ ] **Step 5: Run asset and navigation tests**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/assets/asset-manifest.test.ts src/game/town/town-navigation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the background**

```bash
git add scripts/generate-pixel-assets.mjs apps/web/public/assets/town/town-background.png apps/web/src/game/assets/asset-manifest.test.ts
git commit -m "feat: draw layered pet town background"
```

### Task 5: Render environment layers and resident facing

**Files:**
- Modify: `apps/web/src/game/scenes/town-scene.ts`
- Modify: `apps/web/src/game/scenes/town-scene.test.ts`

- [ ] **Step 1: Add pure facing assertions**

Export and test:

```ts
it('faces moving and interacting residents without changing their scale magnitude', () => {
  expect(horizontalFacing(10, 20)).toBe(1);
  expect(horizontalFacing(20, 10)).toBe(-1);
  expect(horizontalFacing(10, 10)).toBe(1);
});

it('walks resident events through the navigation path', () => {
  expect(residentMovementPath({ x: 10, y: 9 }, { x: 4, y: 3 })).toEqual(
    new TownNavigation().findPath({ x: 10, y: 9 }, { x: 4, y: 3 }),
  );
});
```

- [ ] **Step 2: Run the scene test and verify it fails**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/scenes/town-scene.test.ts`

Expected: FAIL because `horizontalFacing` is missing.

- [ ] **Step 3: Implement declarative environment rendering**

```ts
export function horizontalFacing(fromX: number, toX: number): 1 | -1 {
  return toX < fromX ? -1 : 1;
}

export function residentMovementPath(from: Position, to: Position): Position[] {
  return new TownNavigation().findPath(from, to);
}

#createZoneEnvironment(): void {
  for (const zone of Object.values(TOWN_ZONE_PRESENTATIONS)) {
    for (const part of zone.parts) {
      const anchor = tileCenter(part.anchor);
      this.add.image(
        anchor.x + part.offset.x,
        anchor.y + part.offset.y,
        'town-atlas',
        part.frame,
      ).setDepth(part.foreground ? 9_000 : anchor.y + part.depthOffset);
    }
    const entrance = tileCenter(zone.entrance);
    this.add.image(entrance.x, entrance.y - 22, 'town-atlas', zone.signFrame)
      .setDepth(entrance.y - 1);
  }
}
```

Call `#createZoneEnvironment()` from `create()`, delete floating Phaser text labels, and keep bubbles at depth `10_000`.

- [ ] **Step 4: Add direction and encounter facing**

Track authoritative grid positions in a `#residentPositions` map populated by `#spawnResident`. In `moveResident`, compute `residentMovementPath(current, position)`, reject an empty path, and tween through each path cell after the first; before each step set `sprite.setFlipX(horizontalFacing(sprite.x, target.x) < 0)`, then update the map. In `playActivity`, when there are exactly two participants, face their sprites toward one another before playing the event animation. Clear the position map during scene reset. Preserve `PET_SCALE` and Y-based depth updates.

- [ ] **Step 5: Run scene, event-player, and navigation tests**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/scenes/town-scene.test.ts src/game/town/town-event-player.test.ts src/game/town/town-navigation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit scene rendering**

```bash
git add apps/web/src/game/scenes/town-scene.ts apps/web/src/game/scenes/town-scene.test.ts
git commit -m "feat: render layered pet town environment"
```

### Task 6: Verify desktop and mobile presentation

**Files:**
- Modify: `tests/e2e/pet-town.spec.ts`
- Modify: `tests/e2e/mobile-touch.spec.ts`

- [ ] **Step 1: Tighten desktop visual assertions**

After town entry, assert:

```ts
const visibleTown = await inspectTownCanvas(page);
expect(visibleTown.opaqueRatio).toBeGreaterThan(0.95);
expect(visibleTown.variedRatio).toBeGreaterThan(0.55);
expect(visibleTown.distinctColorBuckets).toBeGreaterThan(28);
await expect(page.locator('.game-surface canvas')).toHaveScreenshot('layered-town-desktop.png');
```

- [ ] **Step 2: Add the mobile town screenshot assertion**

At `390 x 844`, enter town, assert the canvas and town controls do not overlap the command dock, then capture `layered-town-mobile.png`.

- [ ] **Step 3: Run focused unit tests and build**

Run: `pnpm --filter @cat-house/web test`

Expected: PASS.

Run: `pnpm --filter @cat-house/web build`

Expected: PASS.

- [ ] **Step 4: Run focused Playwright coverage**

Run: `pnpm test:e2e -- tests/e2e/pet-town.spec.ts tests/e2e/mobile-touch.spec.ts`

Expected: PASS with nonblank desktop and mobile screenshots. Inspect both screenshots for blocked entrances, empty color fields, incoherent occlusion, clipped bubbles, and control overlap.

- [ ] **Step 5: Commit E2E expectations**

```bash
git add tests/e2e/pet-town.spec.ts tests/e2e/mobile-touch.spec.ts
git commit -m "test: verify layered pet town presentation"
```

### Task 7: Final visual-redesign verification

**Files:**
- Modify only when a verification failure exposes a defect.

- [ ] **Step 1: Run static checks**

Run: `pnpm lint && pnpm typecheck`

Expected: both commands PASS.

- [ ] **Step 2: Run all unit and integration tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Run the full build**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 4: Review changed assets and source**

Run: `git diff --check && git status --short`

Expected: no whitespace errors, no build output, reports, local databases, credentials, or unrelated files.

- [ ] **Step 5: Commit any verification-only correction**

If a correction was necessary, stage only its focused files and commit with `fix: correct layered town verification defect`. If no correction was necessary, do not create an empty commit.
