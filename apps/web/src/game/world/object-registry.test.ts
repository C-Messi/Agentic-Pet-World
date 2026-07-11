import { describe, expect, it } from 'vitest';

import { ROOM_OBJECTS, getWorldObject } from './object-registry';

describe('room object registry', () => {
  it('exposes every agent-visible object under a stable unique ID', () => {
    expect(ROOM_OBJECTS.map(({ id }) => id)).toEqual([
      'bed',
      'sofa',
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
  });
});
