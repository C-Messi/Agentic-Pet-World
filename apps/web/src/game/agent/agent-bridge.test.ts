import type { ActionResult, AgentDecision, AgentTurnRequest, WorldSnapshot } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ActionRunner,
  type ActionRunOptions,
  type ActionWorldPort,
  type CorrelatedActionResult,
} from '../actions/action-runner';
import { GameEventBus } from '../events';
import { AgentApiClient, AgentBridge } from './agent-bridge';

const world: WorldSnapshot = {
  cat: { position: { x: 1, y: 1 }, emotion: 'idle' },
  objects: [{ id: 'window', position: { x: 2, y: 2 }, available: true, interactions: ['inspect'] }],
};
const decision: AgentDecision = {
  speech: 'I will look.',
  emotion: 'curious',
  actions: [{ id: 'move', type: 'move_to', targetId: 'window', timeoutMs: 1_000 }],
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function turnRequest(): AgentTurnRequest {
  return {
    sessionId: 'session-1',
    playerMessage: 'Look outside.',
    world,
    recentActionResults: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('AgentApiClient', () => {
  it('creates and loads sessions through shared response schemas', async () => {
    const session = {
      id: 'session-1',
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ session }, 201))
      .mockResolvedValueOnce(response({ session, world, messages: [] }));
    const client = new AgentApiClient({ fetcher });

    expect((await client.createSession()).session).toEqual(session);
    expect((await client.loadSession('session-1')).world).toEqual(world);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      '/api/sessions',
      '/api/sessions/session-1',
    ]);
  });

  it('loads durable memories through the shared schema', async () => {
    const memory = {
      id: 'memory-1',
      sessionId: 'session-1',
      content: 'The player enjoys the sunny window.',
      importance: 0.8,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };
    const fetcher = vi.fn(async () => response({ memories: [memory] }));
    const client = new AgentApiClient({ fetcher });

    await expect(client.listMemories('session-1')).resolves.toEqual([memory]);
    expect(fetcher).toHaveBeenCalledWith('/api/sessions/session-1/memories', {});
  });

  it('accepts and parses a 503 fallback envelope', async () => {
    const fetcher = vi.fn(async () => response({
      decision: { speech: 'I need a quiet moment.', emotion: 'confused', actions: [] },
      degraded: true,
      fallbackReason: 'provider_unavailable',
      correlationId: 'turn-503',
    }, 503));
    const client = new AgentApiClient({ fetcher });

    const result = await client.sendTurn(turnRequest());

    expect(result.degraded).toBe(true);
    expect(result.correlationId).toBe('turn-503');
  });

  it('retries an action-result delivery with the identical idempotent body', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response({ accepted: 1 }, 202));
    const client = new AgentApiClient({ fetcher, resultRetryCount: 1 });
    const result: CorrelatedActionResult = {
      turnCorrelationId: 'turn-1',
      result: {
        actionId: 'move',
        type: 'move_to',
        status: 'succeeded',
        completedAt: '2026-07-12T00:00:00.000Z',
      },
    };

    await client.postActionResult('session-1', result, world);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(fetcher.mock.calls[1]?.[1]?.body);
  });

  it('does not retry a 409 action-result conflict', async () => {
    const fetcher = vi.fn(async () => response({
      error: { code: 'ACTION_RESULT_CONFLICT', message: 'Conflict', correlationId: 'req-1' },
    }, 409));
    const client = new AgentApiClient({ fetcher, resultRetryCount: 2 });

    await expect(client.postActionResult('session-1', {
      turnCorrelationId: 'turn-1',
      result: {
        actionId: 'move', type: 'move_to', status: 'succeeded', completedAt: '2026-07-12T00:00:00.000Z',
      },
    }, world)).rejects.toMatchObject({ status: 409, code: 'ACTION_RESULT_CONFLICT' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('AgentBridge', () => {
  it('shows maximum speech then thought and clears them on bounded timers', async () => {
    vi.useFakeTimers();
    const maxDecision: AgentDecision = {
      speech: 's'.repeat(280),
      thought: 't'.repeat(240),
      emotion: 'curious',
      actions: [],
    };
    const api = {
      sendTurn: vi.fn(async () => ({ decision: maxDecision, degraded: false, correlationId: 'turn-bubbles' })),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = { run: vi.fn(async () => []), cancel: vi.fn(), currentAction: undefined } as unknown as ActionRunner;
    const events = new GameEventBus();
    const bubbles: Array<{ kind: string; text?: string; ownerId?: string }> = [];
    events.on('bubble-changed', (bubble) => bubbles.push(bubble));
    const bridge = new AgentBridge(api, runner, events, () => world, { bubbleDurationMs: () => 100 });
    bridge.replaceSession('session-1');

    await bridge.sendPlayerMessage('Show both.');
    expect(bubbles.at(-1)).toMatchObject({ kind: 'speech', text: maxDecision.speech, ownerId: 'turn-bubbles' });
    await vi.advanceTimersByTimeAsync(100);
    expect(bubbles.at(-1)).toMatchObject({ kind: 'thought', text: maxDecision.thought, ownerId: 'turn-bubbles' });
    await vi.advanceTimersByTimeAsync(100);
    expect(bubbles.at(-1)).toEqual({ kind: 'thought', ownerId: 'turn-bubbles' });
    vi.useRealTimers();
  });

  it('clears owned bubbles and timers when a session is replaced', async () => {
    vi.useFakeTimers();
    const bubbleDecision = { ...decision, thought: 'Old thought.' };
    const api = {
      sendTurn: vi.fn(async () => ({ decision: bubbleDecision, degraded: false, correlationId: 'turn-old' })),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = { run: vi.fn(async () => []), cancel: vi.fn(), currentAction: undefined } as unknown as ActionRunner;
    const events = new GameEventBus();
    const bubbles: Array<{ kind: string; text?: string; ownerId?: string }> = [];
    events.on('bubble-changed', (bubble) => bubbles.push(bubble));
    const bridge = new AgentBridge(api, runner, events, () => world, { bubbleDurationMs: () => 100 });
    bridge.replaceSession('session-old');
    await bridge.sendPlayerMessage('Old.');

    bridge.replaceSession('session-new');
    const countAfterReplacement = bubbles.length;
    expect(bubbles.slice(-2)).toEqual([
      { kind: 'speech', ownerId: 'turn-old' },
      { kind: 'thought', ownerId: 'turn-old' },
    ]);
    await vi.advanceTimersByTimeAsync(500);
    expect(bubbles).toHaveLength(countAfterReplacement);
    vi.useRealTimers();
  });

  it('ignores a stale turn response from an adapter that does not honor abort', async () => {
    const oldTurn = deferred<{
      decision: AgentDecision;
      degraded: false;
      correlationId: string;
    }>();
    const newTurn = deferred<{
      decision: AgentDecision;
      degraded: false;
      correlationId: string;
    }>();
    const api = {
      sendTurn: vi.fn()
        .mockImplementationOnce(() => oldTurn.promise)
        .mockImplementationOnce(() => newTurn.promise),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = {
      run: vi.fn(async () => []),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const events = new GameEventBus();
    const bubbles: string[] = [];
    events.on('bubble-changed', ({ text }) => { if (text) bubbles.push(text); });
    const bridge = new AgentBridge(api, runner, events, () => world);
    bridge.replaceSession('session-1');

    const oldRequest = bridge.sendPlayerMessage('Old.');
    const newRequest = bridge.sendPlayerMessage('New.');
    oldTurn.resolve({ decision, degraded: false, correlationId: 'turn-old' });
    await expect(oldRequest).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.run).not.toHaveBeenCalled();
    expect(bubbles).toEqual([]);

    newTurn.resolve({ decision, degraded: false, correlationId: 'turn-new' });
    await newRequest;
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(bubbles).toEqual([decision.speech]);
  });

  it('prevents a stale create response from replacing a newer loaded session', async () => {
    const create = deferred<{
      session: { id: string; createdAt: string; updatedAt: string };
    }>();
    const timestamp = '2026-07-12T00:00:00.000Z';
    const api = {
      createSession: vi.fn(() => create.promise),
      loadSession: vi.fn(async () => ({
        session: { id: 'session-new', createdAt: timestamp, updatedAt: timestamp },
        world,
        messages: [],
      })),
      sendTurn: vi.fn(),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = { run: vi.fn(), cancel: vi.fn(), currentAction: undefined } as unknown as ActionRunner;
    const bridge = new AgentBridge(api, runner, new GameEventBus(), () => world);

    const oldCreate = bridge.createSession();
    await bridge.loadSession('session-new');
    create.resolve({
      session: { id: 'session-old', createdAt: timestamp, updatedAt: timestamp },
    });

    await expect(oldCreate).rejects.toMatchObject({ name: 'AbortError' });
    expect(bridge.sessionId).toBe('session-new');
  });

  it('deduplicates the same turn correlation and decision', async () => {
    const api = {
      sendTurn: vi.fn(async () => ({ decision, degraded: false, correlationId: 'turn-1' })),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = {
      run: vi.fn(async () => []),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const bridge = new AgentBridge(api, runner, new GameEventBus(), () => world);
    bridge.replaceSession('session-1');

    await bridge.sendPlayerMessage('Look outside.');
    await bridge.sendPlayerMessage('Look outside again.');

    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('cancels the request and action queue when the session is replaced', async () => {
    let requestSignal: AbortSignal | undefined;
    const api = {
      sendTurn: vi.fn((_request: AgentTurnRequest, signal?: AbortSignal) => {
        requestSignal = signal;
        return new Promise<never>(() => undefined);
      }),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = { run: vi.fn(), cancel: vi.fn(), currentAction: undefined } as unknown as ActionRunner;
    const bridge = new AgentBridge(api, runner, new GameEventBus(), () => world);
    bridge.replaceSession('session-1');
    void bridge.sendPlayerMessage('Wait.');
    await Promise.resolve();

    bridge.replaceSession('session-2');

    expect(requestSignal?.aborted).toBe(true);
    expect(runner.cancel).toHaveBeenCalled();
  });

  it('cancels a real running action when the session is replaced', async () => {
    let ambientSuspended = false;
    const port: ActionWorldPort = {
      hasTarget: () => true,
      setAmbientSuspended: (suspended) => { ambientSuspended = suspended; },
      moveTo: async () => undefined,
      interact: async () => undefined,
      emote: async () => undefined,
      wait: async (_duration, signal) => new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('cancelled', 'AbortError')),
          { once: true },
        );
      }),
      speak: async () => undefined,
      getSnapshot: () => world,
    };
    const events = new GameEventBus();
    const failures: ActionResult[] = [];
    events.on('action-failed', ({ result }) => failures.push(result));
    const runner = new ActionRunner(port, events);
    const delivered: Array<{ result: CorrelatedActionResult; signal: AbortSignal | undefined }> = [];
    const api = {
      sendTurn: vi.fn(async () => ({
        decision: {
          speech: 'Waiting.',
          emotion: 'idle' as const,
          actions: [{ id: 'wait', type: 'wait' as const, durationMs: 1_000 }],
        },
        degraded: false,
        correlationId: 'turn-wait',
      })),
      postActionResult: vi.fn(async (
        _sessionId: string,
        result: CorrelatedActionResult,
        _snapshot: WorldSnapshot,
        signal?: AbortSignal,
      ) => {
        delivered.push({ result, signal });
      }),
    };
    const bridge = new AgentBridge(api, runner, events, () => world);
    bridge.replaceSession('session-1');
    const turn = bridge.sendPlayerMessage('Wait.');
    await Promise.resolve();
    await Promise.resolve();

    bridge.replaceSession('session-2');
    await expect(turn).rejects.toMatchObject({ name: 'AbortError' });

    expect(failures[0]?.status).toBe('cancelled');
    expect(delivered[0]?.result.result.status).toBe('cancelled');
    expect(delivered[0]?.signal?.aborted).toBe(false);
    expect(ambientSuspended).toBe(false);
    expect(runner.currentAction).toBeUndefined();
  });

  it('delivers old-session cancellation without contaminating new recent results or status', async () => {
    const oldRun = deferred<CorrelatedActionResult[]>();
    let oldOptions: ActionRunOptions | undefined;
    const requests: AgentTurnRequest[] = [];
    const deliveredSessions: string[] = [];
    const api = {
      sendTurn: vi.fn(async (request: AgentTurnRequest) => {
        requests.push(request);
        return { decision, degraded: false, correlationId: `turn-${requests.length}` };
      }),
      postActionResult: vi.fn(async (sessionId: string) => {
        deliveredSessions.push(sessionId);
        throw new TypeError('old session delivery offline');
      }),
    };
    const runner = {
      run: vi.fn(async (
        _decision: AgentDecision,
        _correlation: string,
        options?: ActionRunOptions,
      ) => {
        if (!oldOptions) {
          oldOptions = options;
          return oldRun.promise;
        }
        return [];
      }),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const events = new GameEventBus();
    const statuses: string[] = [];
    events.on('connection-status', ({ status }) => statuses.push(status));
    const bridge = new AgentBridge(api, runner, events, () => world);
    bridge.replaceSession('session-old');
    const oldTurn = bridge.sendPlayerMessage('Old.');
    await Promise.resolve();
    await Promise.resolve();

    bridge.replaceSession('session-new');
    const statusCountAtReplacement = statuses.length;
    const cancelled: CorrelatedActionResult = {
      turnCorrelationId: 'turn-1',
      result: {
        actionId: 'move',
        type: 'move_to',
        status: 'cancelled',
        errorCode: 'ACTION_CANCELLED',
        message: 'Action sequence cancelled',
        completedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    await oldOptions?.onResult?.(cancelled, world);
    oldRun.resolve([cancelled]);
    await expect(oldTurn).rejects.toMatchObject({ name: 'AbortError' });
    expect(statuses.slice(statusCountAtReplacement)).not.toContain('offline');

    await bridge.sendPlayerMessage('New.');

    expect(deliveredSessions).toEqual(['session-old']);
    expect(requests[1]?.recentActionResults).toEqual([]);
    expect(statuses.at(-1)).toBe('ready');
  });

  it('bounds terminal result delivery timeout and emits offline status without another turn', async () => {
    vi.useFakeTimers();
    const terminalResult: CorrelatedActionResult = {
      turnCorrelationId: 'turn-result-timeout',
      result: {
        actionId: 'speak',
        type: 'speak',
        status: 'succeeded',
        completedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    let deliverySignal: AbortSignal | undefined;
    const api = {
      sendTurn: vi.fn(async () => ({ decision, degraded: false, correlationId: 'turn-result-timeout' })),
      postActionResult: vi.fn((
        _sessionId: string,
        _result: CorrelatedActionResult,
        _snapshot: WorldSnapshot,
        signal?: AbortSignal,
      ) => {
        deliverySignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(new DOMException('delivery timeout', 'AbortError')),
            { once: true },
          );
        });
      }),
    };
    const runner = {
      run: vi.fn(async (
        _decision: AgentDecision,
        _correlation: string,
        options?: ActionRunOptions,
      ) => {
        await options?.onResult?.(terminalResult, world);
        return [terminalResult];
      }),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const events = new GameEventBus();
    const statuses: Array<{ status: string; message?: string }> = [];
    events.on('connection-status', (status) => statuses.push(status));
    const bridge = new AgentBridge(api, runner, events, () => world, {
      resultDeliveryTimeoutMs: 250,
    });
    bridge.replaceSession('session-1');

    const turn = bridge.sendPlayerMessage('Hello.');
    await Promise.resolve();
    await Promise.resolve();
    expect(deliverySignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await turn;

    expect(deliverySignal?.aborted).toBe(true);
    expect(statuses).toContainEqual({
      status: 'offline',
      message: 'Action result delivery timed out',
    });
    expect(statuses.at(-1)?.status).toBe('offline');
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('emits offline delivery failure status without recursively starting a turn', async () => {
    const terminalResult: CorrelatedActionResult = {
      turnCorrelationId: 'turn-result-failure',
      result: {
        actionId: 'move',
        type: 'move_to',
        status: 'failed',
        errorCode: 'MOVEMENT_FAILED',
        message: 'Blocked',
        completedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    const api = {
      sendTurn: vi.fn(async () => ({ decision, degraded: false, correlationId: 'turn-result-failure' })),
      postActionResult: vi.fn(async () => { throw new TypeError('delivery offline'); }),
    };
    const runner = {
      run: vi.fn(async (
        _decision: AgentDecision,
        _correlation: string,
        options?: ActionRunOptions,
      ) => {
        await options?.onResult?.(terminalResult, world);
        return [terminalResult];
      }),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const events = new GameEventBus();
    const statuses: string[] = [];
    events.on('connection-status', ({ status }) => statuses.push(status));
    const bridge = new AgentBridge(api, runner, events, () => world);
    bridge.replaceSession('session-1');

    const outcome = await bridge.sendPlayerMessage('Move.');

    expect(outcome.source).toBe('server');
    expect(statuses.at(-1)).toBe('offline');
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
  });

  it('includes world, current action, and recent results in the next turn request', async () => {
    const delivered: CorrelatedActionResult = {
      turnCorrelationId: 'turn-1',
      result: {
        actionId: 'move',
        type: 'move_to',
        status: 'succeeded',
        completedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    const requests: AgentTurnRequest[] = [];
    let turn = 0;
    const api = {
      sendTurn: vi.fn(async (request: AgentTurnRequest) => {
        requests.push(request);
        turn += 1;
        return { decision, degraded: false, correlationId: `turn-${turn}` };
      }),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = {
      run: vi.fn(async (
        _decision: AgentDecision,
        _correlation: string,
        options?: ActionRunOptions,
      ) => {
        await options?.onResult?.(delivered, world);
        return [delivered];
      }),
      cancel: vi.fn(),
      currentAction: { id: 'pause', type: 'wait', durationMs: 100 },
    } as unknown as ActionRunner;
    const bridge = new AgentBridge(api, runner, new GameEventBus(), () => world);
    bridge.replaceSession('session-1');

    await bridge.sendPlayerMessage('First.');
    await bridge.sendPlayerMessage('Second.');

    expect(requests[1]).toMatchObject({
      world,
      currentAction: { id: 'pause', type: 'wait', durationMs: 100 },
      recentActionResults: [delivered.result],
    });
  });

  it('posts results without recursively starting another turn', async () => {
    const result: CorrelatedActionResult = {
      turnCorrelationId: 'turn-1',
      result: {
        actionId: 'move', type: 'move_to', status: 'succeeded', completedAt: '2026-07-12T00:00:00.000Z',
      },
    };
    const api = {
      sendTurn: vi.fn(async () => ({ decision, degraded: false, correlationId: 'turn-1' })),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = {
      run: vi.fn(async (
        _decision: AgentDecision,
        _correlation: string,
        options?: ActionRunOptions,
      ) => {
        await options?.onResult?.(result, world);
        return [result];
      }),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const bridge = new AgentBridge(api, runner, new GameEventBus(), () => world);
    bridge.replaceSession('session-1');

    await bridge.sendPlayerMessage('Look outside.');

    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    expect(api.postActionResult).toHaveBeenCalledTimes(1);
  });

  it('preserves the session and returns a local safe fallback after a network error', async () => {
    vi.useFakeTimers();
    const api = {
      sendTurn: vi.fn(async () => { throw new TypeError('Network failed'); }),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = {
      run: vi.fn(async () => []),
      cancel: vi.fn(),
      currentAction: undefined,
    } as unknown as ActionRunner;
    const events = new GameEventBus();
    const statuses: string[] = [];
    const bubbles: string[] = [];
    events.on('connection-status', ({ status }) => statuses.push(status));
    events.on('bubble-changed', ({ text }) => { if (text) bubbles.push(text); });
    const bridge = new AgentBridge(api, runner, events, () => world, { bubbleDurationMs: () => 100 });
    bridge.replaceSession('session-1');

    const outcome = await bridge.sendPlayerMessage('Hello.');

    expect(bridge.sessionId).toBe('session-1');
    expect(statuses.at(-1)).toBe('offline');
    expect(outcome).toMatchObject({ source: 'local', degraded: true, fallbackReason: 'network_error' });
    expect(outcome.decision.actions).toEqual([]);
    expect(bubbles).toEqual([outcome.decision.speech]);
    await vi.advanceTimersByTimeAsync(100);
    expect(bubbles).toEqual([outcome.decision.speech, outcome.decision.thought]);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(api.sendTurn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
