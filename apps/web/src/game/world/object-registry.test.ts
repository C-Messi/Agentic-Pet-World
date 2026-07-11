import { describe, expect, it } from 'vitest';

import { NavigationSystem } from '../navigation/navigation-system';
import {
  CAT_SPAWN_TILE,
  ROOM_GRID,
  ROOM_OBJECTS,
  createRoomBlockedTiles,
  getWorldObject,
} from './object-registry';

describe('room object registry', () => {
  it('exposes every agent-visible object under a stable unique ID', () => {
    expect(ROOM_OBJECTS.map(({ id }) => id)).toEqual([
      'bed',
      'sofa',
      'rug',
      'window',
      'food-bowl',
      'bookshelf',
      'toy-basket',
      'arcade',
    ]);
    expect(new Set(ROOM_OBJECTS.map(({ id }) => id)).size).toBe(ROOM_OBJECTS.length);
  });

  it('defines unique walk targets and only valid interactions', () => {
    const validInteractions = new Set(['inspect', 'rest', 'eat', 'play', 'open']);
    const targetKeys = ROOM_OBJECTS.map(({ walkTarget }) => `${walkTarget.x},${walkTarget.y}`);

    expect(new Set(targetKeys).size).toBe(targetKeys.length);
    expect(ROOM_OBJECTS.every(({ interactions }) => interactions.length > 0)).toBe(true);
    expect(
      ROOM_OBJECTS.every(({ interactions }) =>
        interactions.every((interaction) => validInteractions.has(interaction)),
      ),
    ).toBe(true);
    expect(getWorldObject('arcade').interactions).toContain('open');
    expect(getWorldObject('rug').interactions).toEqual(['inspect', 'rest']);
  });

  it('keeps every interaction target walkable and reachable from the cat spawn', () => {
    const navigation = new NavigationSystem({
      width: ROOM_GRID.width,
      height: ROOM_GRID.height,
      blocked: createRoomBlockedTiles(),
    });

    for (const object of ROOM_OBJECTS) {
      expect(navigation.isWalkable(object.walkTarget), object.id).toBe(true);
      expect(navigation.findPath(CAT_SPAWN_TILE, object.walkTarget), object.id).not.toEqual([]);
    }

    expect(getWorldObject('window').interactions).toContain('open');
  });
});
