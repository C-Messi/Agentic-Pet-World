import {
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import { reduceTownEvent, TownReducerError } from './event-reducer.js';

const timestamp = '2026-07-13T08:00:00.000Z';

function pet(id: string, source: 'player-pet' | 'resident') {
  return {
    schemaVersion: 'pet-definition.v1' as const,
    id,
    displayName: id,
    source,
    species: 'cat',
    spriteId: id,
    palette: {
      primary: '#112233' as const,
      secondary: '#445566' as const,
      accent: '#778899' as const,
    },
    personality: {
      curiosity: 0.5,
      sociability: 0.5,
      playfulness: 0.5,
      creativity: 0.5,
    },
    voice: { style: 'Plain', catchphrases: [] },
    interests: [],
    publicBio: 'A town cat.',
  };
}

function projection(): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 2,
    lastEventSequence: 4,
    residents: [
      {
        residentId: 'player',
        pet: pet('player-pet', 'player-pet'),
        position: { x: 1, y: 1 },
        zoneId: 'plaza',
        availability: 'available',
      },
      {
        residentId: 'huihui',
        pet: pet('huihui-pet', 'resident'),
        position: { x: 2, y: 1 },
        zoneId: 'plaza',
        availability: 'available',
      },
      {
        residentId: 'doubao',
        pet: pet('doubao-pet', 'resident'),
        position: { x: 3, y: 1 },
        zoneId: 'plaza',
        availability: 'available',
      },
    ],
    relationships: [],
    modifications: [],
    activities: [],
  });
}

function event(
  type: TownEvent['type'],
  payload: unknown,
  options: { participants?: string[]; zoneId?: string; id?: string } = {},
): TownEvent {
  return TownEventSchema.parse({
    id: options.id ?? `event-${type.replace('.', '-')}`,
    sessionId: 'session-1',
    sequence: 5,
    baseVersion: 2,
    type,
    zoneId: options.zoneId ?? 'plaza',
    participantIds: options.participants ?? ['player'],
    timestamp,
    payload,
  });
}

function projectionWithActivity(
  activity: TownProjection['activities'][number],
): TownProjection {
  const participantIds = new Set(activity.participantIds);
  return TownProjectionSchema.parse({
    ...projection(),
    residents: projection().residents.map((resident) =>
      participantIds.has(resident.residentId)
        ? {
            ...resident,
            zoneId: activity.zoneId,
            availability: 'busy',
            activityInstanceId: activity.id,
          }
        : resident,
    ),
    activities: [activity],
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

describe('reduceTownEvent', () => {
  it('moves a referenced resident without mutating a frozen projection', () => {
    const input = deepFreeze(projection());
    const before = structuredClone(input);
    const result = reduceTownEvent(
      input,
      event(
        'resident.moved',
        {
          residentId: 'player',
          position: { x: 9, y: 7 },
        },
        { zoneId: 'garden' },
      ),
    );

    expect(result.residents[0]).toMatchObject({
      position: { x: 9, y: 7 },
      zoneId: 'garden',
    });
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.residents).not.toBe(input.residents);
  });

  it('applies version-only speech and increments version exactly once', () => {
    const input = projection();
    const result = reduceTownEvent(
      input,
      event('resident.spoke', { residentId: 'player', text: 'Hello' }),
    );

    expect(result).toEqual({ ...input, version: 3, lastEventSequence: 5 });
  });

  it('updates only the referenced played activity version and preserves bounded state', () => {
    const input = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        ['player', 'huihui'].includes(resident.residentId)
          ? { ...resident, availability: 'busy', activityInstanceId: 'play-1' }
          : resident,
      ),
      activities: [
        {
          id: 'play-1',
          activityId: 'social-play',
          zoneId: 'plaza',
          participantIds: ['player', 'huihui'],
          version: 7,
          state: { rounds: [1, null, true] },
        },
      ],
    });
    const result = reduceTownEvent(
      input,
      event(
        'residents.played',
        { activityInstanceId: 'play-1' },
        { participants: ['player', 'huihui'] },
      ),
    );

    expect(result).toEqual({
      ...input,
      version: 3,
      lastEventSequence: 5,
      activities: [
        {
          ...input.activities[0],
          version: 8,
        },
      ],
    });
  });

  it('accepts a standalone play encounter without persisting activity or resident state', () => {
    const input = projection();
    const result = reduceTownEvent(
      input,
      event(
        'residents.played',
        { standalone: true, interactionId: 'standalone-play-1' },
        {
          id: 'standalone-play-1',
          participants: ['player', 'huihui'],
          zoneId: 'plaza',
        },
      ),
    );

    expect(result).toEqual({
      ...input,
      version: 3,
      lastEventSequence: 5,
    });
    expect(result.activities).toEqual([]);
    expect(result.residents).toEqual(input.residents);
  });

  it.each([
    ['one', ['player']],
    ['three', ['player', 'huihui', 'doubao']],
  ] as const)(
    'rejects a standalone play encounter with %s participant count',
    (_label, participantIds) => {
      expect(() =>
        reduceTownEvent(
          projection(),
          event(
            'residents.played',
            { standalone: true, interactionId: 'standalone-play-1' },
            {
              id: 'standalone-play-1',
              participants: [...participantIds],
              zoneId: 'plaza',
            },
          ),
        ),
      ).toThrow(
        expect.objectContaining({
          code: 'conflict',
          message: expect.stringMatching(/exactly two participants/i),
        }),
      );
    },
  );

  it('rejects a standalone play encounter without a zone', () => {
    const withoutZone = event(
      'residents.played',
      { standalone: true, interactionId: 'standalone-play-1' },
      {
        id: 'standalone-play-1',
        participants: ['player', 'huihui'],
        zoneId: 'plaza',
      },
    );
    delete withoutZone.zoneId;

    expect(() => reduceTownEvent(projection(), withoutZone)).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringMatching(/zone/i),
      }),
    );
  });

  it('rejects a standalone play encounter with an unavailable participant', () => {
    const input = projectionWithActivity({
      id: 'fortune-1',
      activityId: 'fortune-draw',
      zoneId: 'plaza',
      participantIds: ['player'],
      version: 1,
      state: { status: 'started' },
    });

    expect(() =>
      reduceTownEvent(
        input,
        event(
          'residents.played',
          { standalone: true, interactionId: 'standalone-play-1' },
          {
            id: 'standalone-play-1',
            participants: ['player', 'huihui'],
            zoneId: 'plaza',
          },
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringMatching(/unavailable|busy/i),
      }),
    );
  });

  it('rejects an unknown standalone play participant before encounter validation', () => {
    expect(() =>
      reduceTownEvent(
        projection(),
        event(
          'residents.played',
          { standalone: true, interactionId: 'standalone-play-1' },
          {
            id: 'standalone-play-1',
            participants: ['player', 'missing'],
            zoneId: 'plaza',
          },
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid-reference',
        message: expect.stringMatching(/resident not found/i),
      }),
    );
  });

  it('allows a standalone interaction ID to overlap a live modification ID', () => {
    const input = TownProjectionSchema.parse({
      ...projection(),
      modifications: [
        {
          id: 'standalone-play-1',
          recipeId: 'stone-path',
          plotId: 'plot-1',
          occupiedCells: [{ x: 1, y: 1 }],
          atlasFrame: 1,
          collision: false,
        },
      ],
    });

    expect(
      reduceTownEvent(
        input,
        event(
          'residents.played',
          { standalone: true, interactionId: 'standalone-play-1' },
          {
            id: 'standalone-play-1',
            participants: ['player', 'huihui'],
            zoneId: 'plaza',
          },
        ),
      ),
    ).toEqual({ ...input, version: 3, lastEventSequence: 5 });
  });

  it('rejects a standalone play encounter when a participant is in another zone', () => {
    const input = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'huihui'
          ? { ...resident, zoneId: 'garden' }
          : resident,
      ),
    });

    expect(() =>
      reduceTownEvent(
        input,
        event(
          'residents.played',
          { standalone: true, interactionId: 'standalone-play-1' },
          {
            id: 'standalone-play-1',
            participants: ['player', 'huihui'],
            zoneId: 'plaza',
          },
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'conflict',
        message: expect.stringMatching(/zone/i),
      }),
    );
  });

  it('rejects duplicate standalone play participants', () => {
    expect(() =>
      reduceTownEvent(projection(), {
        id: 'standalone-play-1',
        sessionId: 'session-1',
        sequence: 5,
        baseVersion: 2,
        type: 'residents.played',
        zoneId: 'plaza',
        participantIds: ['player', 'player'],
        timestamp,
        payload: { standalone: true, interactionId: 'standalone-play-1' },
      }),
    ).toThrow();
  });

  it('allows a standalone interaction ID to overlap a live activity ID', () => {
    const input = projectionWithActivity({
      id: 'standalone-play-1',
      activityId: 'social-play',
      zoneId: 'plaza',
      participantIds: ['doubao'],
      version: 1,
      state: {},
    });

    expect(
      reduceTownEvent(
        input,
        event(
          'residents.played',
          { standalone: true, interactionId: 'standalone-play-1' },
          {
            id: 'standalone-play-1',
            participants: ['player', 'huihui'],
            zoneId: 'plaza',
          },
        ),
      ),
    ).toEqual({ ...input, version: 3, lastEventSequence: 5 });
  });

  it('keeps legacy played events dependent on a live social-play activity', () => {
    expect(() =>
      reduceTownEvent(
        projection(),
        event(
          'residents.played',
          { activityInstanceId: 'missing-activity' },
          { participants: ['player', 'huihui'] },
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid-reference',
        message: expect.stringMatching(/activity not found/i),
      }),
    );
  });

  it('starts a generic activity and sets reciprocal participant state', () => {
    const activity = {
      id: 'social-1',
      activityId: 'social-play',
      zoneId: 'arcade-house' as const,
      participantIds: ['player', 'huihui'],
      version: 0,
      state: { schemaVersion: 'social-play.v1', phase: 'started' },
    };
    const result = reduceTownEvent(
      projection(),
      event(
        'activity.started',
        { activity },
        { participants: ['huihui', 'player'], zoneId: 'arcade-house' },
      ),
    );

    expect(result.activities).toEqual([activity]);
    expect(result.residents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          residentId: 'player',
          availability: 'busy',
          activityInstanceId: 'social-1',
          zoneId: 'arcade-house',
        }),
        expect.objectContaining({
          residentId: 'huihui',
          availability: 'busy',
          activityInstanceId: 'social-1',
          zoneId: 'arcade-house',
        }),
      ]),
    );
  });

  it('rejects duplicate, missing, and busy generic activity participants with stable codes', () => {
    const activity = {
      id: 'social-1',
      activityId: 'social-play',
      zoneId: 'arcade-house' as const,
      participantIds: ['player'],
      version: 0,
      state: { phase: 'started' },
    };
    const existing = projectionWithActivity(activity);
    expect(() =>
      reduceTownEvent(
        existing,
        event('activity.started', { activity }, { zoneId: 'arcade-house' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));

    const missingActivity = {
      ...activity,
      id: 'social-2',
      participantIds: ['missing'],
    };
    expect(() =>
      reduceTownEvent(
        projection(),
        event(
          'activity.started',
          { activity: missingActivity },
          { participants: ['missing'], zoneId: 'arcade-house' },
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-reference' }));

    const busyActivity = { ...activity, id: 'social-2' };
    expect(() =>
      reduceTownEvent(
        existing,
        event(
          'activity.started',
          { activity: busyActivity },
          { zoneId: 'arcade-house' },
        ),
      ),
    ).toThrow(expect.objectContaining({ code: 'conflict' }));
  });

  it.each([
    ['cross-kind', 'fortune-draw', ['player', 'huihui'], 'plaza'],
    ['wrong participants', 'social-play', ['player'], 'plaza'],
    ['wrong zone', 'social-play', ['player', 'huihui'], 'garden'],
  ] as const)(
    'rejects a %s played transition',
    (_label, activityId, participants, zoneId) => {
      const input = projectionWithActivity({
        id: 'play-1',
        activityId,
        zoneId: 'plaza',
        participantIds: ['player', 'huihui'],
        version: 1,
        state: {},
      });
      expect(() =>
        reduceTownEvent(
          input,
          event(
            'residents.played',
            { activityInstanceId: 'play-1' },
            { participants: [...participants], zoneId },
          ),
        ),
      ).toThrow(/activity kind|participants|zone/i);
    },
  );

  it('rejects interpretation before reveal and a changed selected fortune ID', () => {
    const started = projectionWithActivity({
      id: 'fortune-1',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['player'],
      version: 1,
      state: { status: 'started' },
    });
    const interpretation = event(
      'fortune.interpreted',
      {
        activityInstanceId: 'fortune-1',
        fortuneId: 'fortune-record-1',
        interpretation: 'Meaning',
      },
      { zoneId: 'fortune-pavilion' },
    );
    expect(() => reduceTownEvent(started, interpretation)).toThrow(/reveal/i);

    const revealed = TownProjectionSchema.parse({
      ...started,
      activities: [
        {
          ...started.activities[0]!,
          version: 2,
          state: {
            status: 'revealed',
            fortuneId: 'fortune-record-1',
            rank: 'good',
          },
        },
      ],
    });
    expect(() =>
      reduceTownEvent(
        revealed,
        TownEventSchema.parse({
          ...interpretation,
          payload: {
            activityInstanceId: 'fortune-1',
            fortuneId: 'fortune-record-2',
            interpretation: 'Meaning',
          },
        }),
      ),
    ).toThrow(/fortune.*match|selected/i);
  });

  it('starts, reveals, and interprets a fortune using explicit protocol state', () => {
    const started = reduceTownEvent(
      projection(),
      event(
        'fortune.started',
        { activityInstanceId: 'fortune-1' },
        { participants: ['player', 'huihui'], zoneId: 'fortune-pavilion' },
      ),
    );
    expect(started.activities[0]).toEqual({
      id: 'fortune-1',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['player', 'huihui'],
      version: 1,
      state: { status: 'started' },
    });
    expect(
      started.residents
        .slice(0, 2)
        .every(({ availability }) => availability === 'busy'),
    ).toBe(true);

    const revealedEvent = {
      ...event(
        'fortune.revealed',
        {
          activityInstanceId: 'fortune-1',
          fortuneId: 'fortune-record-1',
          rank: 'great',
        },
        { participants: ['player', 'huihui'], zoneId: 'fortune-pavilion' },
      ),
      baseVersion: 3,
      sequence: 6,
    };
    const revealed = reduceTownEvent(started, revealedEvent);
    expect(revealed.activities[0]?.state).toEqual({
      status: 'revealed',
      fortuneId: 'fortune-record-1',
      rank: 'great',
    });

    const interpretedEvent = {
      ...event(
        'fortune.interpreted',
        {
          activityInstanceId: 'fortune-1',
          fortuneId: 'fortune-record-1',
          interpretation: 'Try something new',
        },
        { participants: ['player', 'huihui'], zoneId: 'fortune-pavilion' },
      ),
      baseVersion: 4,
      sequence: 7,
    };
    const interpreted = reduceTownEvent(revealed, interpretedEvent);
    expect(interpreted.activities[0]?.state).toEqual({
      status: 'interpreted',
      fortuneId: 'fortune-record-1',
      rank: 'great',
      interpretation: 'Try something new',
    });
    expect(interpreted.activities[0]?.version).toBe(3);
  });

  it.each([
    ['cross-kind', 'social-play', ['player', 'huihui'], 'fortune-pavilion'],
    ['wrong participants', 'fortune-draw', ['player'], 'fortune-pavilion'],
    ['wrong zone', 'fortune-draw', ['player', 'huihui'], 'garden'],
  ] as const)(
    'rejects a %s fortune transition',
    (_label, activityId, participants, zoneId) => {
      const input = projectionWithActivity({
        id: 'fortune-1',
        activityId,
        zoneId: 'fortune-pavilion',
        participantIds: ['player', 'huihui'],
        version: 1,
        state: { status: 'started' },
      });
      expect(() =>
        reduceTownEvent(
          input,
          event(
            'fortune.revealed',
            {
              activityInstanceId: 'fortune-1',
              fortuneId: 'fortune-record-1',
              rank: 'good',
            },
            { participants: [...participants], zoneId },
          ),
        ),
      ).toThrow(/activity kind|participants|zone/i);
    },
  );

  it('rejects duplicate fortune, build, and stall starts', () => {
    const fortune = projectionWithActivity({
      id: 'fortune-1',
      activityId: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      participantIds: ['player'],
      version: 1,
      state: {},
    });
    expect(() =>
      reduceTownEvent(
        fortune,
        event(
          'fortune.started',
          { activityInstanceId: 'fortune-1' },
          { zoneId: 'fortune-pavilion' },
        ),
      ),
    ).toThrow(/already exists/i);
    const build = projectionWithActivity({
      id: 'mod-1',
      activityId: 'build:stone-path',
      zoneId: 'build-plots',
      participantIds: ['player'],
      version: 1,
      state: {
        modificationId: 'mod-1',
        recipeId: 'stone-path',
        plotId: 'plot-1',
      },
    });
    expect(() =>
      reduceTownEvent(
        build,
        event(
          'build.started',
          { modificationId: 'mod-1', recipeId: 'stone-path', plotId: 'plot-1' },
          { zoneId: 'build-plots' },
        ),
      ),
    ).toThrow(/already exists/i);
    const stall = projectionWithActivity({
      id: 'stall-1',
      activityId: 'showcase-stall',
      zoneId: 'market',
      participantIds: ['player'],
      version: 1,
      state: {},
    });
    expect(() =>
      reduceTownEvent(
        stall,
        event(
          'stall.opened',
          { stallId: 'stall-1', showcaseItemIds: ['item-1'] },
          { zoneId: 'market' },
        ),
      ),
    ).toThrow(/already exists/i);
  });

  it('rejects a build start whose modification ID is already durable', () => {
    const modification = {
      id: 'mod-1',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 1, y: 1 }],
      atlasFrame: 1,
      collision: false,
    };
    const input = TownProjectionSchema.parse({
      ...projection(),
      modifications: [modification],
    });
    expect(() =>
      reduceTownEvent(
        input,
        event(
          'build.started',
          {
            modificationId: 'mod-1',
            recipeId: 'stone-path',
            plotId: 'plot-1',
          },
          { zoneId: 'build-plots' },
        ),
      ),
    ).toThrow(/modification already exists/i);
  });

  it('tracks a build start and adds the exact completed modification once', () => {
    const started = reduceTownEvent(
      projection(),
      event(
        'build.started',
        { modificationId: 'mod-1', recipeId: 'stone-path', plotId: 'plot-1' },
        { zoneId: 'build-plots' },
      ),
    );
    expect(started.activities[0]).toMatchObject({
      id: 'mod-1',
      activityId: 'build:stone-path',
      version: 1,
    });

    const modification = {
      id: 'mod-1',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 4, y: 5 }],
      atlasFrame: 2,
      collision: false,
    };
    const completed = reduceTownEvent(started, {
      ...event('build.completed', { modification }, { zoneId: 'build-plots' }),
      baseVersion: 3,
      sequence: 6,
    });
    expect(completed.modifications).toEqual([modification]);
    expect(completed.activities).toEqual([]);
    expect(completed.residents[0]).toMatchObject({ availability: 'available' });
  });

  it('rejects build completion without its tracked build activity', () => {
    const modification = {
      id: 'mod-missing',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 4, y: 5 }],
      atlasFrame: 2,
      collision: false,
    };
    expect(() =>
      reduceTownEvent(
        projection(),
        event('build.completed', { modification }, { zoneId: 'build-plots' }),
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid-reference' }));
  });

  it.each(['activity.started', 'fortune.started', 'stall.opened'] as const)(
    'rejects %s IDs that collide with durable modifications',
    (type) => {
      const modification = {
        id: 'shared-id',
        recipeId: 'stone-path',
        plotId: 'plot-1',
        occupiedCells: [{ x: 8, y: 8 }],
        atlasFrame: 2,
        collision: false,
      };
      const input = TownProjectionSchema.parse({
        ...projection(),
        modifications: [modification],
      });
      const generated =
        type === 'activity.started'
          ? event(
              type,
              {
                activity: {
                  id: 'shared-id',
                  activityId: 'social-play',
                  zoneId: 'arcade-house',
                  participantIds: ['player'],
                  version: 0,
                  state: {},
                },
              },
              { zoneId: 'arcade-house' },
            )
          : type === 'fortune.started'
            ? event(
                type,
                { activityInstanceId: 'shared-id' },
                { zoneId: 'fortune-pavilion' },
              )
            : event(
                type,
                { stallId: 'shared-id', showcaseItemIds: ['item-1'] },
                { zoneId: 'market' },
              );
      expect(() => reduceTownEvent(input, generated)).toThrow(
        expect.objectContaining({ code: 'conflict' }),
      );
    },
  );

  it('rejects build completion kind, recipe, plot, participant, and zone mismatches', () => {
    const modification = {
      id: 'mod-1',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 4, y: 5 }],
      atlasFrame: 2,
      collision: false,
    };
    const baseActivity = {
      id: 'mod-1',
      activityId: 'build:stone-path',
      zoneId: 'build-plots' as const,
      participantIds: ['player'],
      version: 1,
      state: {
        status: 'started',
        modificationId: 'mod-1',
        recipeId: 'stone-path',
        plotId: 'plot-1',
      },
    };
    const cases = [
      {
        activity: { ...baseActivity, activityId: 'social-play' },
        modification,
        participants: ['player'],
        zoneId: 'build-plots',
      },
      {
        activity: baseActivity,
        modification: { ...modification, recipeId: 'flower-patch' },
        participants: ['player'],
        zoneId: 'build-plots',
      },
      {
        activity: baseActivity,
        modification: { ...modification, plotId: 'plot-2' },
        participants: ['player'],
        zoneId: 'build-plots',
      },
      {
        activity: baseActivity,
        modification,
        participants: ['huihui'],
        zoneId: 'build-plots',
      },
      {
        activity: baseActivity,
        modification,
        participants: ['player'],
        zoneId: 'garden',
      },
    ];
    for (const transition of cases) {
      const input = projectionWithActivity(transition.activity);
      expect(() =>
        reduceTownEvent(
          input,
          event(
            'build.completed',
            { modification: transition.modification },
            {
              participants: transition.participants,
              zoneId: transition.zoneId,
            },
          ),
        ),
      ).toThrow(/activity kind|recipe|plot|participants|zone/i);
    }
  });

  it('opens, visits, and closes a stall while maintaining activity membership', () => {
    const opened = reduceTownEvent(
      projection(),
      event(
        'stall.opened',
        { stallId: 'stall-1', showcaseItemIds: ['item-1'] },
        { participants: ['player'], zoneId: 'market' },
      ),
    );
    expect(opened.activities[0]).toEqual({
      id: 'stall-1',
      activityId: 'showcase-stall',
      zoneId: 'market',
      participantIds: ['player'],
      version: 1,
      state: { status: 'open', showcaseItemIds: ['item-1'] },
    });

    const visited = reduceTownEvent(opened, {
      ...event(
        'stall.visited',
        { stallId: 'stall-1', visitorResidentId: 'huihui' },
        { participants: ['huihui', 'player'], zoneId: 'market' },
      ),
      baseVersion: 3,
      sequence: 6,
    });
    expect(visited.activities[0]?.state).toEqual({
      status: 'open',
      showcaseItemIds: ['item-1'],
      lastVisitorResidentId: 'huihui',
    });
    expect(
      visited.residents.find(({ residentId }) => residentId === 'huihui'),
    ).toMatchObject({ availability: 'available', zoneId: 'plaza' });
    expect(visited.activities[0]?.participantIds).toEqual(['player']);

    const closed = reduceTownEvent(visited, {
      ...event(
        'stall.closed',
        { stallId: 'stall-1' },
        { participants: ['player'], zoneId: 'market' },
      ),
      baseVersion: 4,
      sequence: 7,
    });
    expect(closed.activities).toEqual([]);
    expect(closed.residents[0]).toMatchObject({ availability: 'available' });
  });

  it.each([
    ['cross-kind', 'fortune-draw', ['player', 'huihui'], 'market'],
    ['missing owner', 'showcase-stall', ['huihui'], 'market'],
    ['wrong zone', 'showcase-stall', ['player', 'huihui'], 'garden'],
  ] as const)(
    'rejects a %s stall visit',
    (_label, activityId, participants, zoneId) => {
      const input = projectionWithActivity({
        id: 'stall-1',
        activityId,
        zoneId: 'market',
        participantIds: ['player'],
        version: 1,
        state: { status: 'open' },
      });
      expect(() =>
        reduceTownEvent(
          input,
          event(
            'stall.visited',
            { stallId: 'stall-1', visitorResidentId: 'huihui' },
            { participants: [...participants], zoneId },
          ),
        ),
      ).toThrow(/activity kind|participants|zone/i);
    },
  );

  it('rejects a stall visit from an unavailable visitor', () => {
    const base = projection();
    const input = TownProjectionSchema.parse({
      ...base,
      residents: base.residents.map((resident) => {
        if (resident.residentId === 'player')
          return {
            ...resident,
            zoneId: 'market',
            availability: 'busy',
            activityInstanceId: 'stall-1',
          };
        if (resident.residentId === 'huihui')
          return {
            ...resident,
            availability: 'busy',
            activityInstanceId: 'play-1',
          };
        return resident;
      }),
      activities: [
        {
          id: 'stall-1',
          activityId: 'showcase-stall',
          zoneId: 'market',
          participantIds: ['player'],
          version: 1,
          state: { status: 'open' },
        },
        {
          id: 'play-1',
          activityId: 'social-play',
          zoneId: 'plaza',
          participantIds: ['huihui'],
          version: 1,
          state: {},
        },
      ],
    });
    expect(() =>
      reduceTownEvent(
        input,
        event(
          'stall.visited',
          { stallId: 'stall-1', visitorResidentId: 'huihui' },
          { participants: ['player', 'huihui'], zoneId: 'market' },
        ),
      ),
    ).toThrow(/visitor.*unavailable|visitor.*busy/i);
  });

  it('starts and returns a player outing without touching other residents', () => {
    const started = reduceTownEvent(
      projection(),
      event('outing.started', { residentId: 'player' }, { zoneId: 'gate' }),
    );
    expect(started.residents[0]).toMatchObject({
      zoneId: 'gate',
      availability: 'available',
    });
    const returned = reduceTownEvent(started, {
      ...event(
        'outing.returned',
        { residentId: 'player' },
        { zoneId: 'plaza' },
      ),
      baseVersion: 3,
      sequence: 6,
    });
    expect(returned.residents[0]).toMatchObject({
      zoneId: 'plaza',
      availability: 'available',
    });
    expect(returned.residents.slice(1)).toEqual(
      projection().residents.slice(1),
    );
  });

  it('stores absolute relationship affinity with stable unordered identity and source', () => {
    const first = reduceTownEvent(
      projection(),
      event(
        'relationship.changed',
        { residentIdA: 'huihui', residentIdB: 'player', affinity: 1 },
        { participants: ['huihui', 'player'], id: 'relationship-event' },
      ),
    );
    expect(first.relationships).toEqual([
      {
        residentIdA: 'huihui',
        residentIdB: 'player',
        affinity: 1,
        sourceEventId: 'relationship-event',
        sourceVersion: 3,
      },
    ]);

    const changed = reduceTownEvent(first, {
      ...event(
        'relationship.changed',
        { residentIdA: 'player', residentIdB: 'huihui', affinity: -1 },
        { participants: ['player', 'huihui'], id: 'relationship-event-2' },
      ),
      baseVersion: 3,
      sequence: 6,
    });
    expect(changed.relationships).toEqual([
      {
        residentIdA: 'huihui',
        residentIdB: 'player',
        affinity: -1,
        sourceEventId: 'relationship-event-2',
        sourceVersion: 4,
      },
    ]);
  });

  it('preserves an existing relationship pair identity regardless of payload order', () => {
    const input = TownProjectionSchema.parse({
      ...projection(),
      relationships: [
        {
          residentIdA: 'player',
          residentIdB: 'huihui',
          affinity: 0.2,
          sourceEventId: 'old-event',
          sourceVersion: 2,
        },
      ],
    });
    const result = reduceTownEvent(
      input,
      event(
        'relationship.changed',
        { residentIdA: 'huihui', residentIdB: 'player', affinity: 0.7 },
        { participants: ['huihui', 'player'], id: 'new-event' },
      ),
    );

    expect(result.relationships).toEqual([
      {
        residentIdA: 'player',
        residentIdB: 'huihui',
        affinity: 0.7,
        sourceEventId: 'new-event',
        sourceVersion: 3,
      },
    ]);
  });

  it.each([
    ['session', { sessionId: 'other-session' }],
    ['base version', { baseVersion: 1 }],
    ['sequence', { sequence: 9 }],
  ])('rejects a wrong %s', (_label, override) => {
    expect(() =>
      reduceTownEvent(projection(), {
        ...event('resident.spoke', { residentId: 'player', text: 'Hi' }),
        ...override,
      }),
    ).toThrow();
  });

  it('uses typed stale version and sequence errors with context', () => {
    const base = event('resident.spoke', { residentId: 'player', text: 'Hi' });
    try {
      reduceTownEvent(projection(), { ...base, baseVersion: 1 });
      throw new Error('Expected stale version');
    } catch (error) {
      expect(error).toBeInstanceOf(TownReducerError);
      expect(error).toMatchObject({
        code: 'stale-version',
        context: { expected: 2, received: 1 },
      });
    }
    expect(() =>
      reduceTownEvent(projection(), { ...base, sequence: 9 }),
    ).toThrow(
      expect.objectContaining({
        code: 'stale-sequence',
        context: { expected: 5, received: 9 },
      }),
    );
  });

  it('rejects missing resident and activity references with domain errors', () => {
    expect(() =>
      reduceTownEvent(
        projection(),
        event(
          'resident.moved',
          { residentId: 'missing', position: { x: 1, y: 1 } },
          { participants: ['missing'] },
        ),
      ),
    ).toThrow(/resident not found/i);
    expect(() =>
      reduceTownEvent(
        projection(),
        event('fortune.revealed', {
          activityInstanceId: 'missing',
          fortuneId: 'fortune-record-1',
          rank: 'good',
        }),
      ),
    ).toThrow(/activity not found/i);
    expect(() =>
      reduceTownEvent(
        projection(),
        event('stall.closed', { stallId: 'missing' }),
      ),
    ).toThrow(/activity not found/i);
  });

  it('rejects duplicate modification IDs and occupied cells', () => {
    const existing = {
      id: 'mod-1',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 1, y: 1 }],
      atlasFrame: 1,
      collision: false,
    };
    const tracked = (id: string) =>
      projectionWithActivity({
        id,
        activityId: 'build:stone-path',
        zoneId: 'build-plots',
        participantIds: ['player'],
        version: 1,
        state: { modificationId: id, recipeId: 'stone-path', plotId: 'plot-1' },
      });
    const input = TownProjectionSchema.parse({
      ...tracked('mod-1'),
      modifications: [existing],
    });
    expect(() =>
      reduceTownEvent(
        input,
        event(
          'build.completed',
          { modification: existing },
          { zoneId: 'build-plots' },
        ),
      ),
    ).toThrow(/modification.*already exists/i);
    expect(() =>
      reduceTownEvent(
        TownProjectionSchema.parse({
          ...tracked('mod-2'),
          modifications: [existing],
        }),
        event(
          'build.completed',
          { modification: { ...existing, id: 'mod-2' } },
          { zoneId: 'build-plots' },
        ),
      ),
    ).toThrow(/occupied cell/i);
  });

  it('returns schema-valid output for every accepted event', () => {
    const result = reduceTownEvent(
      projection(),
      event('resident.spoke', { residentId: 'player', text: 'Valid' }),
    );
    expect(TownProjectionSchema.parse(result)).toEqual(result);
  });
});
