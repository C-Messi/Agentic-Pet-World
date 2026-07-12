import { describe, expect, it } from 'vitest';

import {
  ExperienceCardSchema,
  OfflineRecoveryResponseSchema,
  PublicShowcaseItemSchema,
  TownActivityInstanceSchema,
  TownAdvanceResponseSchema,
  TownEventSchema,
  TownHistoryResponseSchema,
  TownIntentSchema,
  TownProjectionSchema,
  TownReleaseResponseSchema,
  TownSnapshotResponseSchema,
} from './town.js';

const pet = {
  schemaVersion: 'pet-definition.v1',
  id: 'player-pet',
  displayName: 'Mochi',
  source: 'player-pet',
  species: 'cat',
  spriteId: 'mochi',
  palette: { primary: '#112233', secondary: '#445566', accent: '#778899' },
  personality: { curiosity: 0.8, sociability: 0.7, playfulness: 0.9, creativity: 0.6 },
  voice: { style: 'Warm', catchphrases: ['Hello!'] },
  interests: ['games'],
  publicBio: 'A friendly cat.',
} as const;

const resident = {
  residentId: 'resident-1',
  pet,
  position: { x: 4, y: 8 },
  zoneId: 'plaza',
  availability: 'available',
} as const;

const npcResident = {
  ...resident,
  residentId: 'resident-2',
  pet: { ...pet, id: 'resident-pet', source: 'resident' as const },
};

const event = {
  id: 'event-1',
  sessionId: 'session-1',
  sequence: 1,
  baseVersion: 2,
  type: 'resident.moved',
  zoneId: 'plaza',
  participantIds: ['resident-1'],
  timestamp: '2026-07-12T08:30:00.000Z',
  payload: { residentId: 'resident-1', position: { x: 5, y: 8 } },
} as const;

const validProjection = {
  sessionId: 'session-1',
  version: 3,
  lastEventSequence: 1,
  residents: [resident, npcResident],
  relationships: [
    {
      residentIdA: 'resident-1',
      residentIdB: 'resident-2',
      affinity: 0.5,
      sourceEventId: 'event-1',
      sourceVersion: 3,
    },
  ],
  modifications: [],
  activities: [],
};

const card = {
  id: 'card-1',
  sessionId: 'session-1',
  title: 'A sunny meeting',
  body: 'Mochi met a neighbor in the plaza.',
  location: 'plaza',
  participantIds: ['resident-1', 'resident-2'],
  sourceEventIds: ['event-1'],
  timestamp: '2026-07-12T08:31:00.000Z',
} as const;

const outing = {
  sessionId: 'session-1',
  residentId: 'resident-1',
  status: 'town',
  startedAt: '2026-07-12T08:00:00.000Z',
  lastConfirmedAt: '2026-07-12T08:30:00.000Z',
} as const;

const validRecovery = {
  outing,
  projection: validProjection,
  events: [event],
  experienceCards: [card],
};

describe('town projection', () => {
  it('accepts a versioned projection with exactly one player pet', () => {
    expect(TownProjectionSchema.parse(validProjection).version).toBe(3);
  });

  it('rejects duplicate residents, invalid versions, and missing player pets', () => {
    expect(() =>
      TownProjectionSchema.parse({ ...validProjection, residents: [resident, resident] }),
    ).toThrow();
    expect(() => TownProjectionSchema.parse({ ...validProjection, version: -1 })).toThrow();
    expect(() =>
      TownProjectionSchema.parse({ ...validProjection, residents: [npcResident] }),
    ).toThrow();
  });

  it('validates resident references and unique unordered relationship pairs', () => {
    const missing = {
      ...validProjection.relationships[0],
      residentIdB: 'resident-missing',
    };
    const reverse = {
      ...validProjection.relationships[0],
      residentIdA: 'resident-2',
      residentIdB: 'resident-1',
    };
    expect(() => TownProjectionSchema.parse({ ...validProjection, relationships: [missing] })).toThrow();
    expect(() =>
      TownProjectionSchema.parse({ ...validProjection, relationships: [validProjection.relationships[0], reverse] }),
    ).toThrow();
  });

  it('allows the same cell coordinates on different plots', () => {
    const modification = {
      id: 'mod-1',
      recipeId: 'bench',
      plotId: 'plot-1',
      occupiedCells: [{ x: 1, y: 1 }],
      atlasFrame: 2,
      collision: true,
    };
    expect(
      TownProjectionSchema.parse({
        ...validProjection,
        modifications: [
          modification,
          { ...modification, id: 'mod-2', plotId: 'plot-2' },
        ],
      }).modifications,
    ).toHaveLength(2);
  });

  it('requires reciprocal activity membership, state, and zone references', () => {
    const activity = {
      id: 'activity-1',
      activityId: 'chess',
      zoneId: 'arcade-house',
      participantIds: ['resident-1'],
      version: 1,
      state: {},
    };
    const busyResident = {
      ...resident,
      zoneId: 'arcade-house',
      availability: 'busy',
      activityInstanceId: 'activity-1',
    };
    expect(
      TownProjectionSchema.parse({
        ...validProjection,
        residents: [busyResident, npcResident],
        activities: [activity],
      }).activities,
    ).toHaveLength(1);
    expect(() =>
      TownProjectionSchema.parse({
        ...validProjection,
        residents: [{ ...busyResident, zoneId: 'plaza' }, npcResident],
        activities: [activity],
      }),
    ).toThrow();
    expect(() =>
      TownProjectionSchema.parse({
        ...validProjection,
        residents: [resident, npcResident],
        activities: [activity],
      }),
    ).toThrow();
  });
});

describe('town events and intents', () => {
  it('rejects payload/type mismatches, duplicate participants, and extra fields', () => {
    expect(() =>
      TownEventSchema.parse({ ...event, payload: { residentId: 'resident-1', text: 'Hi' } }),
    ).toThrow();
    expect(() =>
      TownEventSchema.parse({ ...event, participantIds: ['resident-1', 'resident-1'] }),
    ).toThrow();
    expect(() => TownEventSchema.parse({ ...event, executableCode: 'run()' })).toThrow();
  });

  it('bounds event text and stall selections', () => {
    expect(() =>
      TownEventSchema.parse({
        ...event,
        type: 'resident.spoke',
        payload: { residentId: 'resident-1', text: 'x'.repeat(281) },
      }),
    ).toThrow();
    expect(() =>
      TownIntentSchema.parse({
        type: 'open-stall',
        actorId: 'resident-1',
        stallId: 'stall-1',
        showcaseItemIds: ['one', 'two', 'three', 'four'],
      }),
    ).toThrow();
  });
});

describe('activity state', () => {
  it('accepts versioned bounded JSON-compatible state', () => {
    expect(
      TownActivityInstanceSchema.parse({
        id: 'activity-1',
        activityId: 'chess',
        zoneId: 'arcade-house',
        participantIds: ['resident-1', 'resident-2'],
        version: 2,
        state: { turn: 3, board: [null, true, 'cat'] },
      }).version,
    ).toBe(2);
  });

  it('rejects duplicate participants and excessively deep or non-finite state', () => {
    const base = {
      id: 'activity-1',
      activityId: 'chess',
      zoneId: 'arcade-house',
      participantIds: ['resident-1', 'resident-2'],
      version: 1,
      state: {},
    };
    expect(() =>
      TownActivityInstanceSchema.parse({ ...base, participantIds: ['resident-1', 'resident-1'] }),
    ).toThrow();
    expect(() =>
      TownActivityInstanceSchema.parse({ ...base, state: { a: { b: { c: { d: { e: { f: 1 } } } } } } }),
    ).toThrow();
    expect(() => TownActivityInstanceSchema.parse({ ...base, state: { score: Infinity } })).toThrow();
    expect(() =>
      TownActivityInstanceSchema.parse({
        ...base,
        state: { score: 1, [Symbol('hidden')]: 'not-json' },
      }),
    ).toThrow();
  });
});

describe('public town responses', () => {
  it('rejects a sixth offline event and duplicate response events', () => {
    const sixEvents = Array.from({ length: 6 }, (_, index) => ({
      ...event,
      id: `event-${index + 1}`,
      sequence: index + 1,
    }));
    expect(() => OfflineRecoveryResponseSchema.parse({ ...validRecovery, events: sixEvents })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection: validProjection, events: [event, event] })).toThrow();
  });

  it('rejects events ahead of the projection version or sequence', () => {
    expect(() =>
      TownAdvanceResponseSchema.parse({
        projection: validProjection,
        events: [{ ...event, baseVersion: 4 }],
      }),
    ).toThrow();
    expect(() =>
      TownAdvanceResponseSchema.parse({
        projection: validProjection,
        events: [{ ...event, sequence: 2 }],
      }),
    ).toThrow();
  });

  it('rejects unsafe and oversized showcase items', () => {
    expect(() =>
      PublicShowcaseItemSchema.parse({ kind: 'link', content: 'https://example.com' }),
    ).toThrow();
    expect(() =>
      PublicShowcaseItemSchema.parse({
        id: 'showcase-1',
        sessionId: 'session-1',
        kind: 'text',
        title: 'Greeting',
        content: 'x'.repeat(281),
        presetIconId: 'speech-bubble',
        isPublic: true,
      }),
    ).toThrow();
    expect(() =>
      TownSnapshotResponseSchema.parse({
        projection: validProjection,
        outings: [outing],
        showcaseItems: Array.from({ length: 13 }, (_, index) => ({
          id: `item-${index}`,
          sessionId: 'session-1',
          kind: 'text',
          title: 'Greeting',
          content: 'Hello',
          presetIconId: 'speech-bubble',
          isPublic: true,
        })),
        experienceCards: [],
      }),
    ).toThrow();
  });

  it('requires unique card references and validates references when events are included', () => {
    expect(() => ExperienceCardSchema.parse({ ...card, sourceEventIds: ['event-1', 'event-1'] })).toThrow();
    expect(() =>
      TownHistoryResponseSchema.parse({ sessionId: 'session-1', events: [event], experienceCards: [{ ...card, sourceEventIds: ['missing'] }] }),
    ).toThrow();
    expect(TownHistoryResponseSchema.parse({ sessionId: 'session-1', events: [event], experienceCards: [card] }).experienceCards).toHaveLength(1);
  });

  it('isolates sessions and resident references in composite responses', () => {
    expect(() =>
      TownReleaseResponseSchema.parse({
        outing: { ...outing, sessionId: 'other-session' },
        projection: validProjection,
      }),
    ).toThrow();
    expect(() =>
      TownSnapshotResponseSchema.parse({
        projection: validProjection,
        outings: [{ ...outing, residentId: 'missing' }],
        showcaseItems: [],
        experienceCards: [{ ...card, participantIds: ['missing'] }],
      }),
    ).toThrow();
    expect(() =>
      TownHistoryResponseSchema.parse({
        sessionId: 'session-1',
        events: [event],
        experienceCards: [{ ...card, sessionId: 'other-session' }],
      }),
    ).toThrow();
    expect(() =>
      TownHistoryResponseSchema.parse({
        sessionId: 'session-1',
        events: [event, { ...event, id: 'event-2', sequence: 2, sessionId: 'other-session' }],
        experienceCards: [card],
      }),
    ).toThrow();
  });
});
