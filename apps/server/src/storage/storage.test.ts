import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type StorageDatabase } from './database.js';
import { loadMigrations } from './migrations.js';
import {
  ActionRunRepository,
  EventRepository,
  MemoryRepository,
  MessageRepository,
  SessionRepository,
  WorldStateRepository,
} from './repositories/index.js';
import { worldSnapshotHash } from '../world-identity.js';

const timestamp = '2026-07-12T08:30:00.000Z';
const laterTimestamp = '2026-07-12T08:31:00.000Z';

const world = {
  cat: {
    position: { x: 4, y: 7 },
    emotion: 'curious' as const,
  },
  objects: [
    {
      id: 'window' as const,
      position: { x: 8, y: 2 },
      available: true,
      interactions: ['inspect' as const, 'open' as const],
    },
  ],
};

const eventPayloadSchema = z
  .object({
    kind: z.literal('thought'),
    text: z.string().min(1),
  })
  .strict();

describe('SQLite storage', () => {
  let directory: string;
  let databasePath: string;
  let database: StorageDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cat-house-storage-'));
    databasePath = join(directory, 'cat-house.sqlite');
    database = openDatabase(databasePath);
  });

  afterEach(() => {
    if (database.open) {
      database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it('applies migrations once and tracks them', () => {
    expect(loadMigrations()).toEqual([
      expect.objectContaining({
        version: 1,
        name: 'initial',
        sql: expect.stringContaining('CREATE TABLE sessions'),
      }),
    ]);
    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([{ version: 1 }]);

    database.close();
    database = openDatabase(databasePath);

    expect(
      database.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
    ).toEqual([{ version: 1 }]);
  });

  it('persists complete durable session state across close and reopen', () => {
    const sessions = new SessionRepository(database);
    const messages = new MessageRepository(database);
    const worldStates = new WorldStateRepository(database);
    const memories = new MemoryRepository(database);

    const session = { id: 'session-1', createdAt: timestamp, updatedAt: timestamp };
    const playerMessage = {
      id: 'message-player-1',
      sessionId: session.id,
      role: 'player' as const,
      content: 'Please look out of the window.',
      createdAt: timestamp,
    };
    const agentMessage = {
      id: 'message-agent-1',
      sessionId: session.id,
      role: 'agent' as const,
      content: 'The sunlight is warm today.',
      createdAt: laterTimestamp,
    };
    const memory = {
      id: 'memory-1',
      sessionId: session.id,
      content: 'The player likes sunny windows.',
      importance: 0.8,
      sourceMessageId: agentMessage.id,
      createdAt: laterTimestamp,
      updatedAt: laterTimestamp,
    };

    sessions.create(session);
    messages.create(playerMessage);
    messages.create(agentMessage);
    worldStates.upsert(session.id, world, laterTimestamp);
    memories.create(memory);

    database.close();
    database = openDatabase(databasePath);

    expect(new SessionRepository(database).get(session.id)).toEqual(session);
    expect(new MessageRepository(database).listForSession(session.id)).toEqual([
      playerMessage,
      agentMessage,
    ]);
    expect(new WorldStateRepository(database).get(session.id)).toEqual({
      sessionId: session.id,
      snapshot: world,
      updatedAt: laterTimestamp,
    });
    expect(new MemoryRepository(database).listForSession(session.id)).toEqual([
      memory,
    ]);
  });

  it('upserts and validates the current world snapshot', () => {
    const sessions = new SessionRepository(database);
    const worldStates = new WorldStateRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });

    worldStates.upsert('session-1', world, timestamp);
    expect(worldStates.get('session-1')).toEqual({
      sessionId: 'session-1',
      snapshot: world,
      updatedAt: timestamp,
    });

    const updated = {
      ...world,
      cat: { ...world.cat, emotion: 'happy' as const },
    };
    worldStates.upsert('session-1', updated, laterTimestamp);

    expect(worldStates.get('session-1')).toEqual({
      sessionId: 'session-1',
      snapshot: updated,
      updatedAt: laterTimestamp,
    });
  });

  it('normalizes timestamp offsets before ordering records', () => {
    const sessions = new SessionRepository(database);
    const messages = new MessageRepository(database);
    sessions.create({
      id: 'session-1',
      createdAt: '2026-07-12T09:00:00+08:00',
      updatedAt: '2026-07-12T09:00:00+08:00',
    });

    messages.create({
      id: 'message-first',
      sessionId: 'session-1',
      role: 'player',
      content: 'This instant is earlier despite its larger local hour.',
      createdAt: '2026-07-12T09:00:00+08:00',
    });
    messages.create({
      id: 'message-second',
      sessionId: 'session-1',
      role: 'agent',
      content: 'This instant is one hour later.',
      createdAt: '2026-07-12T02:00:00Z',
    });

    expect(sessions.get('session-1')).toEqual({
      id: 'session-1',
      createdAt: '2026-07-12T01:00:00.000Z',
      updatedAt: '2026-07-12T01:00:00.000Z',
    });
    expect(messages.listForSession('session-1').map((message) => message.id)).toEqual([
      'message-first',
      'message-second',
    ]);
    expect(
      messages.listForSession('session-1').map((message) => message.createdAt),
    ).toEqual(['2026-07-12T01:00:00.000Z', '2026-07-12T02:00:00.000Z']);
  });

  it('stores memory and typed event records', () => {
    const sessions = new SessionRepository(database);
    const memories = new MemoryRepository(database);
    const events = new EventRepository(database, eventPayloadSchema);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });

    const memory = {
      id: 'memory-1',
      sessionId: 'session-1',
      content: 'The player likes sunny windows.',
      importance: 0.8,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const event = {
      id: 'event-1',
      sessionId: 'session-1',
      type: 'agent.thought',
      payload: { kind: 'thought' as const, text: 'The light looks interesting.' },
      createdAt: timestamp,
    };

    memories.create(memory);
    events.create(event);

    expect(memories.listForSession('session-1')).toEqual([memory]);
    expect(events.listForSession('session-1')).toEqual([event]);
  });

  it('rejects memories sourced from another session', () => {
    const sessions = new SessionRepository(database);
    const messages = new MessageRepository(database);
    const memories = new MemoryRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });
    sessions.create({ id: 'session-2', createdAt: timestamp, updatedAt: timestamp });
    messages.create({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'player',
      content: 'Remember this.',
      createdAt: timestamp,
    });

    expect(() =>
      memories.create({
        id: 'memory-1',
        sessionId: 'session-2',
        content: 'This must not cross session boundaries.',
        importance: 0.5,
        sourceMessageId: 'message-1',
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('clears deleted source messages and cascades deleted sessions', () => {
    const sessions = new SessionRepository(database);
    const messages = new MessageRepository(database);
    const memories = new MemoryRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });
    messages.create({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'agent',
      content: 'A durable observation.',
      createdAt: timestamp,
    });
    memories.create({
      id: 'memory-1',
      sessionId: 'session-1',
      content: 'The observation remains after its source is removed.',
      importance: 0.7,
      sourceMessageId: 'message-1',
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    database.prepare('DELETE FROM messages WHERE id = ?').run('message-1');
    expect(memories.listForSession('session-1')).toEqual([
      {
        id: 'memory-1',
        sessionId: 'session-1',
        content: 'The observation remains after its source is removed.',
        importance: 0.7,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);

    database.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');
    expect(
      database.prepare('SELECT count(*) AS count FROM memories').get(),
    ).toEqual({ count: 0 });
  });

  it('rejects event payloads that are not stable JSON values', () => {
    const sessions = new SessionRepository(database);
    const datePayloadSchema = z.object({ occurredAt: z.date() }).strict();
    const events = new EventRepository(database, datePayloadSchema);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });

    expect(() =>
      events.create({
        id: 'event-1',
        sessionId: 'session-1',
        type: 'agent.non-json',
        payload: { occurredAt: new Date(timestamp) },
        createdAt: timestamp,
      }),
    ).toThrow();
    expect(events.listForSession('session-1')).toEqual([]);
  });

  it('tracks an action run from pending to completion', () => {
    const sessions = new SessionRepository(database);
    const actionRuns = new ActionRunRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });

    const action = {
      id: 'action-1',
      type: 'move_to' as const,
      targetId: 'window' as const,
      timeoutMs: 5_000,
    };
    actionRuns.create({
      id: 'run-1',
      sessionId: 'session-1',
      turnCorrelationId: 'turn-1',
      action,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(actionRuns.get('run-1')).toEqual({
      id: 'run-1',
      sessionId: 'session-1',
      turnCorrelationId: 'turn-1',
      action,
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const result = {
      actionId: 'action-1',
      type: 'move_to' as const,
      status: 'succeeded' as const,
      message: 'Reached the window.',
      completedAt: laterTimestamp,
    };
    const resultWorldHash = worldSnapshotHash(world);
    actionRuns.complete('run-1', result, world, resultWorldHash, laterTimestamp);

    expect(actionRuns.get('run-1')).toEqual({
      id: 'run-1',
      sessionId: 'session-1',
      turnCorrelationId: 'turn-1',
      action,
      status: 'succeeded',
      result,
      resultWorld: world,
      resultWorldHash,
      createdAt: timestamp,
      updatedAt: laterTimestamp,
    });
  });

  it('enforces session foreign keys', () => {
    const messages = new MessageRepository(database);

    expect(() =>
      messages.create({
        id: 'message-1',
        sessionId: 'missing-session',
        role: 'player',
        content: 'Hello?',
        createdAt: timestamp,
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('fails reads when stored JSON does not match its schema', () => {
    const sessions = new SessionRepository(database);
    const worldStates = new WorldStateRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });
    worldStates.upsert('session-1', world, timestamp);

    database
      .prepare('UPDATE world_states SET snapshot_json = ? WHERE session_id = ?')
      .run('{"cat":"not-a-snapshot"}', 'session-1');

    expect(() => worldStates.get('session-1')).toThrow();
  });
});
