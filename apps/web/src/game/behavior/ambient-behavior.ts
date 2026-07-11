import type { WorldObjectId } from '@cat-house/shared';

import type { GridPoint } from '../world/object-registry';

export interface AmbientContext {
  agentBusy: boolean;
  blockedObjectIds: ReadonlySet<string>;
  wanderTiles: readonly GridPoint[];
}

export type AmbientAction =
  | { type: 'rest'; targetId: 'bed' | 'sofa' | 'rug' }
  | { type: 'wander'; tile: GridPoint }
  | { type: 'inspect'; targetId: 'bookshelf' | 'toy-basket' | 'arcade' | 'food-bowl' }
  | { type: 'look_outside'; targetId: 'window' };

interface AmbientBehaviorOptions {
  random: () => number;
  now: () => number;
  cooldownMs?: number;
}

interface WeightedAction {
  action: AmbientAction;
  weight: number;
  targetId?: WorldObjectId;
}

export class AmbientBehaviorSystem {
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private lastSelectedAt = Number.NEGATIVE_INFINITY;

  constructor({ random, now, cooldownMs = 8_000 }: AmbientBehaviorOptions) {
    this.random = random;
    this.now = now;
    this.cooldownMs = cooldownMs;
  }

  select(context: AmbientContext): AmbientAction | null {
    const currentTime = this.now();
    if (context.agentBusy || currentTime - this.lastSelectedAt < this.cooldownMs) return null;

    const candidates: WeightedAction[] = [
      { action: { type: 'rest', targetId: 'bed' }, weight: 2, targetId: 'bed' },
      { action: { type: 'rest', targetId: 'sofa' }, weight: 2, targetId: 'sofa' },
      { action: { type: 'rest', targetId: 'rug' }, weight: 2, targetId: 'rug' },
      ...context.wanderTiles.map((tile) => ({ action: { type: 'wander', tile } as const, weight: 3 })),
      { action: { type: 'inspect', targetId: 'bookshelf' }, weight: 1, targetId: 'bookshelf' },
      { action: { type: 'inspect', targetId: 'toy-basket' }, weight: 1, targetId: 'toy-basket' },
      { action: { type: 'inspect', targetId: 'arcade' }, weight: 1, targetId: 'arcade' },
      { action: { type: 'inspect', targetId: 'food-bowl' }, weight: 1, targetId: 'food-bowl' },
      { action: { type: 'look_outside', targetId: 'window' }, weight: 2, targetId: 'window' },
    ];
    const availableCandidates = candidates.filter(
      ({ targetId }) => !targetId || !context.blockedObjectIds.has(targetId),
    );

    if (availableCandidates.length === 0) return null;
    const totalWeight = availableCandidates.reduce((sum, candidate) => sum + candidate.weight, 0);
    let roll = Math.min(Math.max(this.random(), 0), 0.999_999_999) * totalWeight;
    const selected =
      availableCandidates.find((candidate) => {
        roll -= candidate.weight;
        return roll < 0;
      }) ?? availableCandidates[availableCandidates.length - 1];
    if (!selected) return null;

    this.lastSelectedAt = currentTime;
    return selected.action;
  }

  resetCooldown(): void {
    this.lastSelectedAt = Number.NEGATIVE_INFINITY;
  }
}
