import {
  TOWN_ENCOUNTER_PAIRS,
  TOWN_GRID,
  TOWN_STATIC_BLOCKED_CELLS,
  TOWN_ZONE_LAYOUT,
  TownEventSchema,
  TownProjectionSchema,
  TownPulseResponseSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  AutonomyEventBuilder,
  autonomyRelationshipDelta,
  type AutonomyEventBuilderPorts,
} from './autonomy-event-builder.js';
import { reduceTownEvent } from './event-reducer.js';
import { createAuthoredPetDefinitions } from './residents.js';

const timestamp = '2026-07-13T08:00:00.000Z';
const pets = createAuthoredPetDefinitions().slice(0, 3);

function projection(
  options: {
    affinity?: number;
    responderAvailability?: 'available' | 'busy';
    responderZoneId?: 'plaza' | 'garden';
  } = {},
): TownProjection {
  const responderAvailability = options.responderAvailability ?? 'available';
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 2,
    lastEventSequence: 4,
    residents: pets.map((pet, index) => ({
      residentId: pet.id,
      pet,
      position: { x: index + 7, y: 6 },
      zoneId: index === 1 ? (options.responderZoneId ?? 'plaza') : 'plaza',
      availability: index === 1 ? responderAvailability : 'available',
      ...(index === 1 && responderAvailability === 'busy'
        ? { activityInstanceId: 'busy-activity' }
        : {}),
    })),
    relationships:
      options.affinity === undefined
        ? []
        : [
            {
              residentIdA: pets[1]!.id,
              residentIdB: pets[0]!.id,
              affinity: options.affinity,
              sourceEventId: 'relationship-source',
              sourceVersion: 1,
            },
          ],
    modifications: [],
    activities:
      responderAvailability === 'busy'
        ? [
            {
              id: 'busy-activity',
              activityId: 'social-play',
              zoneId: 'plaza',
              participantIds: [pets[1]!.id],
              version: 0,
              state: {},
            },
          ]
        : [],
  });
}

function ports(overrides: Partial<AutonomyEventBuilderPorts> = {}) {
  let id = 0;
  const value: AutonomyEventBuilderPorts = {
    now: vi.fn(() => timestamp),
    nextId: vi.fn((prefix) => `${prefix}-${++id}`),
    ...overrides,
  };
  return value;
}

function replay(source: TownProjection, events: readonly TownEvent[]) {
  return events.reduce((state, event) => reduceTownEvent(state, event), source);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

describe('AutonomyEventBuilder', () => {
  it('builds and replays the exact deterministic encounter chain', () => {
    const source = deepFreeze(projection({ affinity: 0.4 }));
    const before = structuredClone(source);
    const eventPorts = ports();
    const events = new AutonomyEventBuilder(eventPorts).encounter(source, {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      opening: 'Want to play?',
      reply: 'Yes!',
      animation: 'happy',
    });

    expect(events.map(({ type }) => type)).toEqual([
      'resident.moved',
      'resident.moved',
      'resident.spoke',
      'resident.spoke',
      'residents.played',
      'relationship.changed',
    ]);
    expect(events.map(({ id }) => id)).toEqual(
      Array.from({ length: 6 }, (_, index) => `town-event-${index + 1}`),
    );
    expect(events.map(({ sequence }) => sequence)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(events.map(({ baseVersion }) => baseVersion)).toEqual([
      2, 3, 4, 5, 6, 7,
    ]);
    expect(events.every((event) => event.timestamp === timestamp)).toBe(true);
    expect(events.every((event) => event.zoneId === 'plaza')).toBe(true);
    expect(
      events.every(
        (event) =>
          event.participantIds.join(',') === `${pets[0]!.id},${pets[1]!.id}`,
      ),
    ).toBe(true);
    expect(events.slice(0, 2).map(({ payload }) => payload)).toEqual([
      { residentId: pets[0]!.id, position: TOWN_ENCOUNTER_PAIRS.plaza[0]![0] },
      { residentId: pets[1]!.id, position: TOWN_ENCOUNTER_PAIRS.plaza[0]![1] },
    ]);
    expect(events.slice(2, 4).map(({ payload }) => payload)).toEqual([
      { residentId: pets[0]!.id, text: 'Want to play?' },
      { residentId: pets[1]!.id, text: 'Yes!' },
    ]);
    expect(events[4]).toMatchObject({
      payload: { standalone: true, interactionId: 'town-event-5' },
    });
    expect(events[5]).toMatchObject({
      payload: {
        residentIdA: pets[0]!.id,
        residentIdB: pets[1]!.id,
        affinity: 0.45,
      },
    });
    for (const event of events)
      expect(TownEventSchema.parse(event)).toEqual(event);

    const finalProjection = replay(source, events);
    expect(finalProjection).toMatchObject({
      version: 8,
      lastEventSequence: 10,
    });
    expect(
      finalProjection.residents.slice(0, 2).map(({ position }) => position),
    ).toEqual(TOWN_ENCOUNTER_PAIRS.plaza[0]);
    expect(finalProjection.relationships[0]).toMatchObject({ affinity: 0.45 });
    expect(
      TownPulseResponseSchema.parse({
        status: 'advanced',
        projection: finalProjection,
        events,
        degraded: false,
        degradedResidentIds: [],
      }),
    ).toBeDefined();
    expect(source).toEqual(before);
    expect(eventPorts.nextId).toHaveBeenCalledTimes(6);
    expect(eventPorts.nextId).toHaveBeenCalledWith('town-event');
  });

  it('adds exactly one trimmed follow-up speech when it is nonempty', () => {
    const source = projection();
    const eventBuilder = new AutonomyEventBuilder(ports());
    const withFollowUp = eventBuilder.encounter(source, {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      opening: 'Hello',
      reply: 'Hi',
      followUp: '  One more thought.  ',
      animation: 'confused',
    });
    const withoutFollowUp = new AutonomyEventBuilder(ports()).encounter(
      source,
      {
        initiatorId: pets[0]!.id,
        responderId: pets[1]!.id,
        opening: 'Hello',
        reply: 'Hi',
        followUp: '   ',
        animation: 'confused',
      },
    );

    expect(
      withFollowUp.filter(({ type }) => type === 'resident.spoke'),
    ).toHaveLength(3);
    expect(withFollowUp[4]).toMatchObject({
      type: 'resident.spoke',
      payload: { residentId: pets[0]!.id, text: 'One more thought.' },
    });
    expect(withFollowUp.map(({ type }) => type)).toEqual([
      'resident.moved',
      'resident.moved',
      'resident.spoke',
      'resident.spoke',
      'resident.spoke',
      'residents.played',
    ]);
    expect(
      withoutFollowUp.filter(({ type }) => type === 'resident.spoke'),
    ).toHaveLength(2);
    expect(withoutFollowUp).toHaveLength(5);
  });

  it('visits a validated zone entrance with one actor-only moved event', () => {
    const source = deepFreeze(projection());
    const before = structuredClone(source);
    const events = new AutonomyEventBuilder(ports()).visit(source, {
      residentId: pets[0]!.id,
      zoneId: 'garden',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'town-event-1',
      sessionId: source.sessionId,
      sequence: 5,
      baseVersion: 2,
      type: 'resident.moved',
      zoneId: 'garden',
      participantIds: [pets[0]!.id],
      timestamp,
      payload: {
        residentId: pets[0]!.id,
        position: TOWN_ZONE_LAYOUT.garden.entrance,
      },
    });
    const finalProjection = replay(source, events);
    expect(finalProjection.residents[0]).toMatchObject({
      zoneId: 'garden',
      position: TOWN_ZONE_LAYOUT.garden.entrance,
    });
    expect(source).toEqual(before);
  });

  it('uses an explicit zone or otherwise derives it from the initiator', () => {
    const source = projection({ responderZoneId: 'garden' });
    const derived = new AutonomyEventBuilder(ports()).encounter(source, {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      opening: 'Meet here',
      reply: 'Coming',
      animation: 'curious',
    });
    const explicit = new AutonomyEventBuilder(ports()).encounter(source, {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      zoneId: 'garden',
      opening: 'Meet there',
      reply: 'Coming',
      animation: 'curious',
    });

    expect(derived.every(({ zoneId }) => zoneId === 'plaza')).toBe(true);
    expect(explicit.every(({ zoneId }) => zoneId === 'garden')).toBe(true);
    expect(
      replay(source, explicit)
        .residents.slice(0, 2)
        .map(({ zoneId }) => zoneId),
    ).toEqual(['garden', 'garden']);
  });

  it('uses a distinct, in-bounds, non-blocked first encounter pair', () => {
    const events = new AutonomyEventBuilder(ports()).encounter(projection(), {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      opening: 'Hello',
      reply: 'Hi',
      animation: 'sit',
    });
    const moved = events.slice(0, 2).map((event) => {
      if (event.type !== 'resident.moved') throw new Error('Expected movement');
      return event.payload.position;
    });
    const blocked = new Set(
      TOWN_STATIC_BLOCKED_CELLS.map(({ x, y }) => `${x}:${y}`),
    );

    expect(moved).toEqual(TOWN_ENCOUNTER_PAIRS.plaza[0]);
    expect(moved[0]).not.toEqual(moved[1]);
    for (const { x, y } of moved) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(TOWN_GRID.width);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThan(TOWN_GRID.height);
      expect(blocked.has(`${x}:${y}`)).toBe(false);
    }
  });

  it('emits an absolute stable affinity only when the deterministic delta is nonzero', () => {
    expect(autonomyRelationshipDelta(0.4, 'happy')).toBe(0.05);
    expect(autonomyRelationshipDelta(0.98, 'curious')).toBe(0.02);
    expect(autonomyRelationshipDelta(1, 'sit')).toBe(0);
    expect(autonomyRelationshipDelta(0.4, 'confused')).toBe(0);

    const capped = new AutonomyEventBuilder(ports()).encounter(
      projection({ affinity: 1 }),
      {
        initiatorId: pets[0]!.id,
        responderId: pets[1]!.id,
        opening: 'Hello',
        reply: 'Hi',
        animation: 'happy',
      },
    );
    const confused = new AutonomyEventBuilder(ports()).encounter(projection(), {
      initiatorId: pets[0]!.id,
      responderId: pets[1]!.id,
      opening: 'Hello',
      reply: 'Hi',
      animation: 'confused',
    });

    expect(capped.some(({ type }) => type === 'relationship.changed')).toBe(
      false,
    );
    expect(confused.some(({ type }) => type === 'relationship.changed')).toBe(
      false,
    );
    expect(capped.at(-1)?.type).toBe('residents.played');
  });

  it.each([
    ['unknown initiator', { initiatorId: 'missing' }, /unknown.*resident/i],
    ['unknown responder', { responderId: 'missing' }, /unknown.*resident/i],
    ['same resident', { responderId: pets[0]!.id }, /distinct/i],
    ['invalid zone', { zoneId: 'moon' }, /zone/i],
    ['empty opening', { opening: '   ' }, /opening|text/i],
    ['long opening', { opening: 'x'.repeat(81) }, /opening|80/i],
    ['empty reply', { reply: '' }, /reply|text/i],
    ['long reply', { reply: 'x'.repeat(81) }, /reply|80/i],
    ['long follow-up', { followUp: 'x'.repeat(81) }, /follow|80/i],
    ['invalid animation', { animation: 'dance' }, /animation/i],
  ])(
    'rejects %s encounter input before using ports',
    (_label, override, message) => {
      const eventPorts = ports();
      const input = {
        initiatorId: pets[0]!.id,
        responderId: pets[1]!.id,
        opening: 'Hello',
        reply: 'Hi',
        animation: 'happy',
        ...override,
      };

      expect(() =>
        new AutonomyEventBuilder(eventPorts).encounter(
          projection(),
          input as Parameters<AutonomyEventBuilder['encounter']>[1],
        ),
      ).toThrow(message);
      expect(eventPorts.now).not.toHaveBeenCalled();
      expect(eventPorts.nextId).not.toHaveBeenCalled();
    },
  );

  it('rejects busy encounter residents and invalid visit residents', () => {
    const eventBuilder = new AutonomyEventBuilder(ports());
    expect(() =>
      eventBuilder.encounter(projection({ responderAvailability: 'busy' }), {
        initiatorId: pets[0]!.id,
        responderId: pets[1]!.id,
        opening: 'Hello',
        reply: 'Hi',
        animation: 'happy',
      }),
    ).toThrow(/unavailable|busy/i);
    expect(() =>
      eventBuilder.visit(projection(), {
        residentId: 'missing',
        zoneId: 'garden',
      }),
    ).toThrow(/unknown.*resident/i);
    expect(() =>
      eventBuilder.visit(projection(), {
        residentId: pets[0]!.id,
        zoneId: 'moon' as 'garden',
      }),
    ).toThrow(/zone/i);
  });

  it('validates cloned projections and never repairs a mismatched session', () => {
    const invalid = {
      ...projection(),
      sessionId: '',
    } as TownProjection;
    expect(() =>
      new AutonomyEventBuilder(ports()).visit(invalid, {
        residentId: pets[0]!.id,
        zoneId: 'garden',
      }),
    ).toThrow(/session|validation|projection/i);
  });

  it('bounds duplicate ID retries and reports port failures clearly', () => {
    const duplicateId = vi.fn(() => 'duplicate-id');
    expect(() =>
      new AutonomyEventBuilder(ports({ nextId: duplicateId })).encounter(
        projection(),
        {
          initiatorId: pets[0]!.id,
          responderId: pets[1]!.id,
          opening: 'Hello',
          reply: 'Hi',
          animation: 'happy',
        },
      ),
    ).toThrow(/unique.*id|duplicate.*id/i);
    expect(duplicateId.mock.calls.length).toBeGreaterThan(1);
    expect(duplicateId.mock.calls.length).toBeLessThanOrEqual(10);

    expect(() =>
      new AutonomyEventBuilder(
        ports({
          nextId: () => {
            throw new Error('id source offline');
          },
        }),
      ).visit(projection(), { residentId: pets[0]!.id, zoneId: 'garden' }),
    ).toThrow(/event id.*id source offline/i);
    expect(() =>
      new AutonomyEventBuilder(
        ports({
          now: () => {
            throw new Error('clock offline');
          },
        }),
      ).visit(projection(), { residentId: pets[0]!.id, zoneId: 'garden' }),
    ).toThrow(/timestamp.*clock offline/i);
    expect(() =>
      new AutonomyEventBuilder(ports({ now: () => 'not-a-time' })).visit(
        projection(),
        { residentId: pets[0]!.id, zoneId: 'garden' },
      ),
    ).toThrow(/timestamp/i);
  });
});
