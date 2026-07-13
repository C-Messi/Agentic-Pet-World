import { describe, expect, it } from 'vitest';

import { DEFAULT_TOWN_SPAWNS } from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

describe('TownScene state', () => {
  it('provides five stable resident spawn positions', () => {
    expect(Object.keys(DEFAULT_TOWN_SPAWNS)).toHaveLength(5);
    expect(new Set(Object.values(DEFAULT_TOWN_SPAWNS).map(({ x, y }) => `${x}:${y}`)).size).toBe(5);
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
