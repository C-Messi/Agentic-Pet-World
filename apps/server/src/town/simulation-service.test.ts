import {
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
    'creates schema-valid, sequential, reducible events for $type',
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
});
