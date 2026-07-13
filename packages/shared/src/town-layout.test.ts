import { describe, expect, it } from 'vitest';

import {
  TOWN_ENCOUNTER_PAIRS,
  TOWN_GRID,
  TOWN_STATIC_BLOCKED_CELLS,
  TOWN_ZONE_LAYOUT,
  TOWN_ZONE_ORDER,
} from './town-layout.js';

const EXPECTED_ZONE_ORDER = [
  'gate',
  'plaza',
  'fortune-pavilion',
  'market',
  'garden',
  'build-plots',
  'arcade-house',
] as const;

const EXPECTED_ZONE_LAYOUT = {
  gate: {
    bounds: { x: 8, y: 8, width: 4, height: 3 },
    entrance: { x: 10, y: 9 },
  },
  plaza: {
    bounds: { x: 7, y: 4, width: 6, height: 4 },
    entrance: { x: 10, y: 6 },
  },
  'fortune-pavilion': {
    bounds: { x: 1, y: 1, width: 5, height: 3 },
    entrance: { x: 4, y: 3 },
  },
  market: {
    bounds: { x: 14, y: 1, width: 5, height: 4 },
    entrance: { x: 15, y: 4 },
  },
  garden: {
    bounds: { x: 7, y: 1, width: 6, height: 3 },
    entrance: { x: 10, y: 3 },
  },
  'build-plots': {
    bounds: { x: 14, y: 5, width: 5, height: 3 },
    entrance: { x: 15, y: 7 },
  },
  'arcade-house': {
    bounds: { x: 1, y: 5, width: 5, height: 3 },
    entrance: { x: 5, y: 7 },
  },
} as const;

const EXPECTED_ENCOUNTER_PAIRS = {
  gate: [
    [
      { x: 9, y: 9 },
      { x: 10, y: 9 },
    ],
  ],
  plaza: [
    [
      { x: 9, y: 6 },
      { x: 11, y: 6 },
    ],
    [
      { x: 10, y: 5 },
      { x: 10, y: 7 },
    ],
  ],
  'fortune-pavilion': [
    [
      { x: 3, y: 3 },
      { x: 5, y: 3 },
    ],
  ],
  market: [
    [
      { x: 15, y: 4 },
      { x: 16, y: 4 },
    ],
  ],
  garden: [
    [
      { x: 9, y: 3 },
      { x: 11, y: 3 },
    ],
  ],
  'build-plots': [
    [
      { x: 15, y: 7 },
      { x: 16, y: 7 },
    ],
  ],
  'arcade-house': [
    [
      { x: 4, y: 7 },
      { x: 5, y: 7 },
    ],
  ],
} as const;

describe('town layout', () => {
  it('defines the approved grid and keyed zone geometry exactly', () => {
    expect(TOWN_GRID).toEqual({ width: 20, height: 11, tileSize: 32 });
    expect(TOWN_ZONE_LAYOUT).toEqual(EXPECTED_ZONE_LAYOUT);
    expect(TOWN_ZONE_LAYOUT.gate.entrance).toEqual({ x: 10, y: 9 });
  });

  it('covers every zone in the approved stable order', () => {
    expect(TOWN_ZONE_ORDER).toEqual(EXPECTED_ZONE_ORDER);
    expect(Object.keys(TOWN_ZONE_LAYOUT)).toEqual(EXPECTED_ZONE_ORDER);
    expect(Object.keys(TOWN_ENCOUNTER_PAIRS)).toEqual(EXPECTED_ZONE_ORDER);
  });

  it('exports encounter pairs separately and keeps all positions walkable', () => {
    const blocked = new Set(
      TOWN_STATIC_BLOCKED_CELLS.map(({ x, y }) => `${x}:${y}`),
    );

    expect(TOWN_ENCOUNTER_PAIRS).toEqual(EXPECTED_ENCOUNTER_PAIRS);
    for (const zoneId of TOWN_ZONE_ORDER) {
      const zone = TOWN_ZONE_LAYOUT[zoneId];
      expect(inBounds(zone.entrance)).toBe(true);
      expect(blocked.has(key(zone.entrance))).toBe(false);

      for (const pair of TOWN_ENCOUNTER_PAIRS[zoneId]) {
        expect(pair).toHaveLength(2);
        expect(pair[0]).not.toEqual(pair[1]);
        for (const position of pair) {
          expect(inBounds(position)).toBe(true);
          expect(blocked.has(key(position))).toBe(false);
        }
      }
    }
  });

  it('deep-freezes every shared layout and encounter structure', () => {
    expect(Object.isFrozen(TOWN_GRID)).toBe(true);
    expect(Object.isFrozen(TOWN_ZONE_ORDER)).toBe(true);
    expect(Object.isFrozen(TOWN_ZONE_LAYOUT)).toBe(true);
    expect(Object.isFrozen(TOWN_ENCOUNTER_PAIRS)).toBe(true);

    for (const zoneId of TOWN_ZONE_ORDER) {
      const zone = TOWN_ZONE_LAYOUT[zoneId];
      const encounterPairs = TOWN_ENCOUNTER_PAIRS[zoneId];
      expect(Object.isFrozen(zone)).toBe(true);
      expect(Object.isFrozen(zone.bounds)).toBe(true);
      expect(Object.isFrozen(zone.entrance)).toBe(true);
      expect(Object.isFrozen(encounterPairs)).toBe(true);
      for (const pair of encounterPairs) {
        expect(Object.isFrozen(pair)).toBe(true);
        expect(pair.every((position) => Object.isFrozen(position))).toBe(true);
      }
    }
  });

  it('freezes a deterministic ordered set of static building and water cells', () => {
    expect(TOWN_STATIC_BLOCKED_CELLS).toEqual(expectedBlockedCells());
    expect(Object.isFrozen(TOWN_STATIC_BLOCKED_CELLS)).toBe(true);
    expect(
      TOWN_STATIC_BLOCKED_CELLS.every((cell) => Object.isFrozen(cell)),
    ).toBe(true);
  });
});

function expectedBlockedCells(): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let y = 8; y <= 10; y += 1) {
    for (let x = 0; x <= 19; x += 1) {
      if (x < 8 || x > 11) cells.push({ x, y });
    }
  }
  for (const bounds of [
    { x: 1, y: 1, width: 5, height: 2 },
    { x: 7, y: 1, width: 6, height: 2 },
    { x: 14, y: 1, width: 5, height: 2 },
    { x: 1, y: 5, width: 5, height: 2 },
    { x: 14, y: 5, width: 5, height: 2 },
  ]) {
    for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
        cells.push({ x, y });
      }
    }
  }
  return cells;
}

function key({ x, y }: { x: number; y: number }): string {
  return `${x}:${y}`;
}

function inBounds({ x, y }: { x: number; y: number }): boolean {
  return x >= 0 && y >= 0 && x < TOWN_GRID.width && y < TOWN_GRID.height;
}
