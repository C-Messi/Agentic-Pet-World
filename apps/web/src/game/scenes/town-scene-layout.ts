import type { Position } from '@cat-house/shared';

export const DEFAULT_TOWN_SPAWNS: Readonly<Record<string, Position>> = {
  'player-cat': { x: 3, y: 9 },
  'resident-mikan': { x: 9, y: 6 },
  'resident-huihui': { x: 5, y: 7 },
  'resident-lanlan': { x: 15, y: 5 },
  'resident-doubao': { x: 15, y: 8 },
};
