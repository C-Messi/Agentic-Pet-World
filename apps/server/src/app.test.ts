import { EventEmitter } from 'node:events';

import type {
  ActionResult,
  AgentAction,
  AgentTurnRequest,
  MemoryRecord,
  MessageRecord,
  WorldSnapshot,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  ActionResultDomainError,
  FixedWindowRateLimiter,
  buildApp,
  createRequestAbortSignal,
  type ApiStore,
  type BuildAppDependencies,
} from './app.js';

const now = '2026-07-12T08:30:00.000Z';
const world: WorldSnapshot = {
  cat: { position: { x: 4, y: 7 }, emotion: 'curious' },
  objects: [
    {
      id: 'window',
      position: { x: 8, y: 2 },
      available: true,
      interactions: ['inspect', 'open'],
    },
  ],
};
const decision = {
  speech: 'Let me check the window.',
  emotion: 'curious' as const,
  actions: [
    {
      id: 'move-window',
      type: 'move_to' as const,
      targetId: 'window' as const,
      timeoutMs: 5_000,
    },
  ],
};

class MemoryApiStore implements ApiStore {
  public readonly sessions = new Map<string, { id: string; createdAt: string; updatedAt: string }>();
  public readonly worlds = new Map<string, { snapshot: WorldSnapshot; updatedAt: string }>();
  public readonly messages: MessageRecord[] = [];
  public readonly memories: MemoryRecord[] = [];
  public readonly actionRuns: Array<{
    sessionId: string;
    turnCorrelationId: string;
    action: AgentAction;
    result?: ActionResult;
    resultWorld?: WorldSnapshot;
  }> = [];
  public readonly events: unknown[] = [];
  public worldUpdates = 0;
  public sessionTouches = 0;

  public runInTransaction<T>(operation: () => T): T {
    return operation();
  }

  public createSession(record: { id: string; createdAt: string; updatedAt: string }): void {
    this.sessions.set(record.id, record);
  }

  public getSession(id: string) {
    return this.sessions.get(id);
  }

  public touchSession(id: string, updatedAt: string): void {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new Error(`Session not found: ${id}`);
    }
    this.sessions.set(id, { ...session, updatedAt });
    this.sessionTouches += 1;
  }

  public getWorld(sessionId: string) {
    const state = this.worlds.get(sessionId);
    return state === undefined ? undefined : { sessionId, ...state };
  }

  public upsertWorld(sessionId: string, snapshot: WorldSnapshot, updatedAt: string): void {
    this.worlds.set(sessionId, { snapshot, updatedAt });
    this.worldUpdates += 1;
  }

  public listMessages(sessionId: string): readonly MessageRecord[] {
    return this.messages.filter((message) => message.sessionId === sessionId);
  }

  public listMemories(sessionId: string): readonly MemoryRecord[] {
    return this.memories.filter((memory) => memory.sessionId === sessionId);
  }

  public createActionRun(
    sessionId: string,
    action: AgentAction,
    turnCorrelationId: string,
    createdAt: string,
  ): void {
    void createdAt;
    this.actionRuns.push({ sessionId, turnCorrelationId, action });
  }

  public completeActionRun(
    sessionId: string,
    turnCorrelationId: string,
    result: ActionResult,
    resultWorld: WorldSnapshot,
    updatedAt: string,
  ): boolean {
    void updatedAt;
    const run = this.actionRuns.find(
      (candidate) => candidate.sessionId === sessionId
        && candidate.turnCorrelationId === turnCorrelationId
        && candidate.action.id === result.actionId,
    );
    if (run === undefined || run.action.type !== result.type) {
      throw new ActionResultDomainError('not_found', `Action run not found: ${result.actionId}`);
    }
    if (run.result !== undefined) {
      if (
        JSON.stringify(run.result) === JSON.stringify(result)
        && JSON.stringify(run.resultWorld) === JSON.stringify(resultWorld)
      ) {
        return false;
      }
      throw new ActionResultDomainError(
        'conflict',
        `Action result conflicts: ${result.actionId}`,
      );
    }
    run.result = result;
    run.resultWorld = resultWorld;
    return true;
  }

  public createActionResultsEvent(event: unknown): void {
    this.events.push(event);
  }
}

function createHarness(
  overrides: Partial<BuildAppDependencies> = {},
): { app: ReturnType<typeof buildApp>; store: MemoryApiStore } {
  const store = new MemoryApiStore();
  let id = 0;
  const app = buildApp({
    webOrigin: 'http://127.0.0.1:5173',
    store,
    agentService: {
      turnDetailed: async () => ({ decision }),
    },
    readiness: () => ({ config: true, storage: true, knowledge: true }),
    clock: () => now,
    idFactory: (prefix) => `${prefix}-${++id}`,
    rateLimit: { max: 20, windowMs: 60_000 },
    ...overrides,
  });
  return { app, store };
}

async function createSession(app: ReturnType<typeof buildApp>): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/sessions', payload: {} });
  return response.json().session.id as string;
}

function turnPayload() {
  return { playerMessage: 'Please check the window.', world, recentActionResults: [] };
}

describe('Fastify BFF', () => {
  it('reports process liveness independently of dependency readiness', async () => {
    const degraded = createHarness({
      readiness: () => ({ config: false, storage: true, knowledge: true }),
    });

    const response = await degraded.app.inject({ method: 'GET', url: '/live' });
    await degraded.app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'live' });
  });

  it('reports readiness and a degraded dependency state', async () => {
    const healthy = createHarness();
    const ready = await healthy.app.inject({ method: 'GET', url: '/health' });
    await healthy.app.close();

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      checks: { config: true, storage: true, knowledge: true },
    });

    const degraded = createHarness({
      readiness: () => ({ config: true, storage: false, knowledge: true }),
    });
    const unavailable = await degraded.app.inject({ method: 'GET', url: '/health' });
    await degraded.app.close();
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json().status).toBe('degraded');
  });

  it('creates and retrieves sessions with persisted state', async () => {
    const { app } = createHarness();
    const sessionId = await createSession(app);
    const response = await app.inject({ method: 'GET', url: `/api/sessions/${sessionId}` });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      session: { id: sessionId, createdAt: now, updatedAt: now },
      world: null,
      messages: [],
    });
  });

  it('returns standardized 422 and 404 errors with correlation IDs', async () => {
    const { app } = createHarness();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/missing/turns',
      headers: { 'x-correlation-id': 'browser-request-1' },
      payload: { playerMessage: '', world, recentActionResults: [] },
    });
    const unknown = await app.inject({ method: 'GET', url: '/api/sessions/missing' });
    await app.close();

    expect(invalid.statusCode).toBe(422);
    expect(invalid.headers['x-correlation-id']).toBe('browser-request-1');
    expect(invalid.json().error).toEqual(expect.objectContaining({
      code: 'VALIDATION_ERROR',
      correlationId: 'browser-request-1',
    }));
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('SESSION_NOT_FOUND');
  });

  it('validates action-result bodies before checking session existence', async () => {
    const { app } = createHarness();
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/sessions/missing/action-results',
      payload: { world, results: [] },
    });
    const validMissing = await app.inject({
      method: 'POST',
      url: '/api/sessions/missing/turns',
      payload: turnPayload(),
    });
    await app.close();

    expect(invalid.statusCode).toBe(422);
    expect(invalid.json().error.code).toBe('VALIDATION_ERROR');
    expect(validMissing.statusCode).toBe(404);
    expect(validMissing.json().error.code).toBe('SESSION_NOT_FOUND');
  });

  it('runs a turn, persists planned actions, and lists memories', async () => {
    const { app, store } = createHarness();
    const sessionId = await createSession(app);
    store.memories.push({
      id: 'memory-1',
      sessionId,
      content: 'The player likes the window.',
      importance: 0.8,
      createdAt: now,
      updatedAt: now,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    const memories = await app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/memories`,
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      decision,
      degraded: false,
      correlationId: expect.any(String),
    });
    expect(store.actionRuns).toHaveLength(1);
    expect(memories.json().memories).toEqual(store.memories);
  });

  it('returns a client-consumable 503 fallback when the provider degrades', async () => {
    const fallback = {
      speech: 'I lost the thread for a moment, but I am still here with you.',
      emotion: 'confused' as const,
      actions: [],
    };
    const { app } = createHarness({
      agentService: {
        turnDetailed: async () => ({
          decision: fallback,
          fallbackReason: 'provider_unavailable',
        }),
      },
    });
    const sessionId = await createSession(app);
    const response = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      decision: fallback,
      degraded: true,
      fallbackReason: 'provider_unavailable',
      correlationId: expect.any(String),
    });
  });

  it('rejects concurrent turns for the same session', async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { app } = createHarness({
      agentService: {
        turnDetailed: async () => {
          await waiting;
          return { decision };
        },
      },
    });
    const sessionId = await createSession(app);
    const first = app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const second = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    release?.();
    await first;
    await app.close();

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('TURN_IN_PROGRESS');
  });

  it('rate limits turns with retry metadata', async () => {
    const { app } = createHarness({ rateLimit: { max: 1, windowMs: 10_000 } });
    const sessionId = await createSession(app);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    const limited = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    await app.close();

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBe('10');
    expect(limited.json().error).toEqual(expect.objectContaining({
      code: 'RATE_LIMITED',
      retryAfterMs: expect.any(Number),
    }));
  });

  it('persists validated action results and the resulting world snapshot', async () => {
    const { app, store } = createHarness();
    const sessionId = await createSession(app);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    const result: ActionResult = {
      actionId: 'move-window',
      type: 'move_to',
      status: 'succeeded',
      completedAt: now,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: turn.json().correlationId,
        world,
        results: [result],
      },
    });
    const invalid = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: turn.json().correlationId,
        world,
        results: [{ ...result, status: 'unknown' }],
      },
    });
    await app.close();

    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ accepted: 1 });
    expect(store.actionRuns[0]?.result).toEqual(result);
    expect(store.worlds.get(sessionId)?.snapshot).toEqual(world);
    expect(store.events).toHaveLength(1);
    expect(invalid.statusCode).toBe(422);
  });

  it('accepts lost-response action retries idempotently without duplicate updates or events', async () => {
    const { app, store } = createHarness();
    const sessionId = await createSession(app);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    const payload = {
      turnCorrelationId: turn.json().correlationId as string,
      world,
      results: [{
        actionId: 'move-window',
        type: 'move_to' as const,
        status: 'succeeded' as const,
        completedAt: now,
      }],
    };
    const beforeResults = {
      worldUpdates: store.worldUpdates,
      sessionTouches: store.sessionTouches,
    };
    const [first, retry] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/action-results`,
        payload,
      }),
      app.inject({
        method: 'POST',
        url: `/api/sessions/${sessionId}/action-results`,
        payload,
      }),
    ]);
    await app.close();

    expect(first.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(first.json()).toEqual({ accepted: 1 });
    expect(retry.json()).toEqual({ accepted: 1 });
    expect(store.events).toHaveLength(1);
    expect(store.worldUpdates - beforeResults.worldUpdates).toBe(1);
    expect(store.sessionTouches - beforeResults.sessionTouches).toBe(1);
  });

  it('rejects a conflicting second result for a completed action', async () => {
    const { app } = createHarness();
    const sessionId = await createSession(app);
    const turn = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    const succeeded = {
      turnCorrelationId: turn.json().correlationId as string,
      world,
      results: [{
        actionId: 'move-window',
        type: 'move_to' as const,
        status: 'succeeded' as const,
        completedAt: now,
      }],
    };
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: succeeded,
    });
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: succeeded.turnCorrelationId,
        world,
        results: [{
          ...succeeded.results[0],
          status: 'failed',
          errorCode: 'PATH_BLOCKED',
        }],
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('ACTION_RESULT_CONFLICT');

    const worldConflict = await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        ...succeeded,
        world: {
          ...world,
          cat: { ...world.cat, position: { x: 9, y: 7 } },
        },
      },
    });
    expect(worldConflict.statusCode).toBe(409);
    await app.close();
  });

  it('maps action domain mismatches to 422 and unexpected persistence faults to 500', async () => {
    const domain = createHarness();
    const domainSessionId = await createSession(domain.app);
    const result: ActionResult = {
      actionId: 'missing-action',
      type: 'move_to',
      status: 'succeeded',
      completedAt: now,
    };
    const mismatch = await domain.app.inject({
      method: 'POST',
      url: `/api/sessions/${domainSessionId}/action-results`,
      payload: {
        turnCorrelationId: 'missing-turn',
        world,
        results: [result],
      },
    });
    await domain.app.close();

    const internal = createHarness();
    const internalSessionId = await createSession(internal.app);
    internal.store.completeActionRun = () => {
      throw new Error('database unavailable with sensitive detail');
    };
    const failed = await internal.app.inject({
      method: 'POST',
      url: `/api/sessions/${internalSessionId}/action-results`,
      payload: {
        turnCorrelationId: 'missing-turn',
        world,
        results: [result],
      },
    });
    await internal.app.close();

    expect(mismatch.statusCode).toBe(422);
    expect(mismatch.json().error.code).toBe('ACTION_RESULT_INVALID');
    expect(failed.statusCode).toBe(500);
    expect(failed.json().error).toEqual(expect.objectContaining({
      code: 'INTERNAL_ERROR',
      message: 'The request could not be completed',
    }));
    expect(JSON.stringify(failed.json())).not.toContain('sensitive detail');
  });

  it('only emits CORS headers for the configured web origin', async () => {
    const { app } = createHarness();
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    const denied = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://example.invalid' },
    });
    await app.close();

    expect(allowed.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('preserves standardized Fastify 400, 413, and 415 responses', async () => {
    const { app } = createHarness({ bodyLimitBytes: 64 });
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(128) }),
    });
    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { 'content-type': 'application/xml' },
      payload: '<session />',
    });
    await app.close();

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('INVALID_JSON');
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.json().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(unsupported.statusCode).toBe(415);
    expect(unsupported.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('propagates caller disconnect cancellation to AgentService', async () => {
    const raw = new EventEmitter();
    const signal = createRequestAbortSignal(raw);
    expect(signal.aborted).toBe(false);
    raw.emit('aborted');
    expect(signal.aborted).toBe(true);

    let receivedSignal: AbortSignal | undefined;
    const injectedSignal = AbortSignal.abort();
    const { app } = createHarness({
      requestAbortSignal: () => injectedSignal,
      agentService: {
        turnDetailed: async (_request: AgentTurnRequest, options) => {
          receivedSignal = options.signal;
          return { decision };
        },
      },
    });
    const sessionId = await createSession(app);
    await app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: turnPayload(),
    });
    await app.close();
    expect(receivedSignal).toBe(injectedSignal);
  });

  it('aborts immediately for closed transports and removes bridge listeners on finish', () => {
    const closedResponse = Object.assign(new EventEmitter(), {
      destroyed: true,
      writableEnded: false,
    });
    expect(createRequestAbortSignal(new EventEmitter(), closedResponse).aborted).toBe(true);

    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    const signal = createRequestAbortSignal(request, response);
    expect(request.listenerCount('aborted')).toBe(1);
    expect(response.listenerCount('close')).toBe(1);
    expect(response.listenerCount('finish')).toBe(1);
    response.emit('finish');
    expect(signal.aborted).toBe(false);
    expect(request.listenerCount('aborted')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
  });
});

describe('FixedWindowRateLimiter', () => {
  it('sweeps expired keys and caps live entry growth', () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 32);
    for (let index = 0; index < 100; index += 1) {
      limiter.consume(`session-${index}`, 0);
    }
    expect(limiter.size).toBe(32);

    limiter.consume('session-fresh', 1_001);
    expect(limiter.size).toBe(1);
  });
});
