import { describe, expect, it } from 'vitest';

import { AmbientBehaviorSystem, type AmbientContext } from './ambient-behavior';

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function context(overrides: Partial<AmbientContext> = {}): AmbientContext {
  return {
    agentBusy: false,
    blockedObjectIds: new Set(),
    wanderTiles: [
      { x: 10, y: 8 },
      { x: 14, y: 10 },
    ],
    ...overrides,
  };
}

describe('AmbientBehaviorSystem', () => {
  it('never schedules while an agent action is running', () => {
    const system = new AmbientBehaviorSystem({ random: seededRandom(1), now: () => 10_000 });

    expect(system.select(context({ agentBusy: true }))).toBeNull();
  });

  it('filters blocked object targets before weighted selection', () => {
    const system = new AmbientBehaviorSystem({ random: () => 0.999, now: () => 10_000 });
    const blockedObjectIds = new Set([
      'bed',
      'sofa',
      'bookshelf',
      'toy-basket',
      'arcade',
      'food-bowl',
      'window',
    ]);

    const selected = system.select(context({ blockedObjectIds }));

    expect(selected?.type).toBe('wander');
    expect(selected && 'targetId' in selected ? selected.targetId : undefined).toBeUndefined();
  });

  it('respects its cooldown using the injected clock', () => {
    let now = 20_000;
    const system = new AmbientBehaviorSystem({
      cooldownMs: 5_000,
      random: seededRandom(7),
      now: () => now,
    });

    expect(system.select(context())).not.toBeNull();
    now += 4_999;
    expect(system.select(context())).toBeNull();
    now += 1;
    expect(system.select(context())).not.toBeNull();
  });

  it('deterministically chooses every supported idle behavior', () => {
    let now = 100_000;
    const system = new AmbientBehaviorSystem({
      cooldownMs: 1,
      random: seededRandom(42),
      now: () => now,
    });
    const selected = new Set<string>();

    for (let index = 0; index < 80; index += 1) {
      now += 1;
      selected.add(system.select(context())?.type ?? 'none');
    }

    expect(selected).toEqual(new Set(['rest', 'wander', 'inspect', 'look_outside']));
  });
});
