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
  it('rejects a decision with more than four actions before touching the world', async () => {
    const port = new FakeWorld();
    const runner = new ActionRunner(port, new GameEventBus());
    const invalidDecision = {
      speech: 'Too much.',
      emotion: 'confused',
      actions: Array.from({ length: 5 }, (_, index) => ({
        id: `wait-${index}`,
        type: 'wait' as const,
        durationMs: 100,
      })),
    };

    await expect(runner.run(invalidDecision as AgentDecision, 'turn-invalid')).rejects.toThrow();
    expect(port.calls).toEqual([]);
  });

  it('rejects an unknown browser-side action before touching the world', async () => {
    const port = new FakeWorld();
    const runner = new ActionRunner(port, new GameEventBus());
    const invalidDecision = {
      speech: 'Unsafe.',
      emotion: 'confused',
      actions: [{ id: 'code', type: 'run_code', source: 'open()' }],
    };

    await expect(
      runner.run(invalidDecision as unknown as AgentDecision, 'turn-unknown'),
    ).rejects.toThrow();
    expect(port.calls).toEqual([]);
  });

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

  it('keeps ambient suspended and busy while a replacement run still owns execution', async () => {
    const port = new FakeWorld();
    const completions: Array<() => void> = [];
    port.moveTo = async (targetId: WorldObjectId, signal: AbortSignal) => {
      port.calls.push(`move_to:${targetId}`);
      await new Promise<void>((resolve, reject) => {
        completions.push(resolve);
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      });
    };
    const events = new GameEventBus();
    const busy: boolean[] = [];
    events.on('agent-busy', ({ busy: value }) => busy.push(value));
    const runner = new ActionRunner(port, events);

    const first = runner.run(
      decision([{ id: 'first', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }]),
      'turn-first',
    );
    await Promise.resolve();
    const second = runner.run(
      decision([{ id: 'second', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }]),
      'turn-second',
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(port.calls.filter((call) => call === 'ambient:false')).toEqual([]);
    expect(busy).toEqual([true, true]);

    completions[1]?.();
    await Promise.all([first, second]);
    expect(port.calls.filter((call) => call.startsWith('ambient:'))).toEqual([
      'ambient:true',
      'ambient:true',
      'ambient:false',
    ]);
    expect(busy).toEqual([true, true, false]);
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

  it.each([
    [{ id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }],
    [{ id: 'interact', type: 'interact', targetId: 'window', interaction: 'inspect' }],
    [{ id: 'emote', type: 'emote', emotion: 'happy', durationMs: 100 }],
    [{ id: 'wait', type: 'wait', durationMs: 100 }],
    [{ id: 'speak', type: 'speak', text: 'Hello.' }],
  ] as const)('returns and emits a structured failure for %s', async (input) => {
    const action = input as unknown as AgentAction;
    const port = new FakeWorld();
    port.failure = new ActionExecutionError('ADAPTER_FAILED', `${action.type} failed`);
    const events = new GameEventBus();
    const failures: Array<{ turnCorrelationId: string; result: { type: string; status: string } }> = [];
    events.on('action-failed', (payload) => failures.push(payload));
    const runner = new ActionRunner(port, events);

    const results = await runner.run(decision([action]), `turn-${action.type}`);

    expect(results[0]).toMatchObject({
      turnCorrelationId: `turn-${action.type}`,
      result: { type: action.type, status: 'failed', errorCode: 'ADAPTER_FAILED' },
    });
    expect(failures).toEqual([results[0]]);
  });
});
