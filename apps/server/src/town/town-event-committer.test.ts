import {
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../storage/database.js';
import {
  SessionRepository,
  TownEventRepository,
  TownProjectionRepository,
} from '../storage/repositories/index.js';
import {
  TownEventCommitError,
  TownEventCommitter,
} from './town-event-committer.js';

describe('TownEventCommitter', () => {
  it('commits ordered events and runs the completion hook in the same transaction', () => {
    const { database, committer } = fixture();

    const result = committer.apply(
      'session-1',
      0,
      (projection) => [event(projection, 1), event(projection, 2)],
      (advanced) => {
        expect(
          new TownEventRepository(database).listAfter('session-1', 0, 24),
        ).toEqual(advanced.events);
        expect(
          new TownProjectionRepository(database).load('session-1'),
        ).toEqual(advanced.projection);
        database
          .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
          .run('2026-07-13T09:00:00.000Z', 'session-1');
      },
    );

    expect(result.status).toBe('advanced');
    expect(result.events.map(({ id }) => id)).toEqual(['event-1', 'event-2']);
    expect(result.projection).toMatchObject({
      version: 2,
      lastEventSequence: 2,
      residents: [expect.objectContaining({ position: { x: 2, y: 1 } })],
    });
    expect(
      database
        .prepare('SELECT updated_at FROM sessions WHERE id = ?')
        .get('session-1'),
    ).toEqual({ updated_at: '2026-07-13T09:00:00.000Z' });
    database.close();
  });

  it('returns authoritative state for a stale version without calling factory or hook', () => {
    const { database, committer, createInitialProjection } = fixture();
    const first = committer.apply('session-1', 0, (projection) => [
      event(projection, 1),
    ]);
    expect(first.status).toBe('advanced');
    const factory = vi.fn(() => []);
    const hook = vi.fn();

    const stale = committer.apply('session-1', 0, factory, hook);

    expect(stale).toEqual({
      status: 'stale',
      projection: first.projection,
      events: [],
    });
    expect(factory).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(createInitialProjection).toHaveBeenCalledTimes(1);
    database.close();
  });

  it('rolls back projection creation, events, and hook writes when the hook throws', () => {
    const { database, committer } = fixture();

    expect(() =>
      committer.apply(
        'session-1',
        0,
        (projection) => [event(projection, 1)],
        () => {
          database
            .prepare('UPDATE sessions SET updated_at = ? WHERE id = ?')
            .run('2026-07-13T09:00:00.000Z', 'session-1');
          throw new Error('completion failed');
        },
      ),
    ).toThrow('completion failed');
    expect(
      new TownProjectionRepository(database).load('session-1'),
    ).toBeUndefined();
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    expect(
      database
        .prepare('SELECT updated_at FROM sessions WHERE id = ?')
        .get('session-1'),
    ).toEqual({ updated_at: '2026-07-13T08:00:00.000Z' });
    database.close();
  });

  it('rejects an asynchronous completion hook and rolls back the commit', () => {
    const { database, committer } = fixture();

    expect(() =>
      committer.apply(
        'session-1',
        0,
        (projection) => [event(projection, 1)],
        async () => undefined,
      ),
    ).toThrow('must complete synchronously');
    expect(
      new TownProjectionRepository(database).load('session-1'),
    ).toBeUndefined();
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    database.close();
  });

  it('rejects a Promise-returning event factory without persisting state', () => {
    const { database, committer } = fixture();
    const asyncFactory = (async (projection: TownProjection) => [
      event(projection, 1),
    ]) as unknown as (projection: TownProjection) => readonly TownEvent[];

    expect(() => committer.apply('session-1', 0, asyncFactory)).toThrow(
      'must return events synchronously',
    );
    expect(
      new TownProjectionRepository(database).load('session-1'),
    ).toBeUndefined();
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    database.close();
  });

  it.each([
    {
      name: 'a schema-invalid event',
      events: (projection: TownProjection) => [
        { ...event(projection, 1), payload: { residentId: 'missing-text' } },
      ],
    },
    {
      name: 'more than 24 events',
      events: (projection: TownProjection) =>
        Array.from({ length: 25 }, (_, index) => event(projection, index + 1)),
    },
    {
      name: 'a nonsequential event',
      events: (projection: TownProjection) => [
        event(projection, 1),
        event(projection, 3),
      ],
    },
    {
      name: 'an event with a nonsequential base version',
      events: (projection: TownProjection) => [
        event(projection, 1),
        { ...event(projection, 2), baseVersion: projection.version },
      ],
    },
    {
      name: 'an event for another session',
      events: (projection: TownProjection) => [
        { ...event(projection, 1), sessionId: 'session-2' },
      ],
    },
  ])('rolls back $name', ({ events }) => {
    const { database, committer } = fixture({ persistProjection: true });
    const hook = vi.fn();

    expect(() =>
      committer.apply(
        'session-1',
        0,
        events as (projection: TownProjection) => readonly TownEvent[],
        hook,
      ),
    ).toThrow();
    expect(new TownProjectionRepository(database).load('session-1')).toEqual(
      projection(),
    );
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    expect(hook).not.toHaveBeenCalled();
    database.close();
  });

  it('rolls back appended events when the projection CAS fails', () => {
    const { database, committer } = fixture({ persistProjection: true });
    database.exec(`
      CREATE TRIGGER block_town_projection_update
      BEFORE UPDATE ON town_world_states
      WHEN OLD.session_id = 'session-1'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);

    expect(() =>
      committer.apply('session-1', 0, (current) => [event(current, 1)]),
    ).toThrowError(TownEventCommitError);
    expect(new TownProjectionRepository(database).load('session-1')).toEqual(
      projection(),
    );
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    database.close();
  });

  it('returns the unchanged projection when the factory creates no events', () => {
    const { database, committer } = fixture();
    const hook = vi.fn();

    const result = committer.apply('session-1', 0, () => [], hook);

    expect(result).toEqual({
      status: 'advanced',
      projection: projection(),
      events: [],
    });
    expect(hook).toHaveBeenCalledWith(result);
    expect(
      new TownEventRepository(database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    database.close();
  });
});

function fixture(options: { persistProjection?: boolean } = {}) {
  const database = openDatabase(':memory:');
  new SessionRepository(database).create({
    id: 'session-1',
    createdAt: '2026-07-13T08:00:00.000Z',
    updatedAt: '2026-07-13T08:00:00.000Z',
  });
  const createInitialProjection = vi.fn(() => projection());
  if (options.persistProjection === true) {
    new TownProjectionRepository(database).save('session-1', -1, projection());
  }
  return {
    database,
    createInitialProjection,
    committer: new TownEventCommitter(database, createInitialProjection),
  };
}

function projection(): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 0,
    lastEventSequence: 0,
    residents: [
      {
        residentId: 'resident-1',
        pet: {
          schemaVersion: 'pet-definition.v1',
          id: 'resident-1-pet',
          displayName: 'Resident One',
          source: 'player-pet',
          species: 'cat',
          spriteId: 'resident-1',
          palette: {
            primary: '#112233',
            secondary: '#445566',
            accent: '#778899',
          },
          personality: {
            curiosity: 0.5,
            sociability: 0.5,
            playfulness: 0.5,
            creativity: 0.5,
          },
          voice: { style: 'Plain', catchphrases: [] },
          interests: [],
          publicBio: 'A town resident.',
        },
        position: { x: 0, y: 1 },
        zoneId: 'plaza',
        availability: 'available',
      },
    ],
    relationships: [],
    modifications: [],
    activities: [],
  });
}

function event(current: TownProjection, offset: number): TownEvent {
  return TownEventSchema.parse({
    id: `event-${offset}`,
    sessionId: current.sessionId,
    sequence: current.lastEventSequence + offset,
    baseVersion: current.version + offset - 1,
    type: 'resident.moved',
    zoneId: 'plaza',
    participantIds: ['resident-1'],
    timestamp: '2026-07-13T08:00:00.000Z',
    payload: {
      residentId: 'resident-1',
      position: { x: offset, y: 1 },
    },
  });
}
