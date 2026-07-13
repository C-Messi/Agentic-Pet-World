import { describe, expect, it } from 'vitest';

import {
  ExperienceCardSchema,
  OfflineRecoveryRequestSchema,
  OfflineRecoveryResponseSchema,
  PublicShowcaseItemSchema,
  TownActivityInstanceSchema,
  TownAdvanceResponseSchema,
  TownEventSchema,
  TownEventTypeSchema,
  TownHistoryResponseSchema,
  TownIntentSchema,
  TownPulseRequestSchema,
  TownPulseResponseSchema,
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

const completedModification = {
  id: 'mod-completed-1',
  recipeId: 'garden-bench',
  plotId: 'plot-1',
  occupiedCells: [{ x: 2, y: 3 }, { x: 3, y: 3 }],
  atlasFrame: 12,
  collision: true,
} as const;

const buildCompletedEvent = {
  ...event,
  type: 'build.completed',
  zoneId: 'build-plots',
  payload: { modification: completedModification },
} as const;

const startedActivity = {
  id: 'activity-social-1',
  activityId: 'social-play',
  zoneId: 'garden',
  participantIds: ['resident-1', 'resident-2'],
  version: 0,
  state: { round: 0, prompt: 'Find something green.' },
} as const;

const activityStartedEvent = {
  ...event,
  type: 'activity.started',
  zoneId: 'garden',
  participantIds: ['resident-1', 'resident-2'],
  payload: { activity: startedActivity },
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

  it('reports overlapping occupied cells at the exact modification and cell', () => {
    const modification = {
      id: 'mod-1',
      recipeId: 'bench',
      plotId: 'plot-1',
      occupiedCells: [{ x: 1, y: 1 }],
      atlasFrame: 2,
      collision: true,
    };
    const result = TownProjectionSchema.safeParse({
      ...validProjection,
      modifications: [modification, { ...modification, id: 'mod-2' }],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected overlapping cells to fail');
    expect(result.error.issues.some(({ path }) =>
      path.join('.') === 'modifications.1.occupiedCells.0',
    )).toBe(true);
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
  it('exposes the exhaustive town event type union', () => {
    expect(TownEventTypeSchema.options).toEqual([
      'resident.moved',
      'resident.spoke',
      'residents.played',
      'activity.started',
      'fortune.started',
      'fortune.revealed',
      'fortune.interpreted',
      'build.started',
      'build.completed',
      'stall.opened',
      'stall.visited',
      'stall.closed',
      'outing.started',
      'outing.returned',
      'relationship.changed',
    ]);
  });

  it('rejects payload/type mismatches, duplicate participants, and extra fields', () => {
    expect(() =>
      TownEventSchema.parse({ ...event, payload: { residentId: 'resident-1', text: 'Hi' } }),
    ).toThrow();
    expect(() =>
      TownEventSchema.parse({ ...event, participantIds: ['resident-1', 'resident-1'] }),
    ).toThrow();
    expect(() => TownEventSchema.parse({ ...event, executableCode: 'run()' })).toThrow();
  });

  it('accepts only an ID-bound strict standalone play payload', () => {
    const played = {
      ...event,
      id: 'standalone-play-1',
      type: 'residents.played',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'standalone-play-1', standalone: true },
    } as const;

    expect(TownEventSchema.parse(played).payload).toEqual(played.payload);
    expect(TownEventSchema.parse({ ...played, payload: { activityInstanceId: 'legacy-activity' } }).payload).toEqual({ activityInstanceId: 'legacy-activity' });
    expect(() => TownEventSchema.parse({ ...played, payload: { ...played.payload, standalone: false } })).toThrow();
    expect(() => TownEventSchema.parse({ ...played, payload: { ...played.payload, plugin: 'unexpected' } })).toThrow();

    const mismatched = TownEventSchema.safeParse({
      ...played,
      payload: { ...played.payload, activityInstanceId: 'different-interaction' },
    });
    expect(mismatched.success).toBe(false);
    if (mismatched.success) throw new Error('Expected standalone interaction ID mismatch');
    expect(mismatched.error.issues.some(({ path }) => path.join('.') === 'payload.activityInstanceId')).toBe(true);
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

  it('carries a complete durable modification in build completion events', () => {
    const parsed = TownEventSchema.parse(buildCompletedEvent);

    expect(parsed.payload).toEqual({ modification: completedModification });
    if (parsed.type !== 'build.completed') throw new Error('Expected build completion event');
    expect(parsed.payload.modification.occupiedCells).toHaveLength(2);
    expect(parsed.payload.modification.atlasFrame).toBe(12);
    expect(parsed.payload.modification.collision).toBe(true);
  });

  it('rejects incomplete or duplicated build completion payload data', () => {
    for (const field of ['occupiedCells', 'atlasFrame', 'collision'] as const) {
      const modification: Partial<typeof completedModification> = { ...completedModification };
      delete modification[field];
      expect(() =>
        TownEventSchema.parse({ ...buildCompletedEvent, payload: { modification } }),
      ).toThrow();
    }
    expect(() =>
      TownEventSchema.parse({
        ...buildCompletedEvent,
        payload: {
          modification: completedModification,
          modificationId: 'conflicting-id',
          recipeId: 'conflicting-recipe',
          plotId: 'conflicting-plot',
        },
      }),
    ).toThrow();
  });

  it('accepts a strict bounded generic activity start payload', () => {
    const parsed = TownEventSchema.parse(activityStartedEvent);

    expect(parsed.payload).toEqual({ activity: startedActivity });
    expect(() =>
      TownEventSchema.parse({
        ...activityStartedEvent,
        payload: { activity: startedActivity, plugin: 'arbitrary-code' },
      }),
    ).toThrow();
    expect(() =>
      TownEventSchema.parse({
        ...activityStartedEvent,
        payload: { activity: { ...startedActivity, version: -1 } },
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

  it('rejects arrays with non-JSON own properties while accepting normal arrays', () => {
    const symbolState = [1, 2] as unknown[] & Record<PropertyKey, unknown>;
    symbolState[Symbol('hidden')] = 'not-json';
    const namedState = [1, 2] as unknown[] & Record<PropertyKey, unknown>;
    namedState.metadata = 'not-json';
    const base = {
      id: 'activity-1',
      activityId: 'chess',
      zoneId: 'arcade-house',
      participantIds: ['resident-1'],
      version: 1,
    };

    expect(TownActivityInstanceSchema.parse({ ...base, state: [1, null, true] }).state).toEqual([1, null, true]);
    expect(() => TownActivityInstanceSchema.parse({ ...base, state: symbolState })).toThrow();
    expect(() => TownActivityInstanceSchema.parse({ ...base, state: namedState })).toThrow();
  });
});

describe('public town responses', () => {
  it('accepts strict autonomous pulse requests without provider prompts', () => {
    const request = {
      sessionId: 'session-1',
      baseVersion: 3,
      pulseId: 'pulse-1',
    };

    expect(TownPulseRequestSchema.parse(request)).toEqual(request);
    expect(() =>
      TownPulseRequestSchema.parse({
        ...request,
        prompt: 'Make the town lively',
      }),
    ).toThrow();
  });

  it('accepts advanced and stale autonomous pulse responses', () => {
    expect(
      TownPulseResponseSchema.parse({
        status: 'advanced',
        projection: validProjection,
        events: [event],
        degraded: true,
        degradedResidentIds: ['resident-2'],
      }).status,
    ).toBe('advanced');
    expect(
      TownPulseResponseSchema.parse({
        status: 'stale',
        projection: validProjection,
        events: [],
        degraded: false,
        degradedResidentIds: [],
      }).events,
    ).toEqual([]);
  });

  it('requires stale pulse responses to contain no events', () => {
    expect(() =>
      TownPulseResponseSchema.parse({
        status: 'stale',
        projection: validProjection,
        events: [event],
        degraded: false,
        degradedResidentIds: [],
      }),
    ).toThrow();
  });

  it('bounds degraded residents and keeps pulse responses strict and projection-consistent', () => {
    const response = {
      status: 'advanced',
      projection: validProjection,
      events: [event],
      degraded: true,
      degradedResidentIds: ['resident-1', 'resident-2'],
    } as const;

    expect(() =>
      TownPulseResponseSchema.parse({
        ...response,
        degradedResidentIds: ['resident-1', 'resident-2', 'resident-3'],
      }),
    ).toThrow();
    expect(() =>
      TownPulseResponseSchema.parse({
        ...response,
        prompt: 'Ignore contracts',
      }),
    ).toThrow();
    expect(() =>
      TownPulseResponseSchema.parse({
        ...response,
        projection: { ...validProjection, version: 4 },
      }),
    ).toThrow();
  });

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

  it('requires ordered contiguous event sequences and version progression', () => {
    const secondEvent = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
    };
    const finalProjection = { ...validProjection, version: 4, lastEventSequence: 2 };

    expect(TownAdvanceResponseSchema.parse({ projection: finalProjection, events: [event, secondEvent] }).events).toHaveLength(2);
    expect(() => TownAdvanceResponseSchema.parse({ projection: finalProjection, events: [secondEvent, event] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection: finalProjection, events: [event, { ...secondEvent, sequence: 3 }] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection: finalProjection, events: [event, { ...secondEvent, baseVersion: 4 }] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection: { ...finalProjection, version: 5 }, events: [event, secondEvent] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection: { ...finalProjection, lastEventSequence: 3 }, events: [event, secondEvent] })).toThrow();
    expect(TownAdvanceResponseSchema.parse({ projection: validProjection, events: [] }).events).toEqual([]);
  });

  it('rejects played events referencing an activity absent from the projection', () => {
    const response = {
      projection: validProjection,
      events: [{
        ...event,
        type: 'residents.played',
        payload: { activityInstanceId: 'missing-activity' },
      }],
    };

    expect(() => TownAdvanceResponseSchema.parse(response)).toThrow();
    expect(() => TownPulseResponseSchema.parse({
      status: 'advanced',
      ...response,
      degraded: false,
      degradedResidentIds: [],
    })).toThrow();
  });

  it('accepts moved residents followed by a standalone play in advance and pulse responses', () => {
    const movedResident = {
      ...event,
      zoneId: 'garden',
      payload: { residentId: 'resident-1', position: { x: 8, y: 8 } },
    };
    const movedNpc = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      zoneId: 'garden',
      participantIds: ['resident-2'],
      payload: { residentId: 'resident-2', position: { x: 9, y: 8 } },
    };
    const played = {
      ...event,
      id: 'standalone-play-1',
      sequence: 3,
      baseVersion: 4,
      type: 'residents.played',
      zoneId: 'garden',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'standalone-play-1', standalone: true },
    };
    const projection = {
      ...validProjection,
      version: 5,
      lastEventSequence: 3,
      residents: [
        { ...resident, position: { x: 8, y: 8 }, zoneId: 'garden' },
        { ...npcResident, position: { x: 9, y: 8 }, zoneId: 'garden' },
      ],
    };
    const response = { projection, events: [movedResident, movedNpc, played] };

    expect(TownAdvanceResponseSchema.parse(response).events).toHaveLength(3);
    expect(TownPulseResponseSchema.parse({ status: 'advanced', ...response, degraded: false, degradedResidentIds: [] }).events).toHaveLength(3);
  });

  it('validates standalone play participants against the final projection', () => {
    const played = {
      ...event,
      id: 'standalone-play-1',
      type: 'residents.played',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'standalone-play-1', standalone: true },
    };
    const thirdResident = {
      ...npcResident,
      residentId: 'resident-3',
      pet: { ...npcResident.pet, id: 'resident-pet-3' },
    };

    expect(TownAdvanceResponseSchema.parse({ projection: validProjection, events: [played] }).events).toHaveLength(1);
    for (const invalidEvent of [
      { ...played, participantIds: ['resident-1'] },
      { ...played, participantIds: ['resident-1', 'resident-2', 'resident-3'] },
      { ...played, participantIds: ['resident-1', 'resident-missing'] },
      { ...played, zoneId: undefined },
      { ...played, zoneId: 'garden' },
    ]) {
      expect(() => TownAdvanceResponseSchema.parse({
        projection: { ...validProjection, residents: [resident, npcResident, thirdResident] },
        events: [invalidEvent],
      })).toThrow();
    }

    const busyProjection = {
      ...validProjection,
      residents: [
        { ...resident, availability: 'busy', activityInstanceId: 'fortune-1' },
        npcResident,
      ],
      activities: [{
        id: 'fortune-1',
        activityId: 'fortune-draw',
        zoneId: 'plaza',
        participantIds: ['resident-1'],
        version: 1,
        state: { status: 'started' },
      }],
    };
    expect(() => TownAdvanceResponseSchema.parse({ projection: busyProjection, events: [played] })).toThrow();
  });

  it('rejects standalone interaction IDs colliding with final durable state', () => {
    const played = {
      ...event,
      id: 'standalone-play-1',
      type: 'residents.played',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'standalone-play-1', standalone: true },
    };
    const thirdResident = {
      ...npcResident,
      residentId: 'resident-3',
      pet: { ...npcResident.pet, id: 'resident-pet-3' },
      availability: 'busy',
      activityInstanceId: 'standalone-play-1',
    };
    const collidingActivity = {
      id: 'standalone-play-1',
      activityId: 'fortune-draw',
      zoneId: 'plaza',
      participantIds: ['resident-3'],
      version: 1,
      state: { status: 'started' },
    };
    const collidingModification = { ...completedModification, id: 'standalone-play-1' };

    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, residents: [resident, npcResident, thirdResident], activities: [collidingActivity] },
      events: [played],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, modifications: [collidingModification] },
      events: [played],
    })).toThrow();

    const completed = {
      ...buildCompletedEvent,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      payload: { modification: collidingModification },
    };
    const collision = TownAdvanceResponseSchema.safeParse({
      projection: {
        ...validProjection,
        version: 4,
        lastEventSequence: 2,
        modifications: [collidingModification],
      },
      events: [played, completed],
    });
    expect(collision.success).toBe(false);
    if (collision.success) throw new Error('Expected durable modification ID collision');
    expect(collision.error.issues.some(({ message, path }) =>
      message.includes('final modification')
      && path.join('.') === 'events.0.payload.activityInstanceId'
    )).toBe(true);
  });

  it('rejects reuse of a standalone interaction ID in the same response chain', () => {
    const played = {
      ...event,
      id: 'standalone-play-1',
      type: 'residents.played',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'standalone-play-1', standalone: true },
    };
    const replayed = { ...played, id: 'standalone-play-2', sequence: 2, baseVersion: 3 };

    expect(() => TownEventSchema.parse(replayed)).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, version: 4, lastEventSequence: 2 },
      events: [played, replayed],
    })).toThrow();
  });

  it.each(['activity', 'build'] as const)(
    'rejects a %s start reusing a prior standalone interaction ID',
    (kind) => {
      const played = {
        ...event,
        id: 'standalone-play-1',
        type: 'residents.played',
        participantIds: ['resident-1', 'resident-2'],
        payload: { activityInstanceId: 'standalone-play-1', standalone: true },
      };
      const started = kind === 'activity'
        ? {
            ...activityStartedEvent,
            id: 'event-2',
            sequence: 2,
            baseVersion: 3,
            payload: { activity: { ...startedActivity, id: 'standalone-play-1' } },
          }
        : {
            ...event,
            id: 'event-2',
            sequence: 2,
            baseVersion: 3,
            type: 'build.started',
            zoneId: 'build-plots',
            participantIds: ['resident-1', 'resident-2'],
            payload: { modificationId: 'standalone-play-1', recipeId: 'garden-bench', plotId: 'plot-1' },
          };
      const result = TownAdvanceResponseSchema.safeParse({
        projection: { ...validProjection, version: 4, lastEventSequence: 2 },
        events: [played, started],
      });

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected reused standalone interaction ID');
      expect(result.error.issues.some(({ message }) => message.includes('referenced before its start'))).toBe(true);
    },
  );

  it('requires played event participants and zone to exactly match the activity', () => {
    const activity = {
      id: 'activity-1',
      activityId: 'social-play',
      zoneId: 'arcade-house',
      participantIds: ['resident-1', 'resident-2'],
      version: 1,
      state: {},
    };
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      position: { x: 1, y: 1 },
      zoneId: 'arcade-house',
      availability: 'busy',
      activityInstanceId: 'activity-1',
    }));
    const thirdResident = {
      ...npcResident,
      residentId: 'resident-3',
      pet: { ...npcResident.pet, id: 'resident-pet-3' },
    };
    const projection = {
      ...validProjection,
      residents: [...busyResidents, thirdResident],
      activities: [activity],
    };
    const playedEvent = {
      ...event,
      type: 'residents.played',
      zoneId: 'arcade-house',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'activity-1' },
    };

    expect(TownAdvanceResponseSchema.parse({ projection, events: [playedEvent] }).events).toHaveLength(1);
    expect(() => TownAdvanceResponseSchema.parse({ projection, events: [{ ...playedEvent, participantIds: ['resident-1'] }] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection, events: [{ ...playedEvent, participantIds: ['resident-1', 'resident-3'] }] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection, events: [{ ...playedEvent, participantIds: ['resident-1', 'resident-2', 'resident-3'] }] })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({ projection, events: [{ ...playedEvent, zoneId: 'plaza' }] })).toThrow();
  });

  it('validates a generic activity start against participants, zone, and final projection', () => {
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      position: { x: 1, y: 1 },
      zoneId: 'garden',
      availability: 'busy',
      activityInstanceId: startedActivity.id,
    }));
    const finalProjection = {
      ...validProjection,
      residents: busyResidents,
      activities: [startedActivity],
    };

    expect(TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [activityStartedEvent],
    }).events).toHaveLength(1);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [{ ...activityStartedEvent, participantIds: ['resident-1'] }],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [{ ...activityStartedEvent, zoneId: 'plaza' }],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...finalProjection, residents: [resident, npcResident], activities: [] },
      events: [activityStartedEvent],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...finalProjection,
        activities: [{ ...startedActivity, state: { round: 1 } }],
      },
      events: [activityStartedEvent],
    })).toThrow();
  });

  it('rejects duplicate or observably preexisting activity starts', () => {
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'garden',
      availability: 'busy',
      activityInstanceId: startedActivity.id,
    }));
    const projection = {
      ...validProjection,
      version: 4,
      lastEventSequence: 2,
      residents: busyResidents,
      activities: [startedActivity],
    };
    const secondStart = {
      ...activityStartedEvent,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
    };
    expect(() => TownAdvanceResponseSchema.parse({
      projection,
      events: [activityStartedEvent, secondStart],
    })).toThrow();

    const priorPlay = {
      ...event,
      type: 'residents.played',
      zoneId: 'garden',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: startedActivity.id },
    };
    expect(() => TownAdvanceResponseSchema.parse({
      projection,
      events: [priorPlay, secondStart],
    })).toThrow();
  });

  it('validates the evolved activity after a start then play chain', () => {
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'garden',
      availability: 'busy',
      activityInstanceId: startedActivity.id,
    }));
    const playedEvent = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      type: 'residents.played',
      zoneId: 'garden',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: startedActivity.id },
    };
    const projection = {
      ...validProjection,
      version: 4,
      lastEventSequence: 2,
      residents: busyResidents,
      activities: [{ ...startedActivity, version: 1 }],
    };

    expect(TownAdvanceResponseSchema.parse({
      projection,
      events: [activityStartedEvent, playedEvent],
    }).events).toHaveLength(2);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...projection,
        activities: [{ ...startedActivity, version: 2 }],
      },
      events: [activityStartedEvent, playedEvent],
    })).toThrow();
  });

  it('accepts generic showcase closure and rejects stale final activity state', () => {
    const showcaseActivity = {
      id: 'stall-generic-1',
      activityId: 'showcase-stall',
      zoneId: 'market',
      participantIds: ['resident-1'],
      version: 0,
      state: { status: 'open', showcaseItemIds: ['item-1'] },
    } as const;
    const started = {
      ...activityStartedEvent,
      participantIds: ['resident-1'],
      zoneId: 'market',
      payload: { activity: showcaseActivity },
    };
    const closed = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      type: 'stall.closed',
      zoneId: 'market',
      payload: { stallId: showcaseActivity.id },
    };
    const finalProjection = {
      ...validProjection,
      version: 4,
      lastEventSequence: 2,
    };

    expect(TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [started, closed],
    }).events).toHaveLength(2);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...finalProjection,
        residents: [{
          ...resident,
          zoneId: 'market',
          availability: 'busy',
          activityInstanceId: showcaseActivity.id,
        }, npcResident],
        activities: [showcaseActivity],
      },
      events: [started, closed],
    })).toThrow();
    const visitedAfterClose = {
      ...event,
      id: 'event-3',
      sequence: 3,
      baseVersion: 4,
      type: 'stall.visited',
      zoneId: 'market',
      participantIds: ['resident-1', 'resident-2'],
      payload: { stallId: showcaseActivity.id, visitorResidentId: 'resident-2' },
    };
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...finalProjection, version: 5, lastEventSequence: 3 },
      events: [started, closed, visitedAfterClose],
    })).toThrow();
  });

  it('does not overconstrain a pre-event stall visited then closed in the batch', () => {
    const visited = {
      ...event,
      type: 'stall.visited',
      zoneId: 'market',
      participantIds: ['resident-1', 'resident-2'],
      payload: { stallId: 'preexisting-stall', visitorResidentId: 'resident-2' },
    };
    const closed = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      type: 'stall.closed',
      zoneId: 'market',
      payload: { stallId: 'preexisting-stall' },
    };

    expect(TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, version: 4, lastEventSequence: 2 },
      events: [visited, closed],
    }).events).toHaveLength(2);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: validProjection,
      events: [visited],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, version: 4, lastEventSequence: 2 },
      events: [{ ...closed, id: 'event-1', sequence: 1, baseVersion: 2 }, {
        ...visited,
        id: 'event-2',
        sequence: 2,
        baseVersion: 3,
      }],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: { ...validProjection, version: 4, lastEventSequence: 2 },
      events: [{ ...closed, id: 'event-1', sequence: 1, baseVersion: 2 }, closed],
    })).toThrow();
  });

  it('evolves fortune start, reveal, and interpretation to the final projection', () => {
    const fortuneStarted = {
      ...event,
      type: 'fortune.started',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'fortune-1' },
    };
    const fortuneRevealed = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      type: 'fortune.revealed',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: 'fortune-1',
        fortuneId: 'fortune-record-1',
        rank: 'great',
      },
    };
    const fortuneInterpreted = {
      ...event,
      id: 'event-3',
      sequence: 3,
      baseVersion: 4,
      type: 'fortune.interpreted',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: 'fortune-1',
        fortuneId: 'fortune-record-1',
        interpretation: 'Try something new',
      },
    };
    const fortuneActivity = {
      id: 'fortune-1',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      version: 3,
      state: {
        status: 'interpreted',
        fortuneId: 'fortune-record-1',
        rank: 'great',
        interpretation: 'Try something new',
      },
    } as const;
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'fortune-pavilion',
      availability: 'busy',
      activityInstanceId: fortuneActivity.id,
    }));
    const finalProjection = {
      ...validProjection,
      version: 5,
      lastEventSequence: 3,
      residents: busyResidents,
      activities: [fortuneActivity],
    };
    const events = [fortuneStarted, fortuneRevealed, fortuneInterpreted];

    expect(TownAdvanceResponseSchema.parse({ projection: finalProjection, events }).events).toHaveLength(3);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...finalProjection,
        activities: [{ ...fortuneActivity, version: 2 }],
      },
      events,
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [
        fortuneStarted,
        fortuneRevealed,
        {
          ...fortuneInterpreted,
          payload: { ...fortuneInterpreted.payload, fortuneId: 'fortune-record-2' },
        },
      ],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...finalProjection,
        version: 4,
        lastEventSequence: 2,
        activities: [{
          ...fortuneActivity,
          version: 2,
          state: {
            status: 'interpreted',
            fortuneId: 'fortune-record-1',
            rank: 'great',
            interpretation: 'Try something new',
          },
        }],
      },
      events: [
        fortuneStarted,
        { ...fortuneInterpreted, id: 'event-2', sequence: 2, baseVersion: 3 },
      ],
    })).toThrow();
  });

  it('keeps fortune activity and selected result IDs distinct in strict payloads', () => {
    const revealed = {
      ...event,
      type: 'fortune.revealed',
      zoneId: 'fortune-pavilion',
      payload: {
        activityInstanceId: 'fortune-activity-1',
        fortuneId: 'fortune-record-1',
        rank: 'good',
      },
    };

    expect(TownEventSchema.parse(revealed).payload).toEqual(revealed.payload);
    expect(() => TownEventSchema.parse({
      ...revealed,
      payload: { ...revealed.payload, fortuneId: 'fortune-activity-1' },
    })).toThrow();
    const missingSelectedId: Partial<typeof revealed.payload> = { ...revealed.payload };
    delete missingSelectedId.fortuneId;
    expect(() => TownEventSchema.parse({ ...revealed, payload: missingSelectedId })).toThrow();
  });

  it('allows each fortune lifecycle fact at most once and locks selected rank', () => {
    const started = {
      ...event,
      type: 'fortune.started',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'fortune-facts-1' },
    };
    const revealed = {
      ...event,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      type: 'fortune.revealed',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: 'fortune-facts-1',
        fortuneId: 'fortune-record-1',
        rank: 'great',
      },
    };
    const interpreted = {
      ...event,
      id: 'event-3',
      sequence: 3,
      baseVersion: 4,
      type: 'fortune.interpreted',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: 'fortune-facts-1',
        fortuneId: 'fortune-record-1',
        interpretation: 'Try something new',
      },
    };
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'fortune-pavilion',
      availability: 'busy',
      activityInstanceId: 'fortune-facts-1',
    }));
    const repeatedReveal = {
      ...revealed,
      id: 'event-3',
      sequence: 3,
      baseVersion: 4,
    };
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...validProjection,
        version: 5,
        lastEventSequence: 3,
        residents: busyResidents,
        activities: [{
          id: 'fortune-facts-1',
          activityId: 'fortune-draw',
          zoneId: 'fortune-pavilion',
          participantIds: ['resident-1', 'resident-2'],
          version: 3,
          state: { status: 'revealed', fortuneId: 'fortune-record-1', rank: 'great' },
        }],
      },
      events: [started, revealed, repeatedReveal],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...validProjection,
        version: 5,
        lastEventSequence: 3,
        residents: busyResidents,
        activities: [{
          id: 'fortune-facts-1',
          activityId: 'fortune-draw',
          zoneId: 'fortune-pavilion',
          participantIds: ['resident-1', 'resident-2'],
          version: 3,
          state: { status: 'revealed', fortuneId: 'fortune-record-1', rank: 'caution' },
        }],
      },
      events: [started, revealed, {
        ...repeatedReveal,
        payload: { ...repeatedReveal.payload, rank: 'caution' },
      }],
    })).toThrow();
    const repeatedInterpretation = {
      ...interpreted,
      id: 'event-4',
      sequence: 4,
      baseVersion: 5,
    };
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...validProjection,
        version: 6,
        lastEventSequence: 4,
        residents: busyResidents,
        activities: [{
          id: 'fortune-facts-1',
          activityId: 'fortune-draw',
          zoneId: 'fortune-pavilion',
          participantIds: ['resident-1', 'resident-2'],
          version: 4,
          state: {
            status: 'interpreted',
            fortuneId: 'fortune-record-1',
            rank: 'great',
            interpretation: 'Try something new',
          },
        }],
      },
      events: [started, revealed, interpreted, repeatedInterpretation],
    })).toThrow();
  });

  it('validates preexisting fortune facts against final phase, version, and text', () => {
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'fortune-pavilion',
      availability: 'busy',
      activityInstanceId: 'fortune-preexisting-1',
    }));
    const finalActivity = {
      id: 'fortune-preexisting-1',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      version: 7,
      state: {
        status: 'interpreted',
        fortuneId: 'fortune-record-1',
        rank: 'good',
        interpretation: 'Final interpretation',
      },
    } as const;
    const interpreted = {
      ...event,
      type: 'fortune.interpreted',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: finalActivity.id,
        fortuneId: 'fortune-record-1',
        interpretation: 'Final interpretation',
      },
    };
    const projection = {
      ...validProjection,
      residents: busyResidents,
      activities: [finalActivity],
    };

    expect(TownAdvanceResponseSchema.parse({ projection, events: [interpreted] }).events).toHaveLength(1);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...projection,
        activities: [{ ...finalActivity, activityId: 'social-play' }],
      },
      events: [interpreted],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection,
      events: [{
        ...interpreted,
        payload: { ...interpreted.payload, interpretation: 'Different interpretation' },
      }],
    })).toThrow();
    const revealed = {
      ...event,
      type: 'fortune.revealed',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: finalActivity.id,
        fortuneId: 'fortune-record-1',
        rank: 'good',
      },
    };
    expect(TownAdvanceResponseSchema.parse({
      projection: {
        ...projection,
        activities: [{
          ...finalActivity,
          version: 2,
          state: { status: 'revealed', fortuneId: 'fortune-record-1', rank: 'good' },
        }],
      },
      events: [revealed],
    }).events).toHaveLength(1);
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...projection,
        activities: [{
          ...finalActivity,
          activityId: 'showcase-stall',
          version: 2,
          state: { status: 'revealed', fortuneId: 'fortune-record-1', rank: 'good' },
        }],
      },
      events: [revealed],
    })).toThrow();
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...projection,
        activities: [{
          ...finalActivity,
          version: 1,
          state: { status: 'started' },
        }],
      },
      events: [revealed],
    })).toThrow();
  });

  it('tracks build start through completion and rejects stale final build activity', () => {
    const buildStarted = {
      ...event,
      type: 'build.started',
      zoneId: 'build-plots',
      payload: {
        modificationId: completedModification.id,
        recipeId: completedModification.recipeId,
        plotId: completedModification.plotId,
      },
    };
    const completed = {
      ...buildCompletedEvent,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
    };
    const finalProjection = {
      ...validProjection,
      version: 4,
      lastEventSequence: 2,
      modifications: [completedModification],
    };

    expect(TownAdvanceResponseSchema.parse({
      projection: finalProjection,
      events: [buildStarted, completed],
    }).events).toHaveLength(2);
    const buildActivity = {
      id: completedModification.id,
      activityId: `build:${completedModification.recipeId}`,
      zoneId: 'build-plots',
      participantIds: ['resident-1'],
      version: 1,
      state: {
        status: 'started',
        modificationId: completedModification.id,
        recipeId: completedModification.recipeId,
        plotId: completedModification.plotId,
      },
    } as const;
    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...finalProjection,
        residents: [{
          ...resident,
          zoneId: 'build-plots',
          availability: 'busy',
          activityInstanceId: buildActivity.id,
        }, npcResident],
        activities: [buildActivity],
      },
      events: [buildStarted, completed],
    })).toThrow();
  });

  it('rejects specialized then generic starts claiming the same activity ID', () => {
    const fortuneStarted = {
      ...event,
      type: 'fortune.started',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: { activityInstanceId: 'fortune-duplicate' },
    };
    const activity = {
      id: 'fortune-duplicate',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      version: 1,
      state: { status: 'started' },
    } as const;
    const genericStarted = {
      ...activityStartedEvent,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
      zoneId: 'fortune-pavilion',
      payload: { activity },
    };
    const busyResidents = [resident, npcResident].map((value) => ({
      ...value,
      zoneId: 'fortune-pavilion',
      availability: 'busy',
      activityInstanceId: activity.id,
    }));

    expect(() => TownAdvanceResponseSchema.parse({
      projection: {
        ...validProjection,
        version: 4,
        lastEventSequence: 2,
        residents: busyResidents,
        activities: [activity],
      },
      events: [fortuneStarted, genericStarted],
    })).toThrow();
  });

  it('reports duplicate start IDs at each variant payload path', () => {
    const starts = [
      {
        event: activityStartedEvent,
        path: 'events.1.payload.activity.id',
      },
      {
        event: {
          ...event,
          type: 'fortune.started',
          zoneId: 'fortune-pavilion',
          payload: { activityInstanceId: 'fortune-path' },
        },
        path: 'events.1.payload.activityInstanceId',
      },
      {
        event: {
          ...event,
          type: 'build.started',
          zoneId: 'build-plots',
          payload: { modificationId: 'build-path', recipeId: 'bench', plotId: 'plot-1' },
        },
        path: 'events.1.payload.modificationId',
      },
      {
        event: {
          ...event,
          type: 'stall.opened',
          zoneId: 'market',
          payload: { stallId: 'stall-path', showcaseItemIds: ['item-1'] },
        },
        path: 'events.1.payload.stallId',
      },
    ] as const;

    for (const { event: started, path } of starts) {
      const result = TownHistoryResponseSchema.safeParse({
        sessionId: 'session-1',
        events: [started, { ...started, id: 'event-2', sequence: 2 }],
        experienceCards: [],
      });
      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected duplicate activity start');
      expect(result.error.issues.some((issue) => issue.path.join('.') === path)).toBe(true);
    }
  });

  it('requires completed modifications to match the final projection canonically', () => {
    expect(
      TownAdvanceResponseSchema.parse({
        projection: { ...validProjection, modifications: [completedModification] },
        events: [buildCompletedEvent],
      }).events,
    ).toHaveLength(1);
    expect(() =>
      TownAdvanceResponseSchema.parse({
        projection: validProjection,
        events: [buildCompletedEvent],
      }),
    ).toThrow();
    expect(() =>
      TownAdvanceResponseSchema.parse({
        projection: {
          ...validProjection,
          modifications: [{ ...completedModification, atlasFrame: 13 }],
        },
        events: [buildCompletedEvent],
      }),
    ).toThrow();
    expect(() =>
      TownAdvanceResponseSchema.parse({
        projection: {
          ...validProjection,
          modifications: [{
            ...completedModification,
            occupiedCells: [...completedModification.occupiedCells].reverse(),
          }],
        },
        events: [buildCompletedEvent],
      }),
    ).toThrow();
  });

  it('reports duplicate completed IDs and cells at the second event payload', () => {
    const duplicateIdEvent = {
      ...buildCompletedEvent,
      id: 'event-2',
      sequence: 2,
      baseVersion: 3,
    };
    const duplicateIdResult = TownAdvanceResponseSchema.safeParse({
      projection: {
        ...validProjection,
        version: 4,
        lastEventSequence: 2,
        modifications: [completedModification],
      },
      events: [buildCompletedEvent, duplicateIdEvent],
    });
    expect(duplicateIdResult.success).toBe(false);
    if (duplicateIdResult.success) throw new Error('Expected duplicate modification ID');
    expect(duplicateIdResult.error.issues.some(({ path }) =>
      path.join('.') === 'events.1.payload.modification.id',
    )).toBe(true);

    const overlappingModification = {
      ...completedModification,
      id: 'mod-completed-2',
      occupiedCells: [{ x: 3, y: 3 }, { x: 4, y: 3 }],
    };
    const overlappingEvent = {
      ...duplicateIdEvent,
      payload: { modification: overlappingModification },
    };
    const overlapResult = TownAdvanceResponseSchema.safeParse({
      projection: {
        ...validProjection,
        version: 4,
        lastEventSequence: 2,
        modifications: [completedModification, overlappingModification],
      },
      events: [buildCompletedEvent, overlappingEvent],
    });
    expect(overlapResult.success).toBe(false);
    if (overlapResult.success) throw new Error('Expected occupied-cell conflict');
    expect(overlapResult.error.issues.some(({ path }) =>
      path.join('.') === 'events.1.payload.modification.occupiedCells.0',
    )).toBe(true);
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

describe('offline recovery requests', () => {
  const request = {
    sessionId: 'session-1',
    residentId: 'resident-1',
    lastConfirmedAt: '2026-07-12T08:30:00.000Z',
    recoveryWindowId: 'recovery-window-1',
  };

  it('requires a valid recovery window ID and remains strict', () => {
    expect(OfflineRecoveryRequestSchema.parse(request)).toEqual(request);
    const missing: Partial<typeof request> = { ...request };
    delete missing.recoveryWindowId;
    expect(() => OfflineRecoveryRequestSchema.parse(missing)).toThrow();
    expect(() => OfflineRecoveryRequestSchema.parse({ ...request, recoveryWindowId: 'bad id' })).toThrow();
    expect(() => OfflineRecoveryRequestSchema.parse({ ...request, retryUrl: 'https://example.com' })).toThrow();
  });
});
