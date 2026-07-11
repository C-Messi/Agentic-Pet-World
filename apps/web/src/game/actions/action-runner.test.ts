import type { AgentAction, AgentDecision, Emotion, Interaction, WorldObjectId, WorldSnapshot } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { GameEventBus } from '../events';
import {
  ActionExecutionError,
  ActionRunner,
  type ActionWorldPort,
} from './action-runner';

const world: WorldSnapshot = {
  cat: { position: { x: 0, y: 0 }, emotion: 'idle' },
  objects: [
    {
      id: 'window',
      position: { x: 4, y: 2 },
      available: true,
      interactions: ['inspect', 'open'],
    },
  ],
};

function decision(actions: AgentAction[]): AgentDecision {
  return { speech: 'Okay.', emotion: 'happy', actions };
}

class FakeWorld implements ActionWorldPort {
  readonly calls: string[] = [];
  targets = new Set<WorldObjectId>(['window']);
  failure: Error | undefined;
  pendingMove: (() => void) | undefined;

  hasTarget(targetId: WorldObjectId): boolean {
    return this.targets.has(targetId);
  }

  setAmbientSuspended(suspended: boolean): void {
    this.calls.push(`ambient:${suspended}`);
  }

  async moveTo(targetId: WorldObjectId): Promise<void> {
    this.calls.push(`move_to:${targetId}`);
    if (this.failure) throw this.failure;
    if (this.pendingMove) await new Promise<void>((resolve) => (this.pendingMove = resolve));
  }

  async interact(targetId: WorldObjectId, interaction: Interaction): Promise<void> {
    this.calls.push(`interact:${targetId}:${interaction}`);
    if (this.failure) throw this.failure;
  }

  async emote(emotion: Emotion): Promise<void> {
    this.calls.push(`emote:${emotion}`);
    if (this.failure) throw this.failure;
  }

  async wait(durationMs: number): Promise<void> {
    this.calls.push(`wait:${durationMs}`);
    if (this.failure) throw this.failure;
  }

  async speak(text: string): Promise<void> {
    this.calls.push(`speak:${text}`);
    if (this.failure) throw this.failure;
  }

  getSnapshot(): WorldSnapshot {
    return world;
  }
}

describe('ActionRunner', () => {
  it('runs actions sequentially and reports each result with the turn correlation ID', async () => {
    const port = new FakeWorld();
    const resultOrder: string[] = [];
    const runner = new ActionRunner(port, new GameEventBus());

    const results = await runner.run(
      decision([
        { id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 },
        { id: 'talk', type: 'speak', text: 'Here it is.' },
      ]),
      'turn-1',
      { onResult: ({ result }) => resultOrder.push(result.actionId) },
    );

    expect(port.calls).toEqual([
      'ambient:true',
      'move_to:window',
      'speak:Here it is.',
      'ambient:false',
    ]);
    expect(resultOrder).toEqual(['move', 'talk']);
    expect(results.map(({ turnCorrelationId, result }) => [turnCorrelationId, result.status])).toEqual([
      ['turn-1', 'succeeded'],
      ['turn-1', 'succeeded'],
    ]);
  });

  it('times out an action and stops the remaining queue', async () => {
    vi.useFakeTimers();
    const port = new FakeWorld();
    port.pendingMove = () => undefined;
    const runner = new ActionRunner(port, new GameEventBus());

    const run = runner.run(
      decision([
        { id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 250 },
        { id: 'talk', type: 'speak', text: 'Never reached.' },
      ]),
      'turn-timeout',
    );
    await vi.advanceTimersByTimeAsync(250);

    const results = await run;
    expect(results).toHaveLength(1);
    expect(results[0]?.result).toMatchObject({ status: 'timed_out', errorCode: 'ACTION_TIMEOUT' });
    expect(port.calls).not.toContain('speak:Never reached.');
    expect(port.calls).toContain('emote:confused');
    vi.useRealTimers();
  });

  it('cancels an active sequence through AbortSignal', async () => {
    const port = new FakeWorld();
    port.pendingMove = () => undefined;
    const runner = new ActionRunner(port, new GameEventBus());
    const controller = new AbortController();

    const run = runner.run(
      decision([{ id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }]),
      'turn-cancel',
      { signal: controller.signal },
    );
    controller.abort();

    expect((await run)[0]?.result.status).toBe('cancelled');
  });

  it('fails an unavailable runtime target before invoking the adapter', async () => {
    const port = new FakeWorld();
    port.targets.clear();
    const runner = new ActionRunner(port, new GameEventBus());

    const results = await runner.run(
      decision([{ id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }]),
      'turn-target',
    );

    expect(results[0]?.result).toMatchObject({ status: 'failed', errorCode: 'UNKNOWN_TARGET' });
    expect(port.calls).not.toContain('move_to:window');
  });

  it('stops after an interaction failure and always resumes ambient behavior', async () => {
    const port = new FakeWorld();
    port.failure = new ActionExecutionError('INTERACTION_FAILED', 'The window is stuck');
    const runner = new ActionRunner(port, new GameEventBus());

    const results = await runner.run(
      decision([
        { id: 'open', type: 'interact', targetId: 'window', interaction: 'open' },
        { id: 'talk', type: 'speak', text: 'Opened.' },
      ]),
      'turn-failure',
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.result.errorCode).toBe('INTERACTION_FAILED');
    expect(port.calls.at(-1)).toBe('ambient:false');
  });

  it('emits completed result events for all five action types', async () => {
    const port = new FakeWorld();
    const events = new GameEventBus();
    const completed: AgentAction['type'][] = [];
    events.on('action-completed', ({ result }) => completed.push(result.type));
    const runner = new ActionRunner(port, events);

    await runner.run(
      decision([
        { id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 },
        { id: 'inspect', type: 'interact', targetId: 'window', interaction: 'inspect' },
        { id: 'happy', type: 'emote', emotion: 'happy', durationMs: 100 },
        { id: 'pause', type: 'wait', durationMs: 100 },
      ]),
      'turn-types-1',
    );
    await runner.run(
      decision([{ id: 'speak', type: 'speak', text: 'Done.' }]),
      'turn-types-2',
    );

    expect(completed).toEqual(['move_to', 'interact', 'emote', 'wait', 'speak']);
  });
});
