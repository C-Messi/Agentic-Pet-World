import type { Position, TownZoneId } from '@cat-house/shared';

export type TownZonePresentation = {
  zoneId: TownZoneId;
  label: string;
  entrance: Position;
  labelTile: Position;
  landmarkTile: Position;
  landmarkFrame: number;
  signFrame: number;
};

export const TOWN_CAMERA_LAYOUT = {
  viewport: { width: 768, height: 512 },
  world: { width: 768, height: 512 },
  background: { x: 64, y: 64, width: 640, height: 360 },
  zoom: 1.2,
} as const;

export const DEFAULT_TOWN_SPAWNS: Readonly<Record<string, Position>> = {
  'player-cat': { x: 3, y: 9 },
  'resident-mikan': { x: 9, y: 6 },
  'resident-huihui': { x: 5, y: 7 },
  'resident-lanlan': { x: 15, y: 5 },
  'resident-doubao': { x: 15, y: 8 },
};

export const TOWN_ZONE_PRESENTATIONS = {
  gate: {
    zoneId: 'gate',
    label: '小镇门口',
    entrance: { x: 2, y: 9 },
    labelTile: { x: 1, y: 8 },
    landmarkTile: { x: 0, y: 9 },
    landmarkFrame: 0,
    signFrame: 17,
  },
  plaza: {
    zoneId: 'plaza',
    label: '中心广场',
    entrance: { x: 10, y: 6 },
    labelTile: { x: 12, y: 4 },
    landmarkTile: { x: 8, y: 5 },
    landmarkFrame: 1,
    signFrame: 23,
  },
  'fortune-pavilion': {
    zoneId: 'fortune-pavilion',
    label: '占卜亭',
    entrance: { x: 4, y: 4 },
    labelTile: { x: 3, y: 2 },
    landmarkTile: { x: 3, y: 3 },
    landmarkFrame: 2,
    signFrame: 18,
  },
  market: {
    zoneId: 'market',
    label: '市集摊位',
    entrance: { x: 15, y: 5 },
    labelTile: { x: 16, y: 2 },
    landmarkTile: { x: 17, y: 3 },
    landmarkFrame: 3,
    signFrame: 19,
  },
  garden: {
    zoneId: 'garden',
    label: '花园',
    entrance: { x: 5, y: 7 },
    labelTile: { x: 1, y: 5 },
    landmarkTile: { x: 4, y: 6 },
    landmarkFrame: 7,
    signFrame: 20,
  },
  'build-plots': {
    zoneId: 'build-plots',
    label: '建造地块',
    entrance: { x: 10, y: 8 },
    labelTile: { x: 12, y: 10 },
    landmarkTile: { x: 9, y: 9 },
    landmarkFrame: 24,
    signFrame: 21,
  },
  'arcade-house': {
    zoneId: 'arcade-house',
    label: '街机屋',
    entrance: { x: 15, y: 8 },
    labelTile: { x: 18, y: 6 },
    landmarkTile: { x: 17, y: 8 },
    landmarkFrame: 8,
    signFrame: 22,
  },
} satisfies Readonly<Record<TownZoneId, TownZonePresentation>>;
