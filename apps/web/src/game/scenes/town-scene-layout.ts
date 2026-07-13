import {
  TOWN_ZONE_LAYOUT,
  type Position,
  type TownZoneId,
} from '@cat-house/shared';

export type TownRenderPart = {
  readonly frame: number;
  readonly anchor: Readonly<Position>;
  readonly offset: Readonly<Position>;
  readonly depthOffset: number;
  readonly collisionCells: readonly Readonly<Position>[];
  readonly foreground: boolean;
};

export type TownZonePresentation = {
  readonly zoneId: TownZoneId;
  readonly entrance: Readonly<Position>;
  readonly signFrame: number;
  readonly parts: readonly TownRenderPart[];
};

export const TOWN_CAMERA_LAYOUT = {
  viewport: { width: 768, height: 512 },
  world: { width: 768, height: 512 },
  background: { x: 64, y: 64, width: 640, height: 360 },
  zoom: 1.2,
} as const;

export const DEFAULT_TOWN_SPAWNS: Readonly<Record<string, Position>> = {
  'player-cat': TOWN_ZONE_LAYOUT.gate.entrance,
  'resident-mikan': TOWN_ZONE_LAYOUT.plaza.entrance,
  'resident-huihui': TOWN_ZONE_LAYOUT['fortune-pavilion'].entrance,
  'resident-lanlan': TOWN_ZONE_LAYOUT.market.entrance,
  'resident-doubao': TOWN_ZONE_LAYOUT['build-plots'].entrance,
};

export const TOWN_ZONE_PRESENTATIONS: Readonly<
  Record<TownZoneId, TownZonePresentation>
> = deepFreeze({
  gate: {
    zoneId: 'gate',
    entrance: TOWN_ZONE_LAYOUT.gate.entrance,
    signFrame: 17,
    parts: [
      renderPart(45, { x: 9, y: 8 }, { x: 0, y: -12 }, -12),
      renderPart(46, { x: 11, y: 8 }, { x: 0, y: -12 }, -12),
      renderPart(47, { x: 10, y: 10 }, { x: 0, y: 12 }, 0, [], true),
    ],
  },
  plaza: {
    zoneId: 'plaza',
    entrance: TOWN_ZONE_LAYOUT.plaza.entrance,
    signFrame: 23,
    parts: [
      renderPart(61, { x: 9, y: 5 }, { x: 0, y: 0 }, 8),
      renderPart(62, { x: 12, y: 4 }, { x: 0, y: -8 }, -4),
    ],
  },
  'fortune-pavilion': {
    zoneId: 'fortune-pavilion',
    entrance: TOWN_ZONE_LAYOUT['fortune-pavilion'].entrance,
    signFrame: 18,
    parts: [
      renderPart(28, { x: 2, y: 2 }, { x: 0, y: -20 }, -16),
      renderPart(29, { x: 4, y: 2 }, { x: 0, y: -20 }, -16),
      renderPart(30, { x: 2, y: 2 }, { x: 0, y: 0 }, 8, [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
      ]),
      renderPart(31, { x: 4, y: 2 }, { x: 0, y: 0 }, 8, [
        { x: 3, y: 1 },
        { x: 4, y: 1 },
        { x: 3, y: 2 },
        { x: 4, y: 2 },
      ]),
    ],
  },
  market: {
    zoneId: 'market',
    entrance: TOWN_ZONE_LAYOUT.market.entrance,
    signFrame: 19,
    parts: [
      renderPart(35, { x: 15, y: 2 }, { x: 0, y: 0 }, 4, [
        { x: 14, y: 1 },
        { x: 15, y: 1 },
        { x: 14, y: 2 },
        { x: 15, y: 2 },
      ]),
      renderPart(36, { x: 16, y: 2 }, { x: 0, y: 0 }, 5, [
        { x: 16, y: 1 },
        { x: 16, y: 2 },
      ]),
      renderPart(37, { x: 17, y: 2 }, { x: 0, y: 0 }, 6, [
        { x: 17, y: 1 },
        { x: 18, y: 1 },
        { x: 17, y: 2 },
        { x: 18, y: 2 },
      ]),
    ],
  },
  garden: {
    zoneId: 'garden',
    entrance: TOWN_ZONE_LAYOUT.garden.entrance,
    signFrame: 20,
    parts: [
      renderPart(32, { x: 9, y: 2 }, { x: 0, y: 0 }, 6, [
        { x: 8, y: 1 },
        { x: 9, y: 1 },
        { x: 8, y: 2 },
        { x: 9, y: 2 },
      ]),
      renderPart(33, { x: 11, y: 2 }, { x: 0, y: 0 }, 6, [
        { x: 10, y: 1 },
        { x: 11, y: 1 },
        { x: 10, y: 2 },
        { x: 11, y: 2 },
      ]),
      renderPart(34, { x: 10, y: 2 }, { x: 0, y: 4 }, 10),
    ],
  },
  'build-plots': {
    zoneId: 'build-plots',
    entrance: TOWN_ZONE_LAYOUT['build-plots'].entrance,
    signFrame: 21,
    parts: [
      renderPart(42, { x: 15, y: 6 }, { x: 0, y: 0 }, 6, [
        { x: 14, y: 5 },
        { x: 15, y: 5 },
        { x: 14, y: 6 },
        { x: 15, y: 6 },
      ]),
      renderPart(43, { x: 17, y: 6 }, { x: 0, y: 0 }, 6, [
        { x: 16, y: 5 },
        { x: 17, y: 5 },
        { x: 16, y: 6 },
        { x: 17, y: 6 },
      ]),
      renderPart(44, { x: 18, y: 7 }, { x: 0, y: 4 }, 4),
    ],
  },
  'arcade-house': {
    zoneId: 'arcade-house',
    entrance: TOWN_ZONE_LAYOUT['arcade-house'].entrance,
    signFrame: 22,
    parts: [
      renderPart(38, { x: 2, y: 6 }, { x: 0, y: -20 }, -16),
      renderPart(39, { x: 4, y: 6 }, { x: 0, y: -20 }, -16),
      renderPart(40, { x: 2, y: 6 }, { x: 0, y: 0 }, 8, [
        { x: 1, y: 5 },
        { x: 2, y: 5 },
        { x: 1, y: 6 },
        { x: 2, y: 6 },
      ]),
      renderPart(41, { x: 4, y: 6 }, { x: 0, y: 0 }, 8, [
        { x: 3, y: 5 },
        { x: 4, y: 5 },
        { x: 3, y: 6 },
        { x: 4, y: 6 },
      ]),
    ],
  },
} satisfies Record<TownZoneId, TownZonePresentation>);

function renderPart(
  frame: number,
  anchor: Position,
  offset: Position,
  depthOffset: number,
  collisionCells: readonly Position[] = [],
  foreground = false,
): TownRenderPart {
  return {
    frame,
    anchor,
    offset,
    depthOffset,
    collisionCells,
    foreground,
  };
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
