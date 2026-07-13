import { describe, expect, it } from 'vitest';

import { TOWN_ZONES, TownNavigation } from '../town/town-navigation';
import {
  DEFAULT_TOWN_SPAWNS,
  TOWN_CAMERA_LAYOUT,
  TOWN_ZONE_PRESENTATIONS,
} from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

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

  it('provides a distinct visual presentation for every town zone', () => {
    const byId = new Map(TOWN_ZONES.map((zone) => [zone.id, zone]));
    const presentations = Object.values(TOWN_ZONE_PRESENTATIONS);

    expect(Object.keys(TOWN_ZONE_PRESENTATIONS).sort()).toEqual(
      TOWN_ZONES.map(({ id }) => id).sort(),
    );
    expect(new Set(presentations.map(({ label }) => label)).size).toBe(
      TOWN_ZONES.length,
    );
    expect(
      new Set(presentations.map(({ landmarkFrame }) => landmarkFrame)).size,
    ).toBe(TOWN_ZONES.length);

    for (const presentation of presentations) {
      const zone = byId.get(presentation.zoneId);
      expect(zone).toBeDefined();
      if (!zone) continue;
      expect(presentation.entrance).toEqual(zone.entrance);
      expect(isInsideZone(presentation.labelTile, zone.bounds)).toBe(true);
      expect(isInsideZone(presentation.landmarkTile, zone.bounds)).toBe(true);
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
