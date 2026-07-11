import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type StorageDatabase } from '../storage/database.js';
import {
  EventRepository,
  SessionRepository,
} from '../storage/repositories/index.js';
import { StorageTurnPersistence } from './turn-persistence.js';

const timestamp = '2026-07-12T08:30:00.000Z';
const unrelatedPayloadSchema = z
  .object({
    kind: z.literal('world.updated'),
    objectCount: z.number().int().nonnegative(),
    correlationId: z.string().optional(),
  })
  .strict();

describe('StorageTurnPersistence', () => {
  let database: StorageDatabase;

  beforeEach(() => {
    database = openDatabase(':memory:');
    new SessionRepository(database).create({
      id: 'session-1',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  });

  afterEach(() => {
    database.close();
  });

  it('ignores unrelated event payloads during completed-turn lookup', () => {
    new EventRepository(database, unrelatedPayloadSchema).create({
      id: 'event-world-updated',
      sessionId: 'session-1',
      type: 'world.updated',
      payload: {
        kind: 'world.updated',
        objectCount: 7,
        correlationId: 'turn-correlation',
      },
      createdAt: timestamp,
    });
    new EventRepository(database, unrelatedPayloadSchema).create({
      id: 'event-other-completed-turn',
      sessionId: 'session-1',
      type: 'agent.turn.completed',
      payload: {
        kind: 'world.updated',
        objectCount: 6,
        correlationId: 'different-correlation',
      },
      createdAt: timestamp,
    });

    const persistence = new StorageTurnPersistence(database);

    expect(
      persistence.findCompletedDecision('session-1', 'turn-correlation'),
    ).toBeUndefined();
  });
});
