import { describe, expect, it } from 'vitest';

import { TOWN_ZONES, TownNavigation } from './town-navigation';

describe('TownNavigation', () => {
  it('registers every activity zone and keeps its entrance reachable', () => {
    const navigation = new TownNavigation();

    expect(TOWN_ZONES.map(({ id }) => id)).toEqual([
      'gate', 'plaza', 'fortune-pavilion', 'market', 'garden', 'build-plots', 'arcade-house',
    ]);
    for (const zone of TOWN_ZONES) {
      expect(navigation.findPath({ x: 2, y: 9 }, zone.entrance).length).toBeGreaterThan(0);
    }
  });

  it('adds and replaces dynamic build occupancy', () => {
    const navigation = new TownNavigation();
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(false);

    navigation.restoreModifications([{ occupiedCells: [{ x: 11, y: 7 }], collision: true }]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(true);

    navigation.restoreModifications([]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(false);
  });
});
