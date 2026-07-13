import { describe, expect, it } from 'vitest';

import { TOWN_ZONES } from '../town/town-navigation';
import {
  DEFAULT_TOWN_SPAWNS,
  TOWN_ZONE_PRESENTATIONS,
} from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

describe('TownScene state', () => {
  it('provides five stable resident spawn positions', () => {
    expect(Object.keys(DEFAULT_TOWN_SPAWNS)).toHaveLength(5);
    expect(new Set(Object.values(DEFAULT_TOWN_SPAWNS).map(({ x, y }) => `${x}:${y}`)).size).toBe(5);
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
    expect(new Set(presentations.map(({ landmarkFrame }) => landmarkFrame)).size).toBe(
      TOWN_ZONES.length,
    );

    for (const presentation of presentations) {
      const zone = byId.get(presentation.zoneId);
      expect(zone).toBeDefined();
      if (!zone) continue;
      expect(presentation.entrance).toEqual(zone.entrance);
      expect(isInsideZone(presentation.labelTile, zone.bounds)).toBe(true);
      expect(isInsideZone(presentation.landmarkTile, zone.bounds)).toBe(true);
    }
  });

  it('switches camera follow and keeps bubbles owned by one resident', () => {
    const state = new TownSceneState();
    expect(state.followedResidentId).toBe('player-cat');

    state.follow('resident-mikan');
    state.showBubble('resident-mikan', '来抽签吧');
    expect(state.followedResidentId).toBe('resident-mikan');
    expect(state.bubble).toEqual({ ownerId: 'resident-mikan', text: '来抽签吧' });

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
