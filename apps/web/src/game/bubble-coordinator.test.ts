import { describe, expect, it, vi } from 'vitest';

import { BubbleCoordinator } from './bubble-coordinator';
import { GameEventBus } from './events';

describe('BubbleCoordinator', () => {
  it('lets a speak action deliberately replace a decision and cancels its pending thought', async () => {
    vi.useFakeTimers();
    const events = new GameEventBus();
    const changes: Array<{ ownerId?: string; text?: string; kind: string }> = [];
    events.on('bubble-changed', (change) => changes.push(change));
    const bubbles = new BubbleCoordinator(events, { durationMs: () => 100 });

    bubbles.showDecision('turn-1', 'Decision speech', 'Decision thought');
    bubbles.showAction('turn-1:speak-1', 'Action speech');
    await vi.advanceTimersByTimeAsync(500);

    expect(changes.filter(({ text }) => text).map(({ ownerId, text }) => [ownerId, text])).toEqual([
      ['turn-1', 'Decision speech'],
      ['turn-1:speak-1', 'Action speech'],
    ]);
    expect(changes).not.toContainEqual(expect.objectContaining({ text: 'Decision thought' }));
    expect(bubbles.clearOwner('turn-1')).toBe(false);
    expect(bubbles.clearOwner('turn-1:speak-1')).toBe(true);
    vi.useRealTimers();
  });

  it('forbids unowned clears and reset cancels all pending producers', async () => {
    vi.useFakeTimers();
    const events = new GameEventBus();
    const changes: Array<{ ownerId?: string; text?: string; kind: string }> = [];
    events.on('bubble-changed', (change) => changes.push(change));
    const bubbles = new BubbleCoordinator(events, { durationMs: () => 100 });

    bubbles.showDecision('turn-old', 'Old speech', 'Old thought');
    expect(bubbles.clearOwner('someone-else')).toBe(false);
    bubbles.reset();
    const countAtReset = changes.length;
    await vi.advanceTimersByTimeAsync(500);

    expect(changes).toHaveLength(countAtReset);
    expect(changes.at(-1)).toEqual({ kind: 'speech', ownerId: 'turn-old' });
    vi.useRealTimers();
  });

  it('ignores stale action clears after a priority replacement', () => {
    const events = new GameEventBus();
    const changes: Array<{ ownerId?: string; text?: string; kind: string }> = [];
    events.on('bubble-changed', (change) => changes.push(change));
    const bubbles = new BubbleCoordinator(events);

    bubbles.showAction('run-old', 'Old action');
    bubbles.showAction('run-new', 'New action');

    expect(bubbles.clearOwner('run-old')).toBe(false);
    expect(changes.at(-1)).toMatchObject({ ownerId: 'run-new', text: 'New action' });
  });
});
