import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  ExperienceCard,
  OfflineRecoveryResponse,
  PetDefinition,
  PublicShowcaseItem,
  TownEvent,
  TownOuting,
  TownPulseResponse,
  TownProjection,
} from '@cat-house/shared';
import { ZodError } from 'zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type StorageDatabase } from './database.js';
import {
  SessionRepository,
  TownEventRepository,
  TownPulseRepository,
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

function card(
  sessionId = 'session-1',
  id = 'card-1',
  sourceEventIds: string[] = ['event-1'],
  cardTimestamp = laterTimestamp,
): ExperienceCard {
  return {
    id,
    sessionId,
    title: 'A sunny hello',
    body: 'Mochi greeted a friend in the plaza.',
    location: 'plaza',
    participantIds: ['resident-1'],
    sourceEventIds,
    timestamp: cardTimestamp,
  };
}

function showcaseItem(
  sessionId = 'session-1',
  id = 'showcase-1',
): PublicShowcaseItem {
  return {
    id,
    sessionId,
    kind: 'interest',
    title: 'Sunbeam collector',
    content: 'Favorite sunny spots around town.',
    presetIconId: 'sun',
    isPublic: true,
  };
}

function recoveryResult(): OfflineRecoveryResponse {
  return {
    outing: { ...outing(), status: 'home', returnedAt: laterTimestamp },
    projection: projection(),
    events: [],
    experienceCards: [],
  };
}

function pulseResponse(): TownPulseResponse {
  return {
    status: 'stale',
    projection: projection(),
    events: [],
    degraded: false,
    degradedResidentIds: [],
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
    expect(projections.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: true });
    projections.saveOuting(storedOuting);
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

  it('claims, completes, and replays an autonomous pulse', () => {
    const repository = new TownPulseRepository(database);
    const response = pulseResponse();

    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    })).toEqual({ kind: 'claimed' });
    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-2',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    })).toEqual({ kind: 'in-flight' });

    repository.complete('session-1', 'pulse-1', 'lease-1', response, laterTimestamp);

    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-3',
      now: laterTimestamp,
      leaseExpiresAt: '2026-07-12T08:32:00.000Z',
    })).toEqual({ kind: 'complete', response });

    database.prepare(
      `UPDATE town_agent_pulses
       SET result_json = ?
       WHERE session_id = ? AND pulse_id = ?`,
    ).run(
      JSON.stringify({ ...response, projection: projection('session-2') }),
      'session-1',
      'pulse-1',
    );
    expect(() => repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-3',
      now: laterTimestamp,
      leaseExpiresAt: '2026-07-12T08:32:00.000Z',
    })).toThrow(/session/i);
  });

  it('binds a completed pulse response to its claimed session', () => {
    const repository = new TownPulseRepository(database);
    const response = pulseResponse();
    repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });

    expect(() => repository.complete(
      'session-1',
      'pulse-1',
      'lease-1',
      { ...response, projection: projection('session-2') },
      laterTimestamp,
    )).toThrow(/session/i);
    expect(
      database.prepare(
        `SELECT status, result_json FROM town_agent_pulses
         WHERE session_id = ? AND pulse_id = ?`,
      ).get('session-1', 'pulse-1'),
    ).toEqual({ status: 'pending', result_json: null });

    repository.complete('session-1', 'pulse-1', 'lease-1', response, laterTimestamp);
    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-2',
      now: laterTimestamp,
      leaseExpiresAt: '2026-07-12T08:32:00.000Z',
    })).toEqual({ kind: 'complete', response });
  });

  it('requires every new or takeover lease to expire in the future', () => {
    const repository = new TownPulseRepository(database);
    const invalidClaims = [
      { leaseToken: 'lease-equal-1', leaseExpiresAt: timestamp },
      { leaseToken: 'lease-equal-2', leaseExpiresAt: timestamp },
      { leaseToken: 'lease-equal-3', leaseExpiresAt: timestamp },
      { leaseToken: 'lease-past', leaseExpiresAt: '2026-07-12T08:29:00.000Z' },
    ];

    for (const invalid of invalidClaims) {
      expect(() => repository.claim({
        sessionId: 'session-1',
        pulseId: 'pulse-invalid',
        baseVersion: 0,
        now: timestamp,
        ...invalid,
      })).toThrow(/future/i);
    }
    expect(
      database.prepare(
        'SELECT COUNT(*) AS count FROM town_agent_pulses WHERE pulse_id = ?',
      ).get('pulse-invalid'),
    ).toEqual({ count: 0 });

    repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-takeover',
      baseVersion: 0,
      leaseToken: 'old-lease',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });
    expect(() => repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-takeover',
      baseVersion: 0,
      leaseToken: 'invalid-takeover',
      now: laterTimestamp,
      leaseExpiresAt: laterTimestamp,
    })).toThrow(/future/i);
    expect(
      database.prepare(
        `SELECT lease_token FROM town_agent_pulses
         WHERE session_id = ? AND pulse_id = ?`,
      ).get('session-1', 'pulse-takeover'),
    ).toEqual({ lease_token: 'old-lease' });
    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-takeover',
      baseVersion: 0,
      leaseToken: 'valid-takeover',
      now: laterTimestamp,
      leaseExpiresAt: '2026-07-12T08:32:00.000Z',
    })).toEqual({ kind: 'claimed' });
  });

  it('atomically takes over an expired pulse lease', () => {
    const first = new TownPulseRepository(database);
    const otherDatabase = openDatabase(databasePath);
    try {
      const second = new TownPulseRepository(otherDatabase);
      const response = pulseResponse();

      expect(first.claim({
        sessionId: 'session-1',
        pulseId: 'pulse-1',
        baseVersion: 0,
        leaseToken: 'old-lease',
        now: timestamp,
        leaseExpiresAt: laterTimestamp,
      })).toEqual({ kind: 'claimed' });
      expect(second.claim({
        sessionId: 'session-1',
        pulseId: 'pulse-1',
        baseVersion: 0,
        leaseToken: 'new-lease',
        now: laterTimestamp,
        leaseExpiresAt: '2026-07-12T08:32:00.000Z',
      })).toEqual({ kind: 'claimed' });
      expect(first.claim({
        sessionId: 'session-1',
        pulseId: 'pulse-1',
        baseVersion: 0,
        leaseToken: 'racing-lease',
        now: laterTimestamp,
        leaseExpiresAt: '2026-07-12T08:32:00.000Z',
      })).toEqual({ kind: 'in-flight' });

      expect(() => first.complete(
        'session-1',
        'pulse-1',
        'old-lease',
        response,
        laterTimestamp,
      )).toThrow(/pending lease/i);
      second.complete(
        'session-1',
        'pulse-1',
        'new-lease',
        response,
        '2026-07-12T08:32:00.000Z',
      );
      expect(first.claim({
        sessionId: 'session-1',
        pulseId: 'pulse-1',
        baseVersion: 0,
        leaseToken: 'lease-after-complete',
        now: '2026-07-12T08:32:00.000Z',
        leaseExpiresAt: '2026-07-12T08:33:00.000Z',
      })).toEqual({ kind: 'complete', response });
    } finally {
      otherDatabase.close();
    }
  });

  it('rejects pulse ID reuse with another base version', () => {
    const repository = new TownPulseRepository(database);
    const claim = {
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    };

    expect(repository.claim(claim)).toEqual({ kind: 'claimed' });
    expect(() => repository.claim({ ...claim, baseVersion: 1 })).toThrow(/base version conflict/i);
    repository.complete('session-1', 'pulse-1', 'lease-1', pulseResponse(), laterTimestamp);
    expect(() => repository.claim({ ...claim, baseVersion: 1 })).toThrow(/base version conflict/i);
  });

  it('completes only a matching pending pulse lease', () => {
    const repository = new TownPulseRepository(database);
    const response = pulseResponse();
    repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });

    expect(() => repository.complete(
      'session-1',
      'pulse-1',
      'wrong-lease',
      response,
      laterTimestamp,
    )).toThrow(/pending lease/i);
    repository.complete('session-1', 'pulse-1', 'lease-1', response, laterTimestamp);
    expect(() => repository.complete(
      'session-1',
      'pulse-1',
      'lease-1',
      response,
      laterTimestamp,
    )).toThrow(/pending lease/i);
  });

  it('validates pulse responses on write and read', () => {
    const repository = new TownPulseRepository(database);
    repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });
    const invalidResponse = {
      ...pulseResponse(),
      status: 'stale',
      events: [event()],
    } as unknown as TownPulseResponse;

    expect(() => repository.complete(
      'session-1',
      'pulse-1',
      'lease-1',
      invalidResponse,
      laterTimestamp,
    )).toThrow(ZodError);
    expect(repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-2',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    })).toEqual({ kind: 'in-flight' });

    repository.complete('session-1', 'pulse-1', 'lease-1', pulseResponse(), laterTimestamp);
    database.prepare(
      `UPDATE town_agent_pulses
       SET result_json = ?
       WHERE session_id = ? AND pulse_id = ?`,
    ).run(JSON.stringify({ status: 'stale', unsafe: true }), 'session-1', 'pulse-1');

    expect(() => repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-3',
      now: laterTimestamp,
      leaseExpiresAt: '2026-07-12T08:32:00.000Z',
    })).toThrow(ZodError);
    expect(() => database.prepare(
      `UPDATE town_agent_pulses
       SET result_json = ?
       WHERE session_id = ? AND pulse_id = ?`,
    ).run('{not-json', 'session-1', 'pulse-1')).toThrow();
  });

  it('rejects corrupt scalar pulse columns before using them', () => {
    const repository = new TownPulseRepository(database);
    repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });
    database.prepare(
      `UPDATE town_agent_pulses
       SET lease_expires_at = ?
       WHERE session_id = ? AND pulse_id = ?`,
    ).run('not-a-timestamp', 'session-1', 'pulse-1');

    expect(() => repository.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-2',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    })).toThrow(ZodError);
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

  it('compares stored events after schema parsing and canonical serialization', () => {
    const repository = new TownEventRepository(database);
    const original = event();
    expect(repository.append(original)).toEqual({ inserted: true, sequence: 1 });
    database.prepare(
      'UPDATE town_events SET event_json = ? WHERE session_id = ? AND event_id = ?',
    ).run(JSON.stringify(original, null, 2), 'session-1', 'event-1');

    expect(repository.append(original)).toEqual({ inserted: false, sequence: 1 });
  });

  it('preserves event idempotency and conflicts across database connections', () => {
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
    expect(() => repository.save('session-1', 0, projection())).toThrow(/version step/i);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    expect(() => repository.save('session-1', -1, projection('session-1', 1))).toThrow(/version step/i);
    expect(() => repository.save('session-1', 5, projection('session-1', 1))).toThrow(/version step/i);
    expect(repository.load('session-1')).toEqual(projection());
    expect(() => repository.save('session-2', -1, projection('session-1'))).toThrow();
  });

  it('allows only one projection writer to advance a stored version', () => {
    database.close();
    const firstDatabase = openDatabase(databasePath);
    const secondDatabase = openDatabase(databasePath);
    try {
      const first = new TownProjectionRepository(firstDatabase);
      const second = new TownProjectionRepository(secondDatabase);
      expect(first.save('session-1', -1, projection())).toBe(true);
      expect(first.load('session-1')).toEqual(second.load('session-1'));
      const firstUpdate = projection('session-1', 1);
      const secondUpdate = {
        ...projection('session-1', 1),
        residents: projection('session-1', 1).residents.map((resident, index) =>
          index === 0 ? { ...resident, position: { x: 9, y: 7 } } : resident),
      };

      expect(first.save('session-1', 0, firstUpdate)).toBe(true);
      expect(second.save('session-1', 0, secondUpdate)).toBe(false);
      expect(first.load('session-1')).toEqual(firstUpdate);
    } finally {
      firstDatabase.close();
      secondDatabase.close();
    }
  });

  it('accepts repeated recovery windows and rejects conflicting content', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();

    expect(repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: true });
    expect(repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: false });
    expect(() => repository.claimRecoveryWindow(
      { ...storedOuting, lastConfirmedAt: laterTimestamp },
      'recovery-window-1',
    )).toThrow(/conflict/i);
    repository.saveOuting(storedOuting);
    expect(repository.loadOuting('session-1')).toEqual(storedOuting);
  });

  it('keeps historical recovery claims idempotent across restart', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const outingA = outing();
    const outingB = { ...outingA, lastConfirmedAt: laterTimestamp };

    expect(repository.claimRecoveryWindow(outingA, 'recovery-window-a')).toEqual({ claimed: true });
    repository.saveOuting(outingA);
    expect(repository.claimRecoveryWindow(outingB, 'recovery-window-b')).toEqual({ claimed: true });
    repository.saveOuting(outingB);
    database.close();
    database = openDatabase(databasePath);

    const reopened = new TownProjectionRepository(database);
    expect(reopened.claimRecoveryWindow(outingA, 'recovery-window-a')).toEqual({ claimed: false });
    expect(reopened.loadOuting('session-1')).toEqual(outingB);
    expect(() => reopened.claimRecoveryWindow(
      { ...outingA, recoveryWindowEndsAt: '2026-07-12T08:32:00.000Z' },
      'recovery-window-a',
    )).toThrow(/recovery conflict/i);
    expect(database.prepare('SELECT COUNT(*) AS count FROM town_recovery_windows').get()).toEqual({ count: 2 });
  });

  it('shares recovery claim idempotency across database connections', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const otherDatabase = openDatabase(databasePath);
    try {
      const otherRepository = new TownProjectionRepository(otherDatabase);
      const storedOuting = outing();

      expect(repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: true });
      expect(otherRepository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: false });
      expect(() => otherRepository.claimRecoveryWindow(
        { ...storedOuting, lastConfirmedAt: laterTimestamp },
        'recovery-window-1',
      )).toThrow(/recovery conflict/i);
      expect(repository.loadOuting('session-1')).toBeUndefined();
    } finally {
      otherDatabase.close();
    }
  });

  it('rejects schema-invalid stored recovery claim JSON', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();
    repository.claimRecoveryWindow(storedOuting, 'recovery-window-1');
    database.prepare(
      `UPDATE town_recovery_windows
       SET outing_json = ?
       WHERE session_id = ? AND recovery_window_id = ?`,
    ).run(JSON.stringify({ sessionId: 'session-1' }), 'session-1', 'recovery-window-1');

    expect(() => repository.loadRecoveryResult('session-1', 'recovery-window-1')).toThrow(ZodError);
    expect(() => repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toThrow(ZodError);
  });

  it('rejects stored recovery claim JSON for another session', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    const storedOuting = outing();
    repository.claimRecoveryWindow(storedOuting, 'recovery-window-1');
    database.prepare(
      `UPDATE town_recovery_windows
       SET outing_json = ?
       WHERE session_id = ? AND recovery_window_id = ?`,
    ).run(JSON.stringify(outing('session-2')), 'session-1', 'recovery-window-1');

    expect(() => repository.loadRecoveryResult(
      'session-1',
      'recovery-window-1',
    )).toThrow(/columns do not match payload/i);
    expect(() => repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toThrow(/columns do not match payload/i);
  });

  it('persists idempotent recovery results across restart', () => {
    const repository = new TownProjectionRepository(database);
    const storedOuting = outing();
    const result = recoveryResult();
    expect(repository.save('session-1', -1, projection())).toBe(true);
    expect(repository.claimRecoveryWindow(storedOuting, 'recovery-window-1')).toEqual({ claimed: true });
    repository.saveRecoveryResult('session-1', 'recovery-window-1', result);

    database.close();
    database = openDatabase(databasePath);
    const reopened = new TownProjectionRepository(database);
    expect(reopened.loadRecoveryResult('session-1', 'recovery-window-1')).toEqual(result);
    reopened.saveRecoveryResult('session-1', 'recovery-window-1', result);
    expect(() => reopened.saveRecoveryResult('session-1', 'recovery-window-1', {
      ...result,
      outing: { ...result.outing, returnedAt: '2026-07-12T08:32:00.000Z' },
    })).toThrow(/result conflict/i);
  });

  it('rejects a recovery result for a different claimed resident', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    repository.claimRecoveryWindow(outing(), 'recovery-window-1');
    const result = recoveryResult();

    expect(() => repository.saveRecoveryResult('session-1', 'recovery-window-1', {
      ...result,
      outing: { ...result.outing, residentId: 'resident-2' },
    })).toThrow(/resident/i);
  });

  it('rejects a recovery result with a different immutable recovery basis', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    repository.claimRecoveryWindow(outing(), 'recovery-window-1');
    const result = recoveryResult();

    expect(() => repository.saveRecoveryResult('session-1', 'recovery-window-1', {
      ...result,
      outing: { ...result.outing, lastConfirmedAt: laterTimestamp },
    })).toThrow(/basis/i);
  });

  it('rejects a recovery result whose claimed pet identity changed', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    repository.claimRecoveryWindow(outing(), 'recovery-window-1');
    const result = recoveryResult();

    expect(() => repository.saveRecoveryResult('session-1', 'recovery-window-1', {
      ...result,
      projection: {
        ...result.projection,
        residents: result.projection.residents.map((resident) =>
          resident.residentId === 'resident-1'
            ? { ...resident, pet: { ...resident.pet, id: 'changed-pet' } }
            : resident),
      },
    })).toThrow(/pet/i);
  });

  it('rejects a corrupted recovery result on load', () => {
    const repository = new TownProjectionRepository(database);
    expect(repository.save('session-1', -1, projection())).toBe(true);
    repository.claimRecoveryWindow(outing(), 'recovery-window-1');
    const result = recoveryResult();
    repository.saveRecoveryResult('session-1', 'recovery-window-1', result);
    database.prepare(
      `UPDATE town_recovery_windows
       SET result_json = ?
       WHERE session_id = ? AND recovery_window_id = ?`,
    ).run(
      JSON.stringify({
        ...result,
        outing: { ...result.outing, lastConfirmedAt: laterTimestamp },
      }),
      'session-1',
      'recovery-window-1',
    );

    expect(() => repository.loadRecoveryResult(
      'session-1',
      'recovery-window-1',
    )).toThrow(/basis/i);
  });

  it('rejects cross-session card event references', () => {
    const events = new TownEventRepository(database);
    const projections = new TownProjectionRepository(database);
    events.append(event());
    expect(() => projections.saveCard(card('session-2'))).toThrow();
  });

  it('returns only the newest 100 cards in deterministic order', () => {
    const events = new TownEventRepository(database);
    const repository = new TownProjectionRepository(database);
    events.append(event());
    for (let index = 0; index <= 100; index += 1) {
      repository.saveCard(card(
        'session-1',
        `card-${index.toString().padStart(3, '0')}`,
        ['event-1'],
        new Date(Date.parse(timestamp) + index * 1_000).toISOString(),
      ));
    }

    const cards = repository.listCards('session-1');
    expect(cards).toHaveLength(100);
    expect(cards[0]?.id).toBe('card-100');
    expect(cards[99]?.id).toBe('card-001');
  });

  it('rejects card JSON whose source events disagree with link rows', () => {
    const events = new TownEventRepository(database);
    const repository = new TownProjectionRepository(database);
    events.append(event());
    events.append(event('event-2', 2));
    const storedCard = card('session-1', 'card-1', ['event-1', 'event-2']);
    repository.saveCard(storedCard);
    database.prepare(
      `UPDATE town_experience_cards
       SET card_json = ?
       WHERE session_id = ? AND card_id = ?`,
    ).run(
      JSON.stringify({ ...storedCard, sourceEventIds: ['event-2', 'event-1'] }),
      'session-1',
      'card-1',
    );

    expect(() => repository.listCards('session-1')).toThrow(/source event links/i);
  });

  it('limits public showcase items to 12 while allowing updates', () => {
    const repository = new TownProjectionRepository(database);
    for (let index = 0; index < 12; index += 1) {
      repository.savePublicShowcaseItem(showcaseItem('session-1', `showcase-${index}`));
    }
    expect(repository.listPublicShowcaseItems('session-1')).toHaveLength(12);
    expect(() => repository.savePublicShowcaseItem(
      showcaseItem('session-1', 'showcase-12'),
    )).toThrow(/limit/i);
    repository.savePublicShowcaseItem({
      ...showcaseItem('session-1', 'showcase-0'),
      title: 'Updated sunbeam collector',
    });
    expect(repository.listPublicShowcaseItems('session-1')).toContainEqual(
      expect.objectContaining({ id: 'showcase-0', title: 'Updated sunbeam collector' }),
    );
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
    const pulses = new TownPulseRepository(database);
    const projections = new TownProjectionRepository(database);
    events.append(event());
    projections.save('session-1', -1, projection());
    projections.claimRecoveryWindow(outing(), 'recovery-window-1');
    projections.saveOuting(outing());
    projections.saveCard(card());
    projections.savePublicShowcaseItem(showcaseItem());
    pulses.claim({
      sessionId: 'session-1',
      pulseId: 'pulse-1',
      baseVersion: 0,
      leaseToken: 'lease-1',
      now: timestamp,
      leaseExpiresAt: laterTimestamp,
    });

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
      'town_agent_pulses',
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });
});
