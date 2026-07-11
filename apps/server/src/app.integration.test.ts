import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ActionResult, WorldSnapshot } from '@cat-house/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentService } from './agent/agent-service.js';
import { ContextService } from './agent/context-service.js';
import { FakeProvider } from './agent/fake-provider.js';
import { ProviderError, type ProviderAdapter } from './agent/provider.js';
import { StorageTurnPersistence } from './agent/turn-persistence.js';
import { buildApp, createRequestAbortSignal } from './app.js';
import {
  KnowledgeService,
  resolveContentDirectory,
} from './knowledge/knowledge-service.js';
import { StorageApiStore } from './storage/api-store.js';
import { openDatabase, type StorageDatabase } from './storage/database.js';
import {
  MemoryRepository,
  MessageRepository,
  SessionRepository,
} from './storage/repositories/index.js';
import { createProductionApp } from './production.js';

const timestamp = '2026-07-12T08:30:00.000Z';
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

describe('Fastify BFF production integration', () => {
  let directory: string | undefined;
  let database: StorageDatabase | undefined;

  afterEach(() => {
    if (database?.open === true) {
      database.close();
    }
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
    database = undefined;
    directory = undefined;
  });

  it('persists a complete session, turn, memory, action result, and world flow', async () => {
    const fixture = createProductionFixture();
    const create = await fixture.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const sessionId = create.json().session.id as string;
    new MemoryRepository(fixture.database).create({
      id: 'memory-integration',
      sessionId,
      content: 'The player likes sunny windows.',
      importance: 0.8,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const turn = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: {
        playerMessage: 'Please look at the window.',
        world,
        recentActionResults: [],
      },
    });
    const firstTurnCorrelationId = turn.json().correlationId as string;
    const result: ActionResult = {
      actionId: 'fake-window-move',
      type: 'move_to',
      status: 'succeeded',
      completedAt: timestamp,
    };
    const action = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: { turnCorrelationId: firstTurnCorrelationId, world, results: [result] },
    });
    const retry = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: { turnCorrelationId: firstTurnCorrelationId, world, results: [result] },
    });
    const conflict = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: firstTurnCorrelationId,
        world,
        results: [{ ...result, status: 'failed', errorCode: 'PATH_BLOCKED' }],
      },
    });
    const worldConflict = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: firstTurnCorrelationId,
        world: {
          ...world,
          cat: { ...world.cat, position: { x: 9, y: 7 } },
        },
        results: [result],
      },
    });
    const secondTurn = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/turns`,
      payload: {
        playerMessage: 'Please look at the window again.',
        world,
        recentActionResults: [result],
      },
    });
    const secondTurnCorrelationId = secondTurn.json().correlationId as string;
    const secondAction = await fixture.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/action-results`,
      payload: {
        turnCorrelationId: secondTurnCorrelationId,
        world,
        results: [result],
      },
    });
    const session = await fixture.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}`,
    });
    const memories = await fixture.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/memories`,
    });
    await fixture.app.close();

    expect(create.statusCode).toBe(201);
    expect(turn.statusCode).toBe(200);
    expect(turn.json().decision.actions[0].id).toBe('fake-window-move');
    expect(action.statusCode).toBe(202);
    expect(retry.statusCode).toBe(202);
    expect(conflict.statusCode).toBe(409);
    expect(worldConflict.statusCode).toBe(409);
    expect(secondTurn.statusCode).toBe(200);
    expect(secondTurnCorrelationId).not.toBe(firstTurnCorrelationId);
    expect(secondTurn.json().decision.actions[0].id).toBe('fake-window-move');
    expect(secondAction.statusCode).toBe(202);
    const roles = session.json().messages.map(
      (message: { role: string }) => message.role,
    );
    expect(roles.filter((role: string) => role === 'player')).toHaveLength(2);
    expect(roles.filter((role: string) => role === 'agent')).toHaveLength(2);
    expect(session.json().world).toEqual(world);
    expect(memories.json().memories).toEqual([
      expect.objectContaining({ id: 'memory-integration', sessionId }),
    ]);
    expect(
      fixture.database.prepare(
        `SELECT turn_correlation_id, status
         FROM action_runs
         WHERE session_id = ?
         ORDER BY turn_correlation_id`,
      ).all(sessionId),
    ).toEqual([
      { turn_correlation_id: firstTurnCorrelationId, status: 'succeeded' },
      { turn_correlation_id: secondTurnCorrelationId, status: 'succeeded' },
    ].sort((left, right) => left.turn_correlation_id.localeCompare(right.turn_correlation_id)));
    expect(
      fixture.database.prepare(
        `SELECT COUNT(*) AS count
         FROM events
         WHERE session_id = ? AND type = 'actions.results.recorded'`,
      ).get(sessionId),
    ).toEqual({ count: 2 });
  });

  it('bridges request abort events to a provider-observed cancellation signal', async () => {
    const fixture = createProductionFixture();
    new SessionRepository(fixture.database).create({
      id: 'session-abort',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const rawRequest = new EventEmitter();
    const signal = createRequestAbortSignal(rawRequest);
    let observedSignal: AbortSignal | undefined;
    const provider: ProviderAdapter = {
      complete: async (request) => {
        observedSignal = request.signal;
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(new ProviderError('cancelled')),
            { once: true },
          );
        });
      },
    };
    const service = createAgentService(fixture.database, provider);
    const pending = service.turnDetailed(
      {
        sessionId: 'session-abort',
        playerMessage: 'Wait for me.',
        world,
        recentActionResults: [],
      },
      { signal, correlationId: 'abort-integration' },
    );
    rawRequest.emit('aborted');
    const outcome = await pending;
    await fixture.app.close();

    expect(observedSignal).toBe(signal);
    expect(signal.aborted).toBe(true);
    expect(outcome.fallbackReason).toBe('cancelled');
  });

  it('boots the production composition without LLM credentials and serves fallback turns', async () => {
    directory = mkdtempSync(join(tmpdir(), 'cat-house-degraded-'));
    const production = createProductionApp({
      DATABASE_URL: join(directory, 'degraded.sqlite'),
      WEB_ORIGIN: 'http://127.0.0.1:5173',
    });
    const health = await production.app.inject({ method: 'GET', url: '/health' });
    const create = await production.app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: {},
    });
    const turn = await production.app.inject({
      method: 'POST',
      url: `/api/sessions/${create.json().session.id as string}/turns`,
      payload: {
        playerMessage: 'Please look at the window.',
        world,
        recentActionResults: [],
      },
    });
    await production.app.close();

    expect(health.statusCode).toBe(503);
    expect(health.json().checks.config).toBe(false);
    expect(turn.statusCode).toBe(503);
    expect(turn.json()).toEqual(expect.objectContaining({
      degraded: true,
      fallbackReason: 'provider_unavailable',
    }));
  });

  function createProductionFixture() {
    directory = mkdtempSync(join(tmpdir(), 'cat-house-bff-'));
    database = openDatabase(join(directory, 'integration.sqlite'));
    let id = 0;
    const agentService = createAgentService(database, new FakeProvider());
    const app = buildApp({
      webOrigin: 'http://127.0.0.1:5173',
      store: new StorageApiStore(database),
      agentService,
      readiness: () => ({ config: true, storage: true, knowledge: true }),
      clock: () => timestamp,
      idFactory: (prefix) => `${prefix}-integration-${++id}`,
    });
    return { app, database };
  }
});

function createAgentService(
  database: StorageDatabase,
  provider: ProviderAdapter,
): AgentService {
  const knowledge = new KnowledgeService(resolveContentDirectory());
  const context = new ContextService(
    knowledge,
    new MemoryRepository(database),
    new MessageRepository(database),
    { characterBudget: 20_000, recentMessageLimit: 12 },
  );
  return new AgentService({
    contextService: context,
    provider,
    persistence: new StorageTurnPersistence(database),
    clock: () => timestamp,
    idFactory: () => 'correlation-integration',
    retryDelayMs: 0,
  });
}
