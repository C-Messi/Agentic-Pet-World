import {
  TownAdvanceResponseSchema,
  TownEventSchema,
  TownIntentSchema,
  TownProjectionSchema,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import { reduceTownEvent } from './event-reducer.js';
import {
  TownSimulationService,
  TownSimulationError,
  townIntentWeight,
  type TownSimulationPorts,
} from './simulation-service.js';

function residentPet(
  id: string,
  source: 'player-pet' | 'resident',
  personality: {
    curiosity: number;
    sociability: number;
    playfulness: number;
    creativity: number;
  },
) {
  return {
    schemaVersion: 'pet-definition.v1' as const,
    id: `${id}-pet`,
    displayName: id,
    source,
    species: 'cat',
    spriteId: id,
    palette: {
      primary: '#112233' as const,
      secondary: '#445566' as const,
      accent: '#778899' as const,
    },
    personality,
    voice: { style: 'Plain', catchphrases: [] },
    interests: [],
    publicBio: 'A town cat.',
  };
}

function projection(): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 0,
    lastEventSequence: 0,
    residents: [
      {
        residentId: 'player',
        pet: residentPet('player', 'player-pet', {
          curiosity: 0.5,
          sociability: 0.6,
          playfulness: 0.5,
          creativity: 0.5,
        }),
        position: { x: 0, y: 0 },
        zoneId: 'plaza',
        availability: 'available',
      },
      {
        residentId: 'huihui',
        pet: residentPet('huihui', 'resident', {
          curiosity: 0.4,
          sociability: 0.9,
          playfulness: 0.2,
          creativity: 0.3,
        }),
        position: { x: 1, y: 0 },
        zoneId: 'plaza',
        availability: 'available',
      },
      {
        residentId: 'reserved',
        pet: residentPet('reserved', 'resident', {
          curiosity: 0.5,
          sociability: 0.1,
          playfulness: 0.3,
          creativity: 0.8,
        }),
        position: { x: 2, y: 0 },
        zoneId: 'plaza',
        availability: 'available',
      },
    ],
    relationships: [],
    modifications: [],
    activities: [],
  });
}

function ports(random = 0.5): TownSimulationPorts {
  let event = 0;
  let activity = 0;
  return {
    random: () => random,
    now: () => '2026-07-13T09:00:00.000Z',
    nextId: (prefix) =>
      prefix === 'town-event'
        ? `town-event-${++event}`
        : `activity-${++activity}`,
  };
}

function projectionWithExistingActivity(
  id = 'activity-collision',
  activityId = 'existing',
): TownProjection {
  const base = projection();
  return TownProjectionSchema.parse({
    ...base,
    residents: base.residents.map((resident) =>
      resident.residentId === 'reserved'
        ? { ...resident, availability: 'busy', activityInstanceId: id }
        : resident,
    ),
    activities: [
      {
        id,
        activityId,
        zoneId: 'plaza',
        participantIds: ['reserved'],
        version: 0,
        state: {},
      },
    ],
  });
}

function generatedActivityId(
  events: readonly ReturnType<typeof TownEventSchema.parse>[],
): string | undefined {
  for (const generated of events) {
    switch (generated.type) {
      case 'activity.started':
        return generated.payload.activity.id;
      case 'fortune.started':
        return generated.payload.fortuneId;
      case 'build.started':
        return generated.payload.modificationId;
      default:
        break;
    }
  }
  return undefined;
}

function service(random = 0.5) {
  return new TownSimulationService(ports(random), {
    accessibleZones: [
      'gate',
      'plaza',
      'fortune-pavilion',
      'market',
      'garden',
      'build-plots',
      'arcade-house',
    ],
    activities: [
      { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
      { id: 'social-play', zoneId: 'arcade-house', capacity: 3 },
      { id: 'showcase-stall', zoneId: 'market', capacity: 1 },
    ],
    recipes: ['stone-path'],
    buildPlots: ['plot-1'],
    publicShowcaseItemIds: (actorId) =>
      actorId === 'player' ? ['item-1', 'item-2'] : [],
  });
}

describe('TownSimulationService candidates and selection', () => {
  it('skips unknown, unavailable, and busy residents', () => {
    expect(service().candidates(projection(), 'missing')).toEqual([]);
    const busy = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'huihui'
          ? { ...resident, availability: 'busy', activityInstanceId: 'play-1' }
          : resident,
      ),
      activities: [
        {
          id: 'play-1',
          activityId: 'social-play',
          zoneId: 'plaza',
          participantIds: ['huihui'],
          version: 0,
          state: {},
        },
      ],
    });
    expect(service().candidates(busy, 'huihui')).toEqual([]);
  });

  it('uses personality-derived weights and gives Huihui more socialize weight', () => {
    const huihui: TownIntent = {
      type: 'socialize',
      actorId: 'huihui',
      targetResidentId: 'player',
    };
    const reserved: TownIntent = {
      type: 'socialize',
      actorId: 'reserved',
      targetResidentId: 'player',
    };
    expect(townIntentWeight(projection(), huihui)).toBeGreaterThan(
      townIntentWeight(projection(), reserved),
    );
  });

  it('weights curiosity, playfulness, and creativity for their matching intents', () => {
    const town = projection();
    const comparisons: readonly [TownIntent, TownIntent][] = [
      [
        { type: 'visit-zone', actorId: 'reserved', zoneId: 'garden' },
        { type: 'visit-zone', actorId: 'huihui', zoneId: 'garden' },
      ],
      [
        {
          type: 'start-activity',
          actorId: 'reserved',
          activityId: 'fortune-draw',
          invitedResidentIds: [],
        },
        {
          type: 'start-activity',
          actorId: 'huihui',
          activityId: 'fortune-draw',
          invitedResidentIds: [],
        },
      ],
      [
        {
          type: 'start-activity',
          actorId: 'reserved',
          activityId: 'social-play',
          invitedResidentIds: [],
        },
        {
          type: 'start-activity',
          actorId: 'huihui',
          activityId: 'social-play',
          invitedResidentIds: [],
        },
      ],
      [
        {
          type: 'build',
          actorId: 'reserved',
          recipeId: 'stone-path',
          plotId: 'plot-1',
        },
        {
          type: 'build',
          actorId: 'huihui',
          recipeId: 'stone-path',
          plotId: 'plot-1',
        },
      ],
      [
        {
          type: 'open-stall',
          actorId: 'reserved',
          stallId: 'stall-reserved',
          showcaseItemIds: ['reserved-item'],
        },
        {
          type: 'open-stall',
          actorId: 'huihui',
          stallId: 'stall-huihui',
          showcaseItemIds: ['huihui-item'],
        },
      ],
    ];
    for (const [higher, lower] of comparisons) {
      expect(townIntentWeight(town, higher)).toBeGreaterThan(
        townIntentWeight(town, lower),
      );
    }
  });

  it('uses relationship affinity in socialize weight', () => {
    const relationship = {
      residentIdA: 'huihui',
      residentIdB: 'player',
      affinity: 0.9,
      sourceEventId: 'relationship-1',
      sourceVersion: 0,
    };
    const positive = TownProjectionSchema.parse({
      ...projection(),
      relationships: [relationship],
    });
    const negative = TownProjectionSchema.parse({
      ...projection(),
      relationships: [{ ...relationship, affinity: -0.9 }],
    });
    const intent: TownIntent = {
      type: 'socialize',
      actorId: 'huihui',
      targetResidentId: 'player',
    };
    expect(townIntentWeight(positive, intent)).toBeGreaterThan(
      townIntentWeight(negative, intent),
    );
  });

  it('removes cooldown candidates and filters activities at live capacity', () => {
    const cooldown = new TownSimulationService(ports(), {
      contextForResident: () => ({
        cooldownIntentTypes: ['build'],
        outingDurationMs: 0,
      }),
      recipes: ['stone-path'],
      buildPlots: ['plot-1'],
    });
    expect(
      cooldown
        .candidates(projection(), 'huihui')
        .some(({ type }) => type === 'build'),
    ).toBe(false);

    const fullTown = projectionWithExistingActivity('full-play', 'social-play');
    const capacity = new TownSimulationService(ports(), {
      activities: [{ id: 'social-play', zoneId: 'plaza', capacity: 1 }],
    });
    expect(capacity.candidates(fullTown, 'huihui')).not.toContainEqual(
      expect.objectContaining({
        type: 'start-activity',
        activityId: 'social-play',
      }),
    );
  });

  it('unfinished goals and outing duration change deterministic selection', () => {
    const baseOptions = {
      accessibleZones: ['plaza', 'garden'] as const,
      activities: [],
      recipes: [],
      buildPlots: [],
    };
    const withoutGoal = new TownSimulationService(ports(0.7), {
      ...baseOptions,
      contextForResident: () => ({
        cooldownIntentTypes: [],
        outingDurationMs: 0,
      }),
    });
    const withGoal = new TownSimulationService(ports(0.7), {
      ...baseOptions,
      contextForResident: () => ({
        cooldownIntentTypes: [],
        unfinishedGoalType: 'visit-zone',
        outingDurationMs: 0,
      }),
    });
    expect(withoutGoal.select(projection(), 'huihui')?.type).not.toBe(
      'visit-zone',
    );
    expect(withGoal.select(projection(), 'huihui')?.type).toBe('visit-zone');

    const returnOptions = {
      accessibleZones: ['plaza', 'gate'] as const,
      activities: [],
      recipes: [],
      buildPlots: [],
    };
    const short = new TownSimulationService(ports(0.8), {
      ...returnOptions,
      contextForResident: () => ({
        cooldownIntentTypes: [],
        outingDurationMs: 0,
      }),
    });
    const long = new TownSimulationService(ports(0.8), {
      ...returnOptions,
      contextForResident: () => ({
        cooldownIntentTypes: [],
        outingDurationMs: 604_800_000,
      }),
    });
    expect(short.select(projection(), 'player')?.type).not.toBe('return-home');
    expect(long.select(projection(), 'player')?.type).toBe('return-home');
  });

  it('evaluates resident context once during selection', () => {
    let calls = 0;
    const subject = new TownSimulationService(ports(), {
      contextForResident: () => {
        calls += 1;
        return { cooldownIntentTypes: [], outingDurationMs: 0 };
      },
    });
    subject.select(projection(), 'huihui');
    expect(calls).toBe(1);
  });

  it('selects deterministically with injected clamped random values', () => {
    expect(service(-10).select(projection(), 'huihui')).toEqual(
      service(-10).candidates(projection(), 'huihui')[0],
    );
    const highService = service(5);
    const candidates = highService.candidates(projection(), 'huihui');
    expect(highService.select(projection(), 'huihui')).toEqual(
      candidates.at(-1),
    );
    expect(service(0.42).select(projection(), 'huihui')).toEqual(
      service(0.42).select(projection(), 'huihui'),
    );
    expect(service(Number.NaN).select(projection(), 'huihui')).toEqual(
      service(Number.NaN).candidates(projection(), 'huihui')[0],
    );
  });

  it('includes return-home only for the player pet while it is in town', () => {
    expect(service().candidates(projection(), 'player')).toContainEqual({
      type: 'return-home',
      actorId: 'player',
    });
    expect(
      service()
        .candidates(projection(), 'huihui')
        .some(({ type }) => type === 'return-home'),
    ).toBe(false);
    const home = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'player'
          ? { ...resident, zoneId: 'gate' }
          : resident,
      ),
    });
    expect(
      service()
        .candidates(home, 'player')
        .some(({ type }) => type === 'return-home'),
    ).toBe(false);
  });

  it('filters candidates whose derived destination is inaccessible', () => {
    const restricted = new TownSimulationService(ports(), {
      accessibleZones: ['plaza'],
      activities: [
        { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
        { id: 'social-play', zoneId: 'arcade-house', capacity: 3 },
      ],
      recipes: ['stone-path'],
      buildPlots: ['plot-1'],
      publicShowcaseItemIds: () => ['item-1'],
    });
    const types = restricted
      .candidates(projection(), 'player')
      .map(({ type }) => type);
    expect(types).toContain('socialize');
    expect(types).not.toContain('start-activity');
    expect(types).not.toContain('build');
    expect(types).not.toContain('open-stall');
    expect(types).not.toContain('return-home');
  });
});

describe('TownSimulationService validation', () => {
  const cases: readonly [string, TownIntent, RegExp][] = [
    [
      'unknown actor',
      { type: 'visit-zone', actorId: 'missing', zoneId: 'plaza' },
      /resident not found/i,
    ],
    [
      'self socialize',
      { type: 'socialize', actorId: 'huihui', targetResidentId: 'huihui' },
      /itself|invalid/i,
    ],
    [
      'unknown target',
      { type: 'socialize', actorId: 'huihui', targetResidentId: 'missing' },
      /resident not found/i,
    ],
    [
      'inaccessible zone',
      { type: 'visit-zone', actorId: 'huihui', zoneId: 'garden' },
      /inaccessible/i,
    ],
    [
      'unknown activity',
      {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'unknown',
        invitedResidentIds: [],
      },
      /activity.*unavailable/i,
    ],
    [
      'unknown invitee',
      {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: ['missing'],
      },
      /resident not found/i,
    ],
    [
      'capacity',
      {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'fortune-draw',
        invitedResidentIds: ['player', 'reserved'],
      },
      /capacity/i,
    ],
    [
      'unknown recipe',
      {
        type: 'build',
        actorId: 'huihui',
        recipeId: 'unknown',
        plotId: 'plot-1',
      },
      /recipe/i,
    ],
    [
      'blocked plot',
      {
        type: 'build',
        actorId: 'huihui',
        recipeId: 'stone-path',
        plotId: 'blocked',
      },
      /plot/i,
    ],
    [
      'non-public item',
      {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: ['private'],
      },
      /public showcase/i,
    ],
    [
      'resident return home',
      { type: 'return-home', actorId: 'huihui' },
      /player pet/i,
    ],
  ];

  it.each(cases)('rejects %s', (_label, intent, message) => {
    const subject =
      _label === 'inaccessible zone'
        ? new TownSimulationService(ports(), { accessibleZones: ['plaza'] })
        : service();
    expect(() => subject.validateIntent(projection(), intent)).toThrow(message);
  });

  it('rejects duplicate invitees and showcase selections at the schema boundary', () => {
    expect(() =>
      service().validateIntent(projection(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: ['player', 'player'],
      }),
    ).toThrow();
    expect(() =>
      service().validateIntent(projection(), {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: [],
      }),
    ).toThrow();
    expect(() =>
      service().validateIntent(projection(), {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: ['item-1', 'item-2', 'item-3', 'item-4'],
      }),
    ).toThrow();
  });

  it('translates schema-invalid intents to a typed simulation error', () => {
    expect(() =>
      service().validateIntent(projection(), {
        type: 'socialize',
        actorId: 'huihui',
        targetResidentId: 'huihui',
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-intent' }));
  });

  it('rejects an actor included among invitees', () => {
    expect(() =>
      service().validateIntent(projection(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: ['huihui'],
      }),
    ).toThrow(/actor|invited/i);
  });

  it('rejects a disabled activity and a busy invitee', () => {
    const disabled = new TownSimulationService(ports(), {
      activities: [
        {
          id: 'social-play',
          zoneId: 'arcade-house',
          capacity: 3,
          enabled: false,
        },
      ],
    });
    expect(() =>
      disabled.validateIntent(projection(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: [],
      }),
    ).toThrow(/unavailable/i);

    const busy = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'reserved'
          ? { ...resident, availability: 'busy', activityInstanceId: 'busy-1' }
          : resident,
      ),
      activities: [
        {
          id: 'busy-1',
          activityId: 'social-play',
          zoneId: 'plaza',
          participantIds: ['reserved'],
          version: 0,
          state: {},
        },
      ],
    });
    expect(() =>
      service().validateIntent(busy, {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: ['reserved'],
      }),
    ).toThrow(/unavailable|busy/i);
  });

  it('rejects starting an activity whose live zone capacity is full', () => {
    const fullTown = projectionWithExistingActivity('full-play', 'social-play');
    const subject = new TownSimulationService(ports(), {
      activities: [{ id: 'social-play', zoneId: 'plaza', capacity: 1 }],
    });
    expect(() =>
      subject.validateIntent(fullTown, {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-intent' }));
  });

  it('rejects an already-home player return', () => {
    const home = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'player'
          ? { ...resident, zoneId: 'gate' }
          : resident,
      ),
    });
    expect(() =>
      service().validateIntent(home, {
        type: 'return-home',
        actorId: 'player',
      }),
    ).toThrow(/already home/i);
  });

  it.each<TownIntent>([
    { type: 'socialize', actorId: 'huihui', targetResidentId: 'player' },
    {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'fortune-draw',
      invitedResidentIds: [],
    },
    {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'social-play',
      invitedResidentIds: [],
    },
    {
      type: 'build',
      actorId: 'huihui',
      recipeId: 'stone-path',
      plotId: 'plot-1',
    },
    {
      type: 'open-stall',
      actorId: 'player',
      stallId: 'stall-1',
      showcaseItemIds: ['item-1'],
    },
    { type: 'return-home', actorId: 'player' },
  ])('rejects $type when its derived destination is inaccessible', (intent) => {
    const restricted = new TownSimulationService(ports(), {
      accessibleZones: ['garden'],
      activities: [
        { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
        { id: 'social-play', zoneId: 'arcade-house', capacity: 3 },
      ],
      recipes: ['stone-path'],
      buildPlots: ['plot-1'],
      publicShowcaseItemIds: () => ['item-1'],
    });
    expect(() => restricted.validateIntent(projection(), intent)).toThrow(
      /inaccessible/i,
    );
    expect(() => restricted.createEvents(projection(), intent)).toThrow(
      /inaccessible/i,
    );
  });

  it('rejects busy actors and targets', () => {
    const busy = TownProjectionSchema.parse({
      ...projection(),
      residents: projection().residents.map((resident) =>
        resident.residentId === 'reserved'
          ? { ...resident, availability: 'busy', activityInstanceId: 'busy-1' }
          : resident,
      ),
      activities: [
        {
          id: 'busy-1',
          activityId: 'social-play',
          zoneId: 'plaza',
          participantIds: ['reserved'],
          version: 0,
          state: {},
        },
      ],
    });
    expect(() =>
      service().validateIntent(busy, {
        type: 'visit-zone',
        actorId: 'reserved',
        zoneId: 'garden',
      }),
    ).toThrow(/unavailable|busy/i);
    expect(() =>
      service().validateIntent(busy, {
        type: 'socialize',
        actorId: 'huihui',
        targetResidentId: 'reserved',
      }),
    ).toThrow(/unavailable|busy/i);
  });

  it('returns a parsed clone without mutating projection or intent', () => {
    const input = projection();
    const intent = {
      type: 'visit-zone',
      actorId: 'huihui',
      zoneId: 'garden',
    } as const;
    const before = structuredClone(input);
    const result = service().validateIntent(input, intent);
    expect(result).toEqual(intent);
    expect(result).not.toBe(intent);
    expect(input).toEqual(before);
    expect(TownIntentSchema.parse(result)).toEqual(result);
  });
});

describe('TownSimulationService configuration boundaries', () => {
  it.each([
    ['non-array zones', { accessibleZones: 'plaza' }],
    ['duplicate zones', { accessibleZones: ['plaza', 'plaza'] }],
    ['non-array activities', { activities: 'social-play' }],
    [
      'too many activities',
      {
        activities: Array.from({ length: 17 }, (_, index) => ({
          id: `activity-${index}`,
          zoneId: 'plaza',
          capacity: 1,
        })),
      },
    ],
    [
      'duplicate activities',
      {
        activities: [
          { id: 'same', zoneId: 'plaza', capacity: 1 },
          { id: 'same', zoneId: 'garden', capacity: 1 },
        ],
      },
    ],
    [
      'invalid activity ID',
      { activities: [{ id: 'not valid', zoneId: 'plaza', capacity: 1 }] },
    ],
    [
      'invalid activity enabled flag',
      {
        activities: [
          { id: 'activity-1', zoneId: 'plaza', capacity: 1, enabled: 'yes' },
        ],
      },
    ],
    [
      'extra activity fields',
      {
        activities: [
          { id: 'activity-1', zoneId: 'plaza', capacity: 1, extra: true },
        ],
      },
    ],
    ['duplicate recipes', { recipes: ['stone-path', 'stone-path'] }],
    [
      'too many recipes',
      { recipes: Array.from({ length: 33 }, (_, index) => `recipe-${index}`) },
    ],
    ['duplicate plots', { buildPlots: ['plot-1', 'plot-1'] }],
    [
      'too many plots',
      { buildPlots: Array.from({ length: 33 }, (_, index) => `plot-${index}`) },
    ],
  ] as const)('rejects %s with a typed config error', (_label, options) => {
    expect(() => new TownSimulationService(ports(), options as never)).toThrow(
      expect.objectContaining({ code: 'invalid-config' }),
    );
  });

  it('validates bounded unique public showcase callback results', () => {
    const duplicate = new TownSimulationService(ports(), {
      publicShowcaseItemIds: () => ['item-1', 'item-1'],
    });
    expect(() => duplicate.candidates(projection(), 'player')).toThrow(
      expect.objectContaining({ code: 'invalid-config' }),
    );
    const oversized = new TownSimulationService(ports(), {
      publicShowcaseItemIds: () =>
        Array.from({ length: 13 }, (_, index) => `item-${index}`),
    });
    expect(() => oversized.candidates(projection(), 'player')).toThrow(
      expect.objectContaining({ code: 'invalid-config' }),
    );
  });

  it('passes deeply frozen projections to callbacks', () => {
    const frozenChecks: boolean[] = [];
    const subject = new TownSimulationService(ports(), {
      recipes: ['stone-path'],
      buildPlots: ['plot-1'],
      isBuildPlotAvailable: (_plotId, town) => {
        frozenChecks.push(
          Object.isFrozen(town),
          Object.isFrozen(town.residents),
          Object.isFrozen(town.residents[0]?.position),
        );
        expect(() =>
          (town.residents as TownProjection['residents']).push(
            town
              .residents[0]! as unknown as TownProjection['residents'][number],
          ),
        ).toThrow();
        return true;
      },
      publicShowcaseItemIds: (_actorId, town) => {
        frozenChecks.push(
          Object.isFrozen(town),
          Object.isFrozen(town.activities),
        );
        return ['item-1'];
      },
    });
    subject.candidates(projection(), 'player');
    expect(frozenChecks.every(Boolean)).toBe(true);
  });

  it('wraps invalid build-plot callback output and exceptions as config errors', () => {
    for (const isBuildPlotAvailable of [
      (() => 'yes') as never,
      (() => {
        throw new Error('secret callback detail');
      }) as never,
    ]) {
      const subject = new TownSimulationService(ports(), {
        recipes: ['stone-path'],
        buildPlots: ['plot-1'],
        isBuildPlotAvailable,
      });
      try {
        subject.validateIntent(projection(), {
          type: 'build',
          actorId: 'huihui',
          recipeId: 'stone-path',
          plotId: 'plot-1',
        });
        throw new Error('Expected callback rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(TownSimulationError);
        expect(error).toMatchObject({ code: 'invalid-config' });
        expect(String(error)).not.toContain('secret callback detail');
      }
    }
  });

  it('validates scoring context and passes it a frozen projection', () => {
    let frozen = false;
    const valid = new TownSimulationService(ports(), {
      contextForResident: (_residentId, town) => {
        frozen = Object.isFrozen(town) && Object.isFrozen(town.relationships);
        return { cooldownIntentTypes: [], outingDurationMs: 1 };
      },
    });
    valid.candidates(projection(), 'huihui');
    expect(frozen).toBe(true);

    for (const contextForResident of [
      () => ({ cooldownIntentTypes: ['build', 'build'], outingDurationMs: 0 }),
      () => ({ cooldownIntentTypes: [], outingDurationMs: -1 }),
      () => ({
        cooldownIntentTypes: [],
        outingDurationMs: Number.POSITIVE_INFINITY,
      }),
      () => ({ cooldownIntentTypes: [], outingDurationMs: 0, extra: true }),
    ]) {
      const invalid = new TownSimulationService(ports(), {
        contextForResident: contextForResident as never,
      });
      expect(() => invalid.candidates(projection(), 'huihui')).toThrow(
        expect.objectContaining({ code: 'invalid-config' }),
      );
    }
  });

  it('captures and copies option values against later mutation', () => {
    const zones = ['plaza', 'market'] as Array<'plaza' | 'market' | 'garden'>;
    const recipes = ['stone-path'];
    const plots = ['plot-1'];
    const options = {
      accessibleZones: zones,
      recipes,
      buildPlots: plots,
      publicShowcaseItemIds: () => ['item-1'],
    };
    const subject = new TownSimulationService(ports(), options);
    zones.push('garden');
    recipes.push('flower-patch');
    plots.push('plot-2');
    options.publicShowcaseItemIds = () => ['item-2'];

    expect(subject.candidates(projection(), 'player')).not.toContainEqual(
      expect.objectContaining({ type: 'visit-zone', zoneId: 'garden' }),
    );
    expect(subject.candidates(projection(), 'player')).toContainEqual(
      expect.objectContaining({
        type: 'open-stall',
        showcaseItemIds: ['item-1'],
      }),
    );
    expect(() =>
      subject.validateIntent(projection(), {
        type: 'build',
        actorId: 'player',
        recipeId: 'flower-patch',
        plotId: 'plot-2',
      }),
    ).toThrow();
  });
});

describe('TownSimulationService event creation', () => {
  it.each<TownIntent>([
    { type: 'socialize', actorId: 'huihui', targetResidentId: 'player' },
    { type: 'visit-zone', actorId: 'huihui', zoneId: 'garden' },
    {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'fortune-draw',
      invitedResidentIds: ['player'],
    },
    {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'social-play',
      invitedResidentIds: ['player'],
    },
    {
      type: 'build',
      actorId: 'huihui',
      recipeId: 'stone-path',
      plotId: 'plot-1',
    },
    {
      type: 'open-stall',
      actorId: 'player',
      stallId: 'stall-1',
      showcaseItemIds: ['item-1'],
    },
    { type: 'return-home', actorId: 'player' },
  ])(
    'creates schema-valid reducible events with postconditions for $type',
    (intent) => {
      const events = service().createEvents(projection(), intent);
      expect(events.length).toBeGreaterThanOrEqual(1);
      let current = projection();
      for (const generated of events) {
        expect(TownEventSchema.parse(generated)).toEqual(generated);
        expect(generated).toMatchObject({
          sessionId: 'session-1',
          timestamp: '2026-07-13T09:00:00.000Z',
        });
        current = reduceTownEvent(current, generated);
      }
      expect(current.version).toBe(events.length);
      switch (intent.type) {
        case 'socialize':
          expect(current.relationships).toEqual([]);
          break;
        case 'visit-zone':
          expect(
            current.residents.find(
              ({ residentId }) => residentId === intent.actorId,
            )?.zoneId,
          ).toBe(intent.zoneId);
          break;
        case 'start-activity':
          expect(
            current.activities.some(
              ({ activityId }) => activityId === intent.activityId,
            ),
          ).toBe(true);
          break;
        case 'build':
          expect(
            current.activities.some(
              ({ activityId }) => activityId === `build:${intent.recipeId}`,
            ),
          ).toBe(true);
          break;
        case 'open-stall':
          expect(
            current.activities.some(({ id }) => id === intent.stallId),
          ).toBe(true);
          break;
        case 'return-home':
          expect(
            current.residents.find(
              ({ residentId }) => residentId === intent.actorId,
            )?.zoneId,
          ).toBe('gate');
          break;
      }
    },
  );

  it('uses only injected IDs and time', () => {
    const events = service().createEvents(projection(), {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'fortune-draw',
      invitedResidentIds: ['player'],
    });
    expect(events[0]).toMatchObject({
      id: 'town-event-1',
      payload: { fortuneId: 'activity-1' },
      timestamp: '2026-07-13T09:00:00.000Z',
    });
  });

  it('creates an offset-correct move then activity-start chain for social play', () => {
    const events = service().createEvents(projection(), {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'social-play',
      invitedResidentIds: ['player'],
    });
    expect(
      events.map(({ type, sequence, baseVersion }) => ({
        type,
        sequence,
        baseVersion,
      })),
    ).toEqual([
      { type: 'resident.moved', sequence: 1, baseVersion: 0 },
      { type: 'activity.started', sequence: 2, baseVersion: 1 },
    ]);

    const final = events.reduce(
      (current, generated) => reduceTownEvent(current, generated),
      projection(),
    );
    expect(
      TownAdvanceResponseSchema.parse({ projection: final, events }),
    ).toBeDefined();
    expect(final.activities).toEqual([
      expect.objectContaining({
        id: 'activity-1',
        activityId: 'social-play',
        zoneId: 'arcade-house',
        participantIds: ['huihui', 'player'],
        version: 0,
        state: { schemaVersion: 'social-play.v1', phase: 'started' },
      }),
    ]);
    expect(
      final.residents.filter(({ residentId }) =>
        ['huihui', 'player'].includes(residentId),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          availability: 'busy',
          activityInstanceId: 'activity-1',
          zoneId: 'arcade-house',
        }),
        expect.objectContaining({
          availability: 'busy',
          activityInstanceId: 'activity-1',
          zoneId: 'arcade-house',
        }),
      ]),
    );
  });

  it.each([
    [
      'fortune-draw',
      {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'fortune-draw',
        invitedResidentIds: [],
      } as const,
    ],
    [
      'social-play',
      {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: [],
      } as const,
    ],
    [
      'build',
      {
        type: 'build',
        actorId: 'huihui',
        recipeId: 'stone-path',
        plotId: 'plot-1',
      } as const,
    ],
  ])('retries a colliding generated ID for %s', (_label, intent) => {
    let activityCalls = 0;
    let eventCalls = 0;
    const collisionPorts: TownSimulationPorts = {
      random: () => 0,
      now: () => '2026-07-13T09:00:00.000Z',
      nextId: (prefix) =>
        prefix === 'town-event'
          ? `event-${++eventCalls}`
          : ++activityCalls === 1
            ? 'activity-collision'
            : 'activity-fresh',
    };
    const events = new TownSimulationService(collisionPorts, {
      accessibleZones: [
        'plaza',
        'fortune-pavilion',
        'arcade-house',
        'build-plots',
      ],
      activities: [
        { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
        { id: 'social-play', zoneId: 'arcade-house', capacity: 2 },
      ],
      recipes: ['stone-path'],
      buildPlots: ['plot-1'],
    }).createEvents(
      projectionWithExistingActivity(),
      structuredClone(intent) as TownIntent,
    );
    expect(generatedActivityId(events)).toBe('activity-fresh');
  });

  it('rejects a caller stall ID collision and bounded generated-ID exhaustion', () => {
    expect(() =>
      service().createEvents(projectionWithExistingActivity('stall-1'), {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: ['item-1'],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-intent' }));

    const exhausted = new TownSimulationService(
      {
        random: () => 0,
        now: () => '2026-07-13T09:00:00.000Z',
        nextId: (prefix) =>
          prefix === 'activity' ? 'activity-collision' : 'event-1',
      },
      {
        activities: [
          { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
        ],
      },
    );
    try {
      exhausted.createEvents(projectionWithExistingActivity(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'fortune-draw',
        invitedResidentIds: [],
      });
      throw new Error('Expected ID exhaustion');
    } catch (error) {
      expect(error).toBeInstanceOf(TownSimulationError);
      expect(error).toMatchObject({ code: 'id-exhaustion' });
    }
  });

  it('rejects a caller stall ID that collides with a durable modification', () => {
    const modification = {
      id: 'stall-1',
      recipeId: 'stone-path',
      plotId: 'plot-1',
      occupiedCells: [{ x: 1, y: 1 }],
      atlasFrame: 1,
      collision: false,
    };
    const town = TownProjectionSchema.parse({
      ...projection(),
      modifications: [modification],
    });
    expect(() =>
      service().createEvents(town, {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: ['item-1'],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-intent' }));
  });

  it('retries duplicate and invalid event IDs within a two-event chain', () => {
    const eventIds = ['event-same', 'event-same', 'not valid', 'event-fresh'];
    const subject = new TownSimulationService(
      {
        random: () => 0,
        now: () => '2026-07-13T09:00:00.000Z',
        nextId: (prefix) =>
          prefix === 'activity'
            ? 'activity-1'
            : (eventIds.shift() ?? 'event-extra'),
      },
      {
        activities: [
          { id: 'social-play', zoneId: 'arcade-house', capacity: 2 },
        ],
      },
    );
    const events = subject.createEvents(projection(), {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'social-play',
      invitedResidentIds: [],
    });
    expect(events.map(({ id }) => id)).toEqual(['event-same', 'event-fresh']);
  });

  it('returns typed errors for event ID exhaustion and invalid generated timestamps', () => {
    const exhausted = new TownSimulationService(
      {
        random: () => 0,
        now: () => '2026-07-13T09:00:00.000Z',
        nextId: (prefix) =>
          prefix === 'activity' ? 'activity-1' : 'event-same',
      },
      {
        activities: [
          { id: 'social-play', zoneId: 'arcade-house', capacity: 2 },
        ],
      },
    );
    expect(() =>
      exhausted.createEvents(projection(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'id-exhausted' }));

    let timestamps = 0;
    const invalidTime = new TownSimulationService(
      {
        random: () => 0,
        now: () =>
          ++timestamps === 1 ? '2026-07-13T09:00:00.000Z' : 'not-a-time',
        nextId: (prefix) =>
          prefix === 'activity' ? 'activity-1' : `event-${timestamps + 1}`,
      },
      {
        activities: [
          { id: 'social-play', zoneId: 'arcade-house', capacity: 2 },
        ],
      },
    );
    expect(() =>
      invalidTime.createEvents(projection(), {
        type: 'start-activity',
        actorId: 'huihui',
        activityId: 'social-play',
        invitedResidentIds: [],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid-generated-event' }));
  });

  it('retries an invalid injected activity ID before creating an event', () => {
    let calls = 0;
    const subject = new TownSimulationService(
      {
        random: () => 0,
        now: () => '2026-07-13T09:00:00.000Z',
        nextId: (prefix) =>
          prefix === 'town-event'
            ? `event-${calls}`
            : ++calls === 1
              ? 'not valid'
              : 'activity-valid',
      },
      {
        activities: [
          { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 1 },
        ],
      },
    );
    const events = subject.createEvents(projection(), {
      type: 'start-activity',
      actorId: 'huihui',
      activityId: 'fortune-draw',
      invitedResidentIds: [],
    });
    expect(generatedActivityId(events)).toBe('activity-valid');
  });

  it('reduces a generated owner-only stall open followed by an external visit', () => {
    const openEvent = service().createEvents(projection(), {
      type: 'open-stall',
      actorId: 'player',
      stallId: 'stall-1',
      showcaseItemIds: ['item-1'],
    })[0]!;
    const opened = reduceTownEvent(projection(), openEvent);
    expect(opened.activities[0]?.participantIds).toEqual(['player']);

    const visitEvent = TownEventSchema.parse({
      id: 'external-visit-1',
      sessionId: opened.sessionId,
      sequence: opened.lastEventSequence + 1,
      baseVersion: opened.version,
      type: 'stall.visited',
      zoneId: 'market',
      participantIds: ['player', 'huihui'],
      timestamp: '2026-07-13T09:01:00.000Z',
      payload: { stallId: 'stall-1', visitorResidentId: 'huihui' },
    });
    const visited = reduceTownEvent(opened, visitEvent);

    expect(visited.activities[0]?.participantIds).toEqual(['player']);
    expect(visited.activities[0]?.state).toMatchObject({
      lastVisitorResidentId: 'huihui',
    });
    expect(
      visited.residents.find(({ residentId }) => residentId === 'huihui'),
    ).toMatchObject({
      availability: 'available',
      zoneId: 'plaza',
    });
  });
});
