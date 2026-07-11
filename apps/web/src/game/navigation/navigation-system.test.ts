import { describe, expect, it } from 'vitest';

import { NavigationSystem } from './navigation-system';

describe('NavigationSystem', () => {
  it('finds a shortest orthogonal path around obstacles', () => {
    const navigation = new NavigationSystem({
      width: 6,
      height: 5,
      blocked: [
        { x: 2, y: 0 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 2, y: 3 },
      ],
    });

    const path = navigation.findPath({ x: 0, y: 1 }, { x: 5, y: 1 });

    expect(path.at(0)).toEqual({ x: 0, y: 1 });
    expect(path.at(-1)).toEqual({ x: 5, y: 1 });
    expect(path).toHaveLength(12);
    expect(path).not.toContainEqual({ x: 2, y: 1 });
  });

  it('returns an empty path when the destination is unreachable', () => {
    const navigation = new NavigationSystem({
      width: 3,
      height: 3,
      blocked: [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
      ],
    });

    expect(navigation.findPath({ x: 0, y: 1 }, { x: 2, y: 1 })).toEqual([]);
  });

  it('reserves interaction tiles per action owner', () => {
    const navigation = new NavigationSystem({ width: 4, height: 4 });
    const tile = { x: 2, y: 2 };

    expect(navigation.reserve(tile, 'ambient')).toBe(true);
    expect(navigation.reserve(tile, 'agent')).toBe(false);
    expect(navigation.findPath({ x: 0, y: 0 }, tile, 'agent')).toEqual([]);
    expect(navigation.findPath({ x: 0, y: 0 }, tile, 'ambient').at(-1)).toEqual(tile);

    navigation.release('ambient');
    expect(navigation.reserve(tile, 'agent')).toBe(true);
  });
});
