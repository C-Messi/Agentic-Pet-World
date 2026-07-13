import { TownEventSchema, type TownEvent } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActivityRegistryError,
  TownActivityRegistry,
  type ActivityContext,
  type EmittedActivityResult,
  type TownActivityDefinition,
} from './activity-registry.js';

const StateSchema = z
  .object({ count: z.number().int().nonnegative() })
  .strict();
const ToolSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('increment') }).strict(),
]);

type State = z.infer<typeof StateSchema>;
type Tool = z.infer<typeof ToolSchema>;

function context(overrides: Partial<ActivityContext> = {}): ActivityContext {
  let eventNumber = 0;
  return {
    sessionId: 'session-1',
    activityInstanceId: 'activity-1',
    baseVersion: 4,
    lastEventSequence: 8,
    participantIds: ['resident-1'],
    zoneId: 'plaza',
    now: '2026-07-13T10:00:00.000Z',
    emittedResults: [],
    nextEventId: () => `event-${++eventNumber}`,
    ...overrides,
  };
}

function emittedResult(
  overrides: Partial<EmittedActivityResult> = {},
): EmittedActivityResult {
  return {
    activityInstanceId: 'activity-1',
    eventType: 'stall.opened',
    factKey: 'stall-opened',
    eventId: 'persisted-event-1',
    ...overrides,
  };
}

function definition(
  overrides: Partial<TownActivityDefinition<State, Tool>> = {},
): TownActivityDefinition<State, Tool> {
  return {
    id: 'counter',
    zoneId: 'plaza',
    capacity: 2,
    resultEventTypes: ['residents.played'],
    stateSchema: StateSchema,
    toolSchema: ToolSchema,
    createInitialState: () => ({ count: 0 }),
    transition: (state) => ({ count: state.count + 1 }),
    resultEvents: (_state, activityContext) => [
      TownEventSchema.parse({
        id: activityContext.nextEventId(),
        sessionId: activityContext.sessionId,
        sequence: activityContext.lastEventSequence + 1,
        baseVersion: activityContext.baseVersion,
        type: 'residents.played',
        zoneId: activityContext.zoneId,
        participantIds: activityContext.participantIds,
        timestamp: activityContext.now,
        payload: { activityInstanceId: activityContext.activityInstanceId },
      }),
    ],
    validateResultEvent: (event, _state, activityContext) =>
      event.type === 'residents.played' &&
      event.payload.activityInstanceId === activityContext.activityInstanceId &&
      event.zoneId === activityContext.zoneId &&
      event.participantIds.length === activityContext.participantIds.length &&
      event.participantIds.every((id) =>
        activityContext.participantIds.includes(id),
      ),
    ...overrides,
  };
}

describe('TownActivityRegistry definitions', () => {
  it('registers definitions and exposes frozen metadata in registration order', () => {
    const registry = new TownActivityRegistry();
    const source = definition();
    registry.register(source);

    source.id = 'mutated';
    source.capacity = 4;

    expect(registry.get('counter')).toMatchObject({
      id: 'counter',
      zoneId: 'plaza',
      capacity: 2,
      resultEventTypes: ['residents.played'],
    });
    expect(registry.require('counter').id).toBe('counter');
    expect(registry.list()).toEqual([
      {
        id: 'counter',
        zoneId: 'plaza',
        capacity: 2,
        resultEventTypes: ['residents.played'],
      },
    ]);
    expect(Object.isFrozen(registry.get('counter'))).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
  });

  it.each([
    ['bad id!', 'invalid-definition'],
    ['counter', 'invalid-definition'],
  ] as const)('rejects invalid definitions (%s)', (id, code) => {
    const registry = new TownActivityRegistry();
    expect(() =>
      registry.register(definition({ id, capacity: 0 })),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects duplicate activity IDs and duplicate zone ownership', () => {
    const registry = new TownActivityRegistry();
    registry.register(definition());

    expect(() => registry.register(definition())).toThrowError(
      expect.objectContaining({ code: 'duplicate-activity' }),
    );
    expect(() =>
      registry.register(definition({ id: 'other-counter' })),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-zone' }));
  });

  it('returns undefined from get and a stable typed error from require', () => {
    const registry = new TownActivityRegistry();
    expect(registry.get('missing')).toBeUndefined();
    expect(() => registry.require('missing')).toThrowError(
      expect.objectContaining({
        name: 'ActivityRegistryError',
        code: 'unknown-activity',
      }),
    );
  });

  it('wraps a throwing definition schema getter in a typed definition error', () => {
    const source = definition();
    Object.defineProperty(source, 'stateSchema', {
      get: () => {
        throw new TypeError('schema getter failed');
      },
    });

    expect(() => new TownActivityRegistry().register(source)).toThrowError(
      expect.objectContaining({ code: 'invalid-definition' }),
    );
  });
});

describe('TownActivityRegistry execution boundary', () => {
  it('validates and freezes initial and transitioned state', () => {
    const registry = new TownActivityRegistry().register(definition());
    const initial = registry.createInitialState('counter', context());
    const transitioned = registry.transition(
      'counter',
      initial,
      { type: 'increment' },
      context(),
    );

    expect(initial).toEqual({ count: 0 });
    expect(transitioned).toEqual({ count: 1 });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(transitioned)).toBe(true);
  });

  it('rejects invalid initial and transition output with stable codes', () => {
    const badInitial = new TownActivityRegistry().register(
      definition({ createInitialState: () => ({ count: -1 }) }),
    );
    expect(() =>
      badInitial.createInitialState('counter', context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-transition' }));

    const badOutput = new TownActivityRegistry().register(
      definition({ transition: () => ({ count: -1 }) }),
    );
    expect(() =>
      badOutput.transition(
        'counter',
        { count: 0 },
        { type: 'increment' },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-transition' }));
  });

  it('rejects unknown, malformed, and extra tool fields before transition', () => {
    let calls = 0;
    const registry = new TownActivityRegistry().register(
      definition({
        transition: (state) => {
          calls += 1;
          return state;
        },
      }),
    );

    for (const tool of [
      { type: 'missing' },
      { type: 'increment', extra: true },
      'increment',
    ]) {
      expect(() =>
        registry.transition('counter', { count: 0 }, tool, context()),
      ).toThrowError(expect.objectContaining({ code: 'invalid-tool' }));
    }
    expect(calls).toBe(0);
  });

  it.each([
    context({ participantIds: ['resident-1', 'resident-2', 'resident-3'] }),
    context({ participantIds: ['resident-1', 'resident-1'] }),
    context({ zoneId: 'garden' }),
    context({ now: 'today' }),
    context({
      emittedResults: [
        emittedResult(),
        emittedResult({ eventId: 'persisted-event-2' }),
      ],
    }),
    context({
      emittedResults: [
        emittedResult(),
        emittedResult({ factKey: 'other-fact' }),
      ],
    }),
    context({
      emittedResults: [emittedResult({ activityInstanceId: 'other-activity' })],
    }),
    context({
      emittedResults: [
        emittedResult({ eventType: 'not.an-event' as 'stall.opened' }),
      ],
    }),
  ])('rejects invalid activity context (%s)', (value) => {
    const registry = new TownActivityRegistry().register(definition());
    expect(() => registry.createInitialState('counter', value)).toThrowError(
      expect.objectContaining({ code: 'invalid-context' }),
    );
  });

  it('keeps persisted results domain-neutral and deeply frozen', () => {
    let received: ActivityContext | undefined;
    const registry = new TownActivityRegistry().register(
      definition({
        createInitialState: (activityContext) => {
          received = activityContext;
          return { count: 0 };
        },
      }),
    );

    registry.createInitialState(
      'counter',
      context({
        emittedResults: [
          emittedResult(),
          emittedResult({
            factKey: 'stall-opened-again',
            eventId: 'persisted-event-2',
          }),
        ],
      }),
    );

    expect(received?.emittedResults).toHaveLength(2);
    expect(Object.isFrozen(received?.emittedResults)).toBe(true);
    expect(Object.isFrozen(received?.emittedResults[0])).toBe(true);
  });

  it.each([
    null,
    { ...context(), participantIds: null },
    { ...context(), participantIds: 'resident-1' },
    { ...context(), emittedResults: null },
    { ...context(), emittedResults: {} },
    { ...context(), nextEventId: null },
    { ...context(), nextEventId: 'event-1' },
  ])('translates malformed raw context to a typed error: %s', (raw) => {
    const registry = new TownActivityRegistry().register(definition());
    expect(() =>
      registry.createInitialState('counter', raw as ActivityContext),
    ).toThrowError(expect.objectContaining({ code: 'invalid-context' }));
  });

  it('translates a throwing context getter to a typed error', () => {
    const registry = new TownActivityRegistry().register(definition());
    const raw = context() as ActivityContext & Record<string, unknown>;
    Object.defineProperty(raw, 'participantIds', {
      get: () => {
        throw new TypeError('participant getter failed');
      },
    });

    expect(() => registry.createInitialState('counter', raw)).toThrowError(
      expect.objectContaining({ code: 'invalid-context' }),
    );
  });

  it('captures and freezes the context cursor and callback', () => {
    let received: ActivityContext | undefined;
    const registry = new TownActivityRegistry().register(
      definition({
        createInitialState: (activityContext) => {
          received = activityContext;
          return { count: 0 };
        },
      }),
    );
    const source = context({ emittedResults: [emittedResult()] });
    const callback = source.nextEventId;

    registry.createInitialState('counter', source);
    source.emittedResults = [];
    source.nextEventId = () => 'changed-event';

    expect(received?.emittedResults).toEqual([emittedResult()]);
    expect(received?.nextEventId).not.toBe(callback);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.emittedResults)).toBe(true);
    expect(Object.isFrozen(received?.nextEventId)).toBe(true);
    expect(received?.nextEventId()).toBe('event-1');
  });

  it('isolates definition input and state input from implementation mutation', () => {
    const source = definition({
      transition: (state) => {
        (state as State).count = 99;
        return { count: 1 };
      },
    });
    const registry = new TownActivityRegistry().register(source);
    const state = { count: 0 };

    expect(() =>
      registry.transition('counter', state, { type: 'increment' }, context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-transition' }));
    expect(state).toEqual({ count: 0 });
  });

  it('wraps non-cloneable state and tool values in stable typed errors', () => {
    const registry = new TownActivityRegistry().register(definition());
    expect(() =>
      registry.transition(
        'counter',
        { count: 0, callback: () => undefined },
        { type: 'increment' },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-transition' }));
    expect(() =>
      registry.transition(
        'counter',
        { count: 0 },
        { type: 'increment', marker: Symbol('marker') },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-tool' }));
  });

  it('validates result events and their session, zone, participants, version, and sequence', () => {
    const valid = new TownActivityRegistry().register(definition());
    expect(valid.resultEvents('counter', { count: 0 }, context())).toHaveLength(
      1,
    );

    const mismatches = [
      { sessionId: 'other-session' },
      { zoneId: 'garden' },
      { participantIds: ['resident-2'] },
      { baseVersion: 5 },
      { sequence: 10 },
      { payload: { activityInstanceId: 'other-activity' } },
    ];
    for (const mismatch of mismatches) {
      const registry = new TownActivityRegistry().register(
        definition({
          resultEvents: (state, activityContext) => {
            const [event] = definition().resultEvents(state, activityContext);
            return [{ ...event!, ...mismatch } as TownEvent];
          },
        }),
      );
      expect(() =>
        registry.resultEvents('counter', { count: 0 }, context()),
      ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    }
  });

  it('requires contiguous versions and sequences across multiple result events', () => {
    const registry = new TownActivityRegistry().register(
      definition({
        resultEvents: (state, activityContext) => {
          const [first] = definition().resultEvents(state, activityContext);
          return [
            first!,
            { ...first!, id: 'event-2', sequence: 11, baseVersion: 5 },
          ];
        },
      }),
    );

    expect(() =>
      registry.resultEvents('counter', { count: 0 }, context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });

  it('delegates external stall visitor ownership to the definition validator', () => {
    const stallDefinition = (
      eventOverrides: Record<string, unknown> = {},
      payloadOverrides: Record<string, unknown> = {},
    ) =>
      definition({
        capacity: 1,
        resultEventTypes: ['stall.visited'],
        resultEvents: (_state, activityContext) => [
          TownEventSchema.parse({
            id: activityContext.nextEventId(),
            sessionId: activityContext.sessionId,
            sequence: activityContext.lastEventSequence + 1,
            baseVersion: activityContext.baseVersion,
            type: 'stall.visited',
            zoneId: activityContext.zoneId,
            participantIds: ['resident-1', 'resident-2'],
            timestamp: activityContext.now,
            ...eventOverrides,
            payload: {
              stallId: activityContext.activityInstanceId,
              visitorResidentId: 'resident-2',
              ...payloadOverrides,
            },
          }),
        ],
        validateResultEvent: (event, _state, activityContext) =>
          event.type === 'stall.visited' &&
          event.zoneId === activityContext.zoneId &&
          event.payload.stallId === activityContext.activityInstanceId &&
          event.payload.visitorResidentId === 'resident-2' &&
          event.participantIds.includes(activityContext.participantIds[0]!) &&
          event.participantIds.includes(event.payload.visitorResidentId),
      });

    expect(
      new TownActivityRegistry()
        .register(stallDefinition())
        .resultEvents('counter', { count: 0 }, context()),
    ).toHaveLength(1);

    for (const invalid of [
      stallDefinition({ participantIds: ['resident-3', 'resident-2'] }),
      stallDefinition(
        { participantIds: ['resident-1', 'resident-3'] },
        { visitorResidentId: 'resident-3' },
      ),
      stallDefinition({}, { stallId: 'other-stall' }),
      stallDefinition({ zoneId: 'garden' }),
    ]) {
      expect(() =>
        new TownActivityRegistry()
          .register(invalid)
          .resultEvents('counter', { count: 0 }, context()),
      ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    }
  });

  it('rejects undeclared result types and wraps ownership validator failures', () => {
    const undeclared = new TownActivityRegistry().register(
      definition({ resultEventTypes: ['stall.opened'] }),
    );
    expect(() =>
      undeclared.resultEvents('counter', { count: 0 }, context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));

    const throwing = new TownActivityRegistry().register(
      definition({
        validateResultEvent: () => {
          throw new Error('validator failed');
        },
      }),
    );
    expect(() =>
      throwing.resultEvents('counter', { count: 0 }, context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });

  it('requires a result ownership validator at runtime', () => {
    expect(() =>
      new TownActivityRegistry().register(
        definition({ validateResultEvent: undefined as never }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-definition' }));
  });

  it('exports the registry error as an Error subtype', () => {
    const error = new ActivityRegistryError('invalid-tool', 'bad tool');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('invalid-tool');
  });
});
