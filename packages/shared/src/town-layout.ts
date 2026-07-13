import type { Position } from './protocol.js';
import type { TownZoneId } from './town.js';

export type EncounterPair = readonly [Readonly<Position>, Readonly<Position>];

export type TownZoneLayout = {
  readonly id: TownZoneId;
  readonly bounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  readonly entrance: Readonly<Position>;
  readonly encounterPairs: readonly EncounterPair[];
};

export const TOWN_GRID = deepFreeze({
  width: 20,
  height: 11,
  tileSize: 32,
} as const);

export const TOWN_ZONE_LAYOUT = deepFreeze([
  {
    id: 'gate',
    bounds: { x: 8, y: 8, width: 4, height: 3 },
    entrance: { x: 10, y: 9 },
    encounterPairs: [
      [
        { x: 9, y: 9 },
        { x: 10, y: 9 },
      ],
    ],
  },
  {
    id: 'plaza',
    bounds: { x: 7, y: 4, width: 6, height: 4 },
    entrance: { x: 10, y: 6 },
    encounterPairs: [
      [
        { x: 9, y: 6 },
        { x: 11, y: 6 },
      ],
      [
        { x: 10, y: 5 },
        { x: 10, y: 7 },
      ],
    ],
  },
  {
    id: 'fortune-pavilion',
    bounds: { x: 1, y: 1, width: 5, height: 3 },
    entrance: { x: 4, y: 3 },
    encounterPairs: [
      [
        { x: 3, y: 3 },
        { x: 5, y: 3 },
      ],
    ],
  },
  {
    id: 'market',
    bounds: { x: 14, y: 1, width: 5, height: 4 },
    entrance: { x: 15, y: 4 },
    encounterPairs: [
      [
        { x: 15, y: 4 },
        { x: 16, y: 4 },
      ],
    ],
  },
  {
    id: 'garden',
    bounds: { x: 7, y: 1, width: 6, height: 3 },
    entrance: { x: 10, y: 3 },
    encounterPairs: [
      [
        { x: 9, y: 3 },
        { x: 11, y: 3 },
      ],
    ],
  },
  {
    id: 'build-plots',
    bounds: { x: 14, y: 5, width: 5, height: 3 },
    entrance: { x: 15, y: 7 },
    encounterPairs: [
      [
        { x: 15, y: 7 },
        { x: 16, y: 7 },
      ],
    ],
  },
  {
    id: 'arcade-house',
    bounds: { x: 1, y: 5, width: 5, height: 3 },
    entrance: { x: 5, y: 7 },
    encounterPairs: [
      [
        { x: 4, y: 7 },
        { x: 5, y: 7 },
      ],
    ],
  },
] as const satisfies readonly TownZoneLayout[]);

export const TOWN_STATIC_BLOCKED_CELLS: readonly Readonly<Position>[] =
  deepFreeze(createStaticBlockedCells());

function createStaticBlockedCells(): Position[] {
  const cells: Position[] = [];

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
  ] as const) {
    for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
      for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
        cells.push({ x, y });
      }
    }
  }

  return cells;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key) as unknown);
    }
    Object.freeze(value);
  }
  return value;
}
