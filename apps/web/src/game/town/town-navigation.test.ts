import { describe, expect, it } from 'vitest';

import { TOWN_ZONES, TownNavigation } from './town-navigation';

const EXPECTED_TOWN_ZONES = [
  {
    id: 'gate',
    bounds: { x: 8, y: 8, width: 4, height: 3 },
    entrance: { x: 10, y: 9 },
  },
  {
    id: 'plaza',
    bounds: { x: 7, y: 4, width: 6, height: 4 },
    entrance: { x: 10, y: 6 },
  },
  {
    id: 'fortune-pavilion',
    bounds: { x: 1, y: 1, width: 5, height: 3 },
    entrance: { x: 4, y: 3 },
  },
  {
    id: 'market',
    bounds: { x: 14, y: 1, width: 5, height: 4 },
    entrance: { x: 15, y: 4 },
  },
  {
    id: 'garden',
    bounds: { x: 7, y: 1, width: 6, height: 3 },
    entrance: { x: 10, y: 3 },
  },
  {
    id: 'build-plots',
    bounds: { x: 14, y: 5, width: 5, height: 3 },
    entrance: { x: 15, y: 7 },
  },
  {
    id: 'arcade-house',
    bounds: { x: 1, y: 5, width: 5, height: 3 },
    entrance: { x: 5, y: 7 },
  },
] as const;

describe('TownNavigation', () => {
  it('projects every shared zone in the approved stable order', () => {
    expect(TOWN_ZONES).toEqual(EXPECTED_TOWN_ZONES);
  });

  it('keeps every activity entrance reachable from the gate', () => {
    const navigation = new TownNavigation();
    const gate = TOWN_ZONES[0]!;

    for (const zone of TOWN_ZONES) {
      expect(
        navigation.findPath(gate.entrance, zone.entrance).length,
      ).toBeGreaterThan(0);
    }
  });

  it('blocks buildings and water while leaving the gate bridge open', () => {
    const navigation = new TownNavigation();

    for (const position of [
      { x: 1, y: 1 },
      { x: 7, y: 2 },
      { x: 18, y: 1 },
      { x: 5, y: 6 },
      { x: 14, y: 5 },
      { x: 0, y: 8 },
      { x: 19, y: 10 },
    ]) {
      expect(navigation.isBlocked(position)).toBe(true);
    }
    expect(navigation.isBlocked({ x: 10, y: 10 })).toBe(false);
  });

  it('finds a route from the gate to the plaza', () => {
    const navigation = new TownNavigation();
    expect(navigation.findPath({ x: 10, y: 9 }, { x: 10, y: 6 })).toEqual([
      { x: 10, y: 9 },
      { x: 10, y: 8 },
      { x: 10, y: 7 },
      { x: 10, y: 6 },
    ]);
  });

  it('replaces dynamic occupancy without clearing static collision', () => {
    const navigation = new TownNavigation();
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(false);
    expect(navigation.isBlocked({ x: 1, y: 1 })).toBe(true);

    navigation.restoreModifications([
      { occupiedCells: [{ x: 11, y: 7 }], collision: true },
    ]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(true);
    expect(navigation.isBlocked({ x: 1, y: 1 })).toBe(true);

    navigation.restoreModifications([]);
    expect(navigation.isBlocked({ x: 11, y: 7 })).toBe(false);
    expect(navigation.isBlocked({ x: 1, y: 1 })).toBe(true);
  });
});
