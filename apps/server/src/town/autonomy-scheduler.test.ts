import {
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  residentCooldownMs,
  selectAutonomousResidents,
} from './autonomy-scheduler.js';
import { createAuthoredPetDefinitions } from './residents.js';

const NOW = Date.parse('2026-07-13T09:01:00.000Z');
const residentDefinitions = createAuthoredPetDefinitions();
const residentIds = residentDefinitions.map(({ id }) => id);

let eventSequence = 1;

function projection(): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 0,
    lastEventSequence: 0,
    residents: residentDefinitions.map((pet, index) => ({
      residentId: pet.id,
      pet,
      position: { x: index, y: 0 },
      zoneId: 'plaza',
      availability: 'available',
    })),
    relationships: [],
    modifications: [],
    activities: [],
  });
}

function event(
  type: 'resident.moved' | 'resident.spoke' | 'residents.played',
  ids: readonly string[],
  timestamp: string,
): TownEvent {
  const sequence = eventSequence++;
  const payload =
    type === 'resident.moved'
      ? { residentId: ids[0], position: { x: sequence, y: 0 } }
      : type === 'resident.spoke'
        ? { residentId: ids[0], text: `decision ${sequence}` }
        : { activityInstanceId: `activity-${sequence}` };

  return TownEventSchema.parse({
    id: `event-${sequence}`,
    sessionId: 'session-1',
    sequence,
    baseVersion: sequence - 1,
    type,
    zoneId: 'plaza',
    participantIds: ids,
    timestamp,
    payload,
  });
}

function eventsFor(
  ids: readonly string[],
  timestamp = '2026-07-13T09:00:55.000Z',
): TownEvent[] {
  return ids.map((id) => event('resident.spoke', [id], timestamp));
}

function unrelatedEvent(
  type: 'fortune.started' | 'build.started' | 'stall.closed',
  timestamp: string,
): TownEvent {
  const sequence = eventSequence++;
  const payload =
    type === 'fortune.started'
      ? { activityInstanceId: `fortune-${sequence}` }
      : type === 'build.started'
        ? {
            modificationId: `modification-${sequence}`,
            recipeId: 'bench',
            plotId: 'plot-1',
          }
        : { stallId: `stall-${sequence}` };

  return TownEventSchema.parse({
    id: `event-${sequence}`,
    sessionId: 'session-1',
    sequence,
    baseVersion: sequence - 1,
    type,
    zoneId: 'plaza',
    participantIds: ['player-cat'],
    timestamp,
    payload,
  });
}

function withBusyResident(
  source: TownProjection,
  busyResidentId: string,
): TownProjection {
  const activityId = `busy-${busyResidentId}`;
  return TownProjectionSchema.parse({
    ...source,
    residents: source.residents.map((resident) =>
      resident.residentId === busyResidentId
        ? {
            ...resident,
            availability: 'busy',
            activityInstanceId: activityId,
          }
        : resident,
    ),
    activities: [
      {
        id: activityId,
        activityId: 'social-play',
        zoneId: 'plaza',
        participantIds: [busyResidentId],
        version: 0,
        state: {},
      },
    ],
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

describe('residentCooldownMs', () => {
  it('returns the stable bounded FNV cooldown for every authored resident', () => {
    expect(residentIds.map((id) => [id, residentCooldownMs(id)])).toEqual([
      ['player-cat', 25_531],
      ['resident-mikan', 24_866],
      ['resident-huihui', 15_094],
      ['resident-lanlan', 22_811],
      ['resident-doubao', 20_419],
    ]);

    for (const id of residentIds) {
      expect(residentCooldownMs(id)).toBe(residentCooldownMs(id));
      expect(residentCooldownMs(id)).toBeGreaterThanOrEqual(12_000);
      expect(residentCooldownMs(id)).toBeLessThanOrEqual(30_000);
    }
  });

  it('rejects invalid resident identifiers', () => {
    expect(() => residentCooldownMs('invalid id')).toThrow();
    expect(() => residentCooldownMs('')).toThrow();
  });
});

describe('selectAutonomousResidents', () => {
  it('selects never-decided residents in stable projection order', () => {
    expect(
      selectAutonomousResidents({
        projection: projection(),
        recentEvents: eventsFor(['resident-mikan']),
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['player-cat', 'resident-huihui']);
  });

  it('does not repeat an eligible resident before every resident gets a turn', () => {
    const state = projection();
    const first = selectAutonomousResidents({
      projection: state,
      recentEvents: [],
      nowMs: Date.parse('2026-07-13T09:00:00.000Z'),
      limit: 2,
    });
    const firstEvents = eventsFor(first, '2026-07-13T09:00:00.000Z');
    const second = selectAutonomousResidents({
      projection: state,
      recentEvents: firstEvents,
      nowMs: Date.parse('2026-07-13T09:00:31.000Z'),
      limit: 2,
    });
    const third = selectAutonomousResidents({
      projection: state,
      recentEvents: [
        ...firstEvents,
        ...eventsFor(second, '2026-07-13T09:00:31.000Z'),
      ],
      nowMs: Date.parse('2026-07-13T09:01:02.000Z'),
      limit: 1,
    });

    expect(first).toEqual(['player-cat', 'resident-mikan']);
    expect(second).toEqual(['resident-huihui', 'resident-lanlan']);
    expect(third).toEqual(['resident-doubao']);
    expect(new Set([...first, ...second, ...third]).size).toBe(5);
  });

  it('sorts decided residents by oldest decision and breaks ties by projection order', () => {
    const recentEvents = [
      ...eventsFor(
        ['resident-huihui', 'resident-lanlan'],
        '2026-07-13T08:59:20.000Z',
      ),
      ...eventsFor(['player-cat'], '2026-07-13T08:59:30.000Z'),
      ...eventsFor(
        ['resident-mikan', 'resident-doubao'],
        '2026-07-13T08:59:40.000Z',
      ),
    ];

    expect(
      selectAutonomousResidents({
        projection: projection(),
        recentEvents,
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['resident-huihui', 'resident-lanlan']);
  });

  it('uses only moved, spoke, and played events for decision cooldowns', () => {
    const recentEvents = [
      event('resident.moved', ['resident-mikan'], '2026-07-13T09:00:50.000Z'),
      event('resident.spoke', ['resident-huihui'], '2026-07-13T09:00:51.000Z'),
      event(
        'residents.played',
        ['resident-lanlan', 'resident-doubao'],
        '2026-07-13T09:00:52.000Z',
      ),
      unrelatedEvent('fortune.started', '2026-07-13T09:00:57.000Z'),
      unrelatedEvent('build.started', '2026-07-13T09:00:58.000Z'),
      unrelatedEvent('stall.closed', '2026-07-13T09:00:59.000Z'),
    ];

    expect(
      selectAutonomousResidents({
        projection: projection(),
        recentEvents,
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['player-cat']);
  });

  it('puts every participant of a resident decision event on cooldown', () => {
    const sharedDecision = event(
      'resident.spoke',
      ['resident-mikan', 'resident-huihui'],
      '2026-07-13T09:00:55.000Z',
    );

    expect(
      selectAutonomousResidents({
        projection: projection(),
        recentEvents: [sharedDecision],
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['player-cat', 'resident-lanlan']);
  });

  it('uses the maximum timestamp for participants when events are unordered', () => {
    const fullState = projection();
    const state = TownProjectionSchema.parse({
      ...fullState,
      residents: fullState.residents.filter(({ residentId }) =>
        ['player-cat', 'resident-mikan', 'resident-huihui'].includes(
          residentId,
        ),
      ),
    });
    const recentEvents = [
      event(
        'resident.spoke',
        ['resident-mikan', 'resident-huihui'],
        '2026-07-13T09:00:59.000Z',
      ),
      event(
        'resident.moved',
        ['resident-mikan', 'resident-huihui'],
        '2026-07-13T08:00:00.000Z',
      ),
    ];

    expect(
      selectAutonomousResidents({
        projection: state,
        recentEvents,
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['player-cat']);
  });

  it('excludes busy residents and residents still on cooldown', () => {
    expect(
      selectAutonomousResidents({
        projection: withBusyResident(projection(), 'resident-mikan'),
        recentEvents: eventsFor(['player-cat']),
        nowMs: NOW,
        limit: 2,
      }),
    ).toEqual(['resident-huihui', 'resident-lanlan']);
  });

  it('treats future decisions as cooling down and includes the exact boundary', () => {
    const fullState = projection();
    const state = TownProjectionSchema.parse({
      ...fullState,
      residents: fullState.residents.filter(({ residentId }) =>
        ['player-cat', 'resident-mikan'].includes(residentId),
      ),
    });
    const decidedAt = Date.parse('2026-07-13T09:00:00.000Z');
    const baseEvents = [
      event(
        'resident.spoke',
        ['resident-mikan'],
        new Date(decidedAt).toISOString(),
      ),
      event('resident.spoke', ['player-cat'], '2026-07-14T09:00:00.000Z'),
    ];

    expect(
      selectAutonomousResidents({
        projection: state,
        recentEvents: baseEvents,
        nowMs: decidedAt - 1,
        limit: 2,
      }),
    ).not.toContain('resident-mikan');
    expect(
      selectAutonomousResidents({
        projection: state,
        recentEvents: baseEvents,
        nowMs: decidedAt + residentCooldownMs('resident-mikan') - 1,
        limit: 2,
      }),
    ).not.toContain('resident-mikan');
    expect(
      selectAutonomousResidents({
        projection: state,
        recentEvents: baseEvents,
        nowMs: decidedAt + residentCooldownMs('resident-mikan'),
        limit: 2,
      }),
    ).toContain('resident-mikan');
    expect(
      selectAutonomousResidents({
        projection: state,
        recentEvents: baseEvents,
        nowMs: decidedAt + residentCooldownMs('resident-mikan') + 1,
        limit: 2,
      }),
    ).toContain('resident-mikan');
  });

  it.each([0, 3, Number.NaN, 1.5])('rejects invalid limit %s', (limit) => {
    expect(() =>
      selectAutonomousResidents({
        projection: projection(),
        recentEvents: [],
        nowMs: NOW,
        limit,
      }),
    ).toThrow();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, NOW + 0.5])(
    'rejects invalid nowMs %s',
    (nowMs) => {
      expect(() =>
        selectAutonomousResidents({
          projection: projection(),
          recentEvents: [],
          nowMs,
          limit: 1,
        }),
      ).toThrow();
    },
  );

  it('rejects unknown or corrupt projection and event data', () => {
    const state = projection();
    expect(() =>
      selectAutonomousResidents({
        projection: { ...state, privateState: 'secret' } as TownProjection,
        recentEvents: [],
        nowMs: NOW,
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      selectAutonomousResidents({
        projection: {
          ...state,
          residents: state.residents.map((resident) =>
            resident.residentId === 'resident-mikan'
              ? { ...resident, availability: 'busy' }
              : resident,
          ),
        } as TownProjection,
        recentEvents: [],
        nowMs: NOW,
        limit: 1,
      }),
    ).toThrow();
    expect(() =>
      selectAutonomousResidents({
        projection: state,
        recentEvents: [{ type: 'resident.hacked' }] as unknown as TownEvent[],
        nowMs: NOW,
        limit: 1,
      }),
    ).toThrow();
  });

  it('rejects a schema-valid event from another session', () => {
    const foreignEvent = TownEventSchema.parse({
      ...event(
        'resident.spoke',
        ['resident-mikan'],
        '2026-07-13T09:00:59.000Z',
      ),
      sessionId: 'session-2',
    });

    expect(() =>
      selectAutonomousResidents({
        projection: projection(),
        recentEvents: [foreignEvent],
        nowMs: NOW,
        limit: 2,
      }),
    ).toThrow(/session/i);
  });

  it('does not mutate frozen inputs and returns a fresh readonly array', () => {
    const state = deepFreeze(projection());
    const recentEvents = deepFreeze(eventsFor(['resident-mikan']));
    const stateBefore = structuredClone(state);
    const eventsBefore = structuredClone(recentEvents);
    const input = deepFreeze({
      projection: state,
      recentEvents,
      nowMs: NOW,
      limit: 2,
    });

    const first = selectAutonomousResidents(input);
    const second = selectAutonomousResidents(input);

    expect(state).toEqual(stateBefore);
    expect(recentEvents).toEqual(eventsBefore);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
  });
});
