import { describe, expect, it } from 'vitest';

import { AmbientBehaviorSystem, type AmbientContext } from './ambient-behavior';
import { evaluateAmbientBehavior } from './ambient-evaluation';

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
      'rug',
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

  it('maps look_outside to the reachable window target', () => {
    const system = new AmbientBehaviorSystem({ random: () => 0.5, now: () => 10_000 });
    const blockedObjectIds = new Set([
      'bed',
      'sofa',
      'rug',
      'bookshelf',
      'toy-basket',
      'arcade',
      'food-bowl',
    ]);

    expect(system.select(context({ blockedObjectIds, wanderTiles: [] }))).toEqual({
      type: 'look_outside',
      targetId: 'window',
    });
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

  it('does not build pathfinding context before the next eligible evaluation', () => {
    let now = 20_000;
    let contextBuilds = 0;
    const system = new AmbientBehaviorSystem({
      cooldownMs: 5_000,
      random: () => 0,
      now: () => now,
    });
    const buildContext = () => {
      contextBuilds += 1;
      return context();
    };

    expect(evaluateAmbientBehavior(system, false, buildContext)).not.toBeNull();
    now += 4_999;
    expect(evaluateAmbientBehavior(system, false, buildContext)).toBeNull();
    expect(contextBuilds).toBe(1);
    now += 1;
    expect(evaluateAmbientBehavior(system, false, buildContext)).not.toBeNull();
    expect(contextBuilds).toBe(2);
  });

  it('bounds reevaluation when no ambient candidate is available', () => {
    let now = 30_000;
    let contextBuilds = 0;
    const system = new AmbientBehaviorSystem({
      noCandidateRetryMs: 1_000,
      random: () => 0,
      now: () => now,
    });
    const buildEmptyContext = () => {
      contextBuilds += 1;
      return context({
        blockedObjectIds: new Set([
          'bed',
          'sofa',
          'rug',
          'bookshelf',
          'toy-basket',
          'arcade',
          'food-bowl',
          'window',
        ]),
        wanderTiles: [],
      });
    };

    expect(evaluateAmbientBehavior(system, false, buildEmptyContext)).toBeNull();
    for (let elapsed = 1; elapsed < 1_000; elapsed += 100) {
      now = 30_000 + elapsed;
      expect(evaluateAmbientBehavior(system, false, buildEmptyContext)).toBeNull();
    }
    expect(contextBuilds).toBe(1);
    now = 31_000;
    expect(evaluateAmbientBehavior(system, false, buildEmptyContext)).toBeNull();
    expect(contextBuilds).toBe(2);
  });
});
