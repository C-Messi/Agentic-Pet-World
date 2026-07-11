import { describe, expect, it } from 'vitest';

import { AmbientBehaviorSystem } from '../behavior/ambient-behavior';
import { NavigationSystem } from '../navigation/navigation-system';
import { WorldRuntimeState } from './world-runtime-state';

describe('WorldRuntimeState', () => {
  it('resets scene transients, navigation reservations, and ambient scheduling', () => {
    let now = 10_000;
    const navigation = new NavigationSystem({ width: 4, height: 4 });
    const ambient = new AmbientBehaviorSystem({
      random: () => 0,
      now: () => now,
      cooldownMs: 5_000,
    });
    const state = new WorldRuntimeState();

    navigation.reserve({ x: 2, y: 2 }, 'old-action');
    ambient.select({ agentBusy: false, blockedObjectIds: new Set(), wanderTiles: [{ x: 1, y: 1 }] });
    state.path = [{ x: 2, y: 2 }];
    state.movementOwner = 'old-action';
    state.currentTargetId = 'window';
    state.agentBusy = true;
    state.ambientSettledUntil = now + 10_000;
    state.currentEmotion = 'curious';
    state.pendingEmotion = 'sleep';

    state.reset(navigation, ambient);

    expect(state).toMatchObject({
      path: [],
      movementOwner: null,
      currentTargetId: undefined,
      agentBusy: false,
      ambientSettledUntil: 0,
      currentEmotion: 'idle',
      pendingEmotion: 'idle',
    });
    expect(navigation.reserve({ x: 2, y: 2 }, 'new-action')).toBe(true);
    expect(ambient.isEligible(false)).toBe(true);

    now += 1;
  });
});
