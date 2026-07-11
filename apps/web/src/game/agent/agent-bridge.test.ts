import type { AgentDecision, AgentTurnRequest, WorldSnapshot } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import type {
  ActionRunOptions,
  ActionRunner,
  CorrelatedActionResult,
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

describe('AgentApiClient', () => {
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
        await options?.onResult?.(result);
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

  it('preserves the session and emits offline status after a network error', async () => {
    const api = {
      sendTurn: vi.fn(async () => { throw new TypeError('Network failed'); }),
      postActionResult: vi.fn(async () => undefined),
    };
    const runner = { run: vi.fn(), cancel: vi.fn(), currentAction: undefined } as unknown as ActionRunner;
    const events = new GameEventBus();
    const statuses: string[] = [];
    events.on('connection-status', ({ status }) => statuses.push(status));
    const bridge = new AgentBridge(api, runner, events, () => world);
    bridge.replaceSession('session-1');

    await expect(bridge.sendPlayerMessage('Hello.')).rejects.toThrow('Network failed');

    expect(bridge.sessionId).toBe('session-1');
    expect(statuses.at(-1)).toBe('offline');
  });
});
