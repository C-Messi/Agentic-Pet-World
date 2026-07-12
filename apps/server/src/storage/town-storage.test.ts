import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExperienceCard,
  PetDefinition,
  PublicShowcaseItem,
  TownEvent,
  TownOuting,
  TownProjection,
} from '@cat-house/shared';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type StorageDatabase } from './database.js';
import {
  SessionRepository,
  TownEventRepository,
  TownProjectionRepository,
} from './repositories/index.js';

const timestamp = '2026-07-12T08:30:00.000Z';
const laterTimestamp = '2026-07-12T08:31:00.000Z';

const pet: PetDefinition = {
  schemaVersion: 'pet-definition.v1' as const,
  id: 'pet-1',
  displayName: 'Mochi',
  source: 'player-pet' as const,
  species: 'cat',
  spriteId: 'mochi',
  palette: { primary: '#f2c879', secondary: '#5b4636', accent: '#fff2cc' },
  personality: {
    curiosity: 0.8,
    sociability: 0.7,
    playfulness: 0.6,
    creativity: 0.5,
  },
  voice: { style: 'Warm', catchphrases: ['Hello!'] },
  interests: ['sunbeams'],
  publicBio: 'A friendly cat.',
};

function projection(sessionId = 'session-1', version = 0): TownProjection {
  return {
    sessionId,
    version,
    lastEventSequence: version,
    residents: [
      {
        residentId: 'resident-1',
        pet,
        position: { x: 4, y: 7 },
        zoneId: 'plaza',
        availability: 'busy',
        activityInstanceId: 'activity-instance-1',
      },
      {
        residentId: 'resident-2',
        pet: { ...pet, id: 'pet-2', displayName: 'Soba', source: 'resident' },
        position: { x: 5, y: 7 },
        zoneId: 'plaza',
        availability: 'busy',
        activityInstanceId: 'activity-instance-1',
      },
    ],
    relationships: [
      {
        residentIdA: 'resident-1',
        residentIdB: 'resident-2',
        affinity: 0.4,
        sourceEventId: 'event-1',
        sourceVersion: version,
      },
    ],
    modifications: [],
    activities: [
      {
        id: 'activity-instance-1',
        activityId: 'chat',
        zoneId: 'plaza',
        participantIds: ['resident-1', 'resident-2'],
        version,
        state: { topic: 'sunbeams' },
      },
    ],
  };
}

type SpokeEvent = Extract<TownEvent, { type: 'resident.spoke' }>;

function event(
  id = 'event-1',
  sequence = 1,
  sessionId = 'session-1',
): SpokeEvent {
  return {
    id,
    sessionId,
    sequence,
    baseVersion: 0,
    zoneId: 'plaza',
    participantIds: ['resident-1'],
    timestamp,
    type: 'resident.spoke',
    payload: { residentId: 'resident-1', text: 'Hello from town' },
  };
}

function outing(sessionId = 'session-1'): TownOuting {
  return {
    sessionId,
    residentId: 'resident-1',
    status: 'returning',
    startedAt: timestamp,
    lastConfirmedAt: timestamp,
    recoveryWindowEndsAt: laterTimestamp,
  };
}

function card(sessionId = 'session-1'): ExperienceCard {
  return {
    id: 'card-1',
    sessionId,
    title: 'A sunny hello',
    body: 'Mochi greeted a friend in the plaza.',
    location: 'plaza',
    participantIds: ['resident-1'],
    sourceEventIds: ['event-1'],
    timestamp: laterTimestamp,
  };
}

function showcaseItem(sessionId = 'session-1'): PublicShowcaseItem {
  return {
    id: 'showcase-1',
    sessionId,
    kind: 'interest',
    title: 'Sunbeam collector',
    content: 'Favorite sunny spots around town.',
    presetIconId: 'sun',
    isPublic: true,
  };
}

describe('pet town storage', () => {
  let directory: string;
  let databasePath: string;
  let database: StorageDatabase;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cat-house-town-storage-'));
    databasePath = join(directory, 'storage.sqlite');
    database = openDatabase(databasePath);
    const sessions = new SessionRepository(database);
    sessions.create({ id: 'session-1', createdAt: timestamp, updatedAt: timestamp });
    sessions.create({ id: 'session-2', createdAt: timestamp, updatedAt: timestamp });
  });

  afterEach(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('persists projections, events, outings, cards, and showcase items across restart', () => {
    const events = new TownEventRepository(database);
    const projections = new TownProjectionRepository(database);
    const storedProjection = projection();
    const storedEvent = event();
    const storedOuting = outing();
    const storedCard = card();
    const storedItem = showcaseItem();

    expect(events.append(storedEvent)).toEqual({ inserted: true, sequence: 1 });
    expect(projections.save('session-1', -1, storedProjection)).toBe(true);
    projections.saveOuting(storedOuting, 'recovery-window-1');
    projections.saveCard(storedCard);
    projections.savePublicShowcaseItem(storedItem);

    database.close();
    database = openDatabase(databasePath);

    const reopenedEvents = new TownEventRepository(database);
    const reopenedProjections = new TownProjectionRepository(database);
    expect(reopenedEvents.listAfter('session-1', 0, 24)).toEqual([storedEvent]);
    expect(reopenedEvents.listByIds('session-1', ['event-1'])).toEqual([storedEvent]);
    expect(reopenedProjections.load('session-1')).toEqual(storedProjection);
    expect(reopenedProjections.loadOuting('session-1')).toEqual(storedOuting);
    expect(reopenedProjections.listCards('session-1')).toEqual([storedCard]);
    expect(reopenedProjections.listPublicShowcaseItems('session-1')).toEqual([storedItem]);

    expect(database.prepare('SELECT COUNT(*) AS count FROM town_residents').get()).toEqual({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM town_relationships').get()).toEqual({ count: 1 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM town_activity_instances').get()).toEqual({ count: 1 });
  });

  it('enforces idempotent event IDs and rejects sequence collisions', () => {
    const repository = new TownEventRepository(database);
    const original = event();

    expect(repository.append(original)).toEqual({ inserted: true, sequence: 1 });
    expect(repository.append(original)).toEqual({ inserted: false, sequence: 1 });
    expect(() => repository.append({ ...original, payload: { ...original.payload, text: 'Changed' } })).toThrow(/conflict/i);
    expect(() => repository.append(event('event-2', 1))).toThrow();
    expect(() => repository.listByIds('session-1', ['event-1', 'event-1'])).toThrow(/duplicate/i);
  });

  it('serializes event retries and conflicts across database connections', () => {
    const otherDatabase = openDatabase(databasePath);
    try {
      const first = new TownEventRepository(database);
      const second = new TownEventRepository(otherDatabase);
      const original = event();

      expect(first.append(original)).toEqual({ inserted: true, sequence: 1 });
      expect(second.append(original)).toEqual({ inserted: false, sequence: 1 });
      expect(() => second.append({
        ...original,
        payload: { ...original.payload, text: 'Changed elsewhere' },
      })).toThrow(/event conflict/i);
      expect(() => second.append(event('event-2', 1))).toThrow(/sequence conflict/i);
    } finally {
      otherDatabase.close();
    }
  });

  it('returns false on optimistic projection conflicts without changing stored state', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', 0, projection())).toBe(false);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    expect(repository.save('session-1', -1, projection('session-1', 1))).toBe(false);
    expect(repository.save('session-1', 5, projection('session-1', 1))).toBe(false);
    expect(repository.load('session-1')).toEqual(projection());
    expect(() => repository.save('session-2', -1, projection('session-1'))).toThrow();
  });

  it('accepts repeated recovery windows and rejects conflicting content', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();

    repository.saveOuting(storedOuting, 'recovery-window-1');
    repository.saveOuting(storedOuting, 'recovery-window-1');
    expect(() => repository.saveOuting({ ...storedOuting, lastConfirmedAt: laterTimestamp }, 'recovery-window-1')).toThrow(/conflict/i);
    expect(repository.loadOuting('session-1')).toEqual(storedOuting);
  });

  it('keeps historical recovery claims idempotent across restart', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const outingA = outing();
    const outingB = { ...outingA, lastConfirmedAt: laterTimestamp };

    repository.saveOuting(outingA, 'recovery-window-a');
    repository.saveOuting(outingB, 'recovery-window-b');
    database.close();
    database = openDatabase(databasePath);

    const reopened = new TownProjectionRepository(database);
    reopened.saveOuting(outingA, 'recovery-window-a');
    expect(reopened.loadOuting('session-1')).toEqual(outingB);
    expect(() => reopened.saveOuting(
      { ...outingA, recoveryWindowEndsAt: '2026-07-12T08:32:00.000Z' },
      'recovery-window-a',
    )).toThrow(/recovery conflict/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM town_recovery_windows').get()).toEqual({ count: 2 });
  });

  it('serializes recovery claims across database connections', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const otherDatabase = openDatabase(databasePath);
    try {
      const otherRepository = new TownProjectionRepository(otherDatabase);
      const storedOuting = outing();

      repository.saveOuting(storedOuting, 'recovery-window-1');
      otherRepository.saveOuting(storedOuting, 'recovery-window-1');
      expect(() => otherRepository.saveOuting(
        { ...storedOuting, lastConfirmedAt: laterTimestamp },
        'recovery-window-1',
      )).toThrow(/recovery conflict/i);
      expect(repository.loadOuting('session-1')).toEqual(storedOuting);
    } finally {
      otherDatabase.close();
    }
  });

  it('rejects schema-invalid stored recovery claim JSON', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();
    repository.saveOuting(storedOuting, 'recovery-window-1');
    database.prepare(
      `UPDATE town_recovery_windows
       SET outing_json = ?
       WHERE session_id = ? AND recovery_window_id = ?`,
    ).run(JSON.stringify({ sessionId: 'session-1' }), 'session-1', 'recovery-window-1');

    expect(() => repository.saveOuting(storedOuting, 'recovery-window-1')).toThrow(ZodError);
  });

  it('rejects stored recovery claim JSON for another session', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();
    repository.saveOuting(storedOuting, 'recovery-window-1');
    database.prepare(
      `UPDATE town_recovery_windows
       SET outing_json = ?
       WHERE session_id = ? AND recovery_window_id = ?`,
    ).run(JSON.stringify(outing('session-2')), 'session-1', 'recovery-window-1');

    expect(() => repository.saveOuting(storedOuting, 'recovery-window-1')).toThrow(/columns do not match payload/i);
  });

  it('rejects cross-session card event references', () => {
    const events = new TownEventRepository(database);
    const projections = new TownProjectionRepository(database);
    events.append(event());
    expect(() => projections.saveCard(card('session-2'))).toThrow();
  });

  it('rejects malformed stored JSON instead of returning raw records', () => {
    const events = new TownEventRepository(database);
    events.append(event());
    database.prepare('UPDATE town_events SET event_json = ? WHERE session_id = ? AND event_id = ?').run(
      JSON.stringify({ id: 'event-1', unsafe: true }),
      'session-1',
      'event-1',
    );
    expect(() => events.listAfter('session-1', 0, 24)).toThrow();
  });

  it('rejects schema-valid JSON that disagrees with its session columns', () => {
    const events = new TownEventRepository(database);
    const projections = new TownProjectionRepository(database);
    events.append(event());
    projections.save('session-1', -1, projection());
    database.prepare('UPDATE town_events SET event_json = ? WHERE session_id = ?').run(
      JSON.stringify(event('event-1', 1, 'session-2')),
      'session-1',
    );
    database.prepare('UPDATE town_world_states SET projection_json = ? WHERE session_id = ?').run(
      JSON.stringify(projection('session-2')),
      'session-1',
    );

    expect(() => events.listAfter('session-1', 0, 24)).toThrow(/columns/i);
    expect(() => projections.load('session-1')).toThrow(/columns/i);
  });

  it('cascades every town record when its session is deleted', () => {
    const events = new TownEventRepository(database);
    const projections = new TownProjectionRepository(database);
    events.append(event());
    projections.save('session-1', -1, projection());
    projections.saveOuting(outing(), 'recovery-window-1');
    projections.saveCard(card());
    projections.savePublicShowcaseItem(showcaseItem());

    database.prepare('DELETE FROM sessions WHERE id = ?').run('session-1');

    for (const table of [
      'town_residents',
      'town_events',
      'town_relationships',
      'town_world_states',
      'town_activity_instances',
      'town_outings',
      'town_recovery_windows',
      'town_experience_cards',
      'town_experience_card_events',
      'public_showcase_items',
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
