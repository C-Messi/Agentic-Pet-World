import { describe, expect, it } from 'vitest';

import { TOWN_ZONES, TownNavigation } from '../town/town-navigation';
import {
  DEFAULT_TOWN_SPAWNS,
  TOWN_CAMERA_LAYOUT,
  TOWN_ZONE_PRESENTATIONS,
} from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

const EXPECTED_ZONE_FRAMES = {
  'fortune-pavilion': [28, 29, 30, 31],
  garden: [32, 33, 34],
  market: [35, 36, 37],
  'arcade-house': [38, 39, 40, 41],
  'build-plots': [42, 43, 44],
  gate: [45, 46, 47],
  plaza: [61, 62],
} as const;

const EXPECTED_SIGN_FRAMES = {
  gate: 17,
  plaza: 23,
  'fortune-pavilion': 18,
  market: 19,
  garden: 20,
  'build-plots': 21,
  'arcade-house': 22,
} as const;

describe('TownScene state', () => {
  it('provides five stable resident spawn positions', () => {
    expect(DEFAULT_TOWN_SPAWNS).toEqual({
      'player-cat': { x: 10, y: 9 },
      'resident-mikan': { x: 10, y: 6 },
      'resident-huihui': { x: 4, y: 3 },
      'resident-lanlan': { x: 15, y: 4 },
      'resident-doubao': { x: 15, y: 7 },
    });
    expect(Object.keys(DEFAULT_TOWN_SPAWNS)).toHaveLength(5);
    expect(
      new Set(Object.values(DEFAULT_TOWN_SPAWNS).map(({ x, y }) => `${x}:${y}`))
        .size,
    ).toBe(5);
  });

  it('keeps every default resident spawn walkable', () => {
    const navigation = new TownNavigation();
    for (const position of Object.values(DEFAULT_TOWN_SPAWNS)) {
      expect(navigation.isBlocked(position)).toBe(false);
    }
  });

  it('provides ordered layered parts for every shared town zone', () => {
    const byId = new Map(TOWN_ZONES.map((zone) => [zone.id, zone]));
    const presentations = Object.values(TOWN_ZONE_PRESENTATIONS);

    expect(Object.keys(TOWN_ZONE_PRESENTATIONS).sort()).toEqual(
      TOWN_ZONES.map(({ id }) => id).sort(),
    );

    for (const presentation of presentations) {
      const zone = byId.get(presentation.zoneId);
      expect(zone).toBeDefined();
      if (!zone) continue;
      expect(presentation.entrance).toEqual(zone.entrance);
      expect(presentation.signFrame).toBe(
        EXPECTED_SIGN_FRAMES[presentation.zoneId],
      );
      expect(presentation.parts.length).toBeGreaterThanOrEqual(2);
      expect(presentation.parts.map(({ frame }) => frame)).toEqual(
        EXPECTED_ZONE_FRAMES[presentation.zoneId],
      );

      for (const part of presentation.parts) {
        expect(Number.isInteger(part.frame)).toBe(true);
        expect(part.frame).toBeGreaterThanOrEqual(0);
        expect(isInsideZone(part.anchor, zone.bounds)).toBe(true);
        expect(Number.isInteger(part.offset.x)).toBe(true);
        expect(Number.isInteger(part.offset.y)).toBe(true);
        expect(Number.isInteger(part.depthOffset)).toBe(true);
        expect(typeof part.foreground).toBe('boolean');
        for (const cell of part.collisionCells) {
          expect(isInsideZone(cell, zone.bounds)).toBe(true);
        }
      }
    }
  });

  it('deep-freezes layered presentation metadata', () => {
    expect(Object.isFrozen(TOWN_ZONE_PRESENTATIONS)).toBe(true);

    for (const presentation of Object.values(TOWN_ZONE_PRESENTATIONS)) {
      expect(Object.isFrozen(presentation)).toBe(true);
      expect(Object.isFrozen(presentation.entrance)).toBe(true);
      expect(Object.isFrozen(presentation.parts)).toBe(true);

      for (const part of presentation.parts) {
        expect(Object.isFrozen(part)).toBe(true);
        expect(Object.isFrozen(part.anchor)).toBe(true);
        expect(Object.isFrozen(part.offset)).toBe(true);
        expect(Object.isFrozen(part.collisionCells)).toBe(true);
        for (const cell of part.collisionCells) {
          expect(Object.isFrozen(cell)).toBe(true);
        }
      }
    }
  });

  it('fills the camera width while keeping the complete town visible', () => {
    const visibleWidth =
      TOWN_CAMERA_LAYOUT.viewport.width / TOWN_CAMERA_LAYOUT.zoom;
    const visibleHeight =
      TOWN_CAMERA_LAYOUT.viewport.height / TOWN_CAMERA_LAYOUT.zoom;
    const visibleLeft = (TOWN_CAMERA_LAYOUT.world.width - visibleWidth) / 2;
    const visibleTop = (TOWN_CAMERA_LAYOUT.world.height - visibleHeight) / 2;

    expect(visibleWidth).toBe(TOWN_CAMERA_LAYOUT.background.width);
    expect(visibleLeft).toBe(TOWN_CAMERA_LAYOUT.background.x);
    expect(TOWN_CAMERA_LAYOUT.background.y).toBeGreaterThanOrEqual(visibleTop);
    expect(visibleHeight).toBeGreaterThanOrEqual(
      TOWN_CAMERA_LAYOUT.background.height,
    );
    expect(
      TOWN_CAMERA_LAYOUT.background.y + TOWN_CAMERA_LAYOUT.background.height,
    ).toBeLessThanOrEqual(visibleTop + visibleHeight);
  });

  it('switches camera follow and keeps bubbles owned by one resident', () => {
    const state = new TownSceneState();
    expect(state.followedResidentId).toBe('player-cat');

    state.follow('resident-mikan');
    state.showBubble('resident-mikan', '来抽签吧');
    expect(state.followedResidentId).toBe('resident-mikan');
    expect(state.bubble).toEqual({
      ownerId: 'resident-mikan',
      text: '来抽签吧',
    });

    state.showBubble('resident-huihui', '等等我');
    expect(state.bubble?.ownerId).toBe('resident-huihui');
  });
});

function isInsideZone(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}
