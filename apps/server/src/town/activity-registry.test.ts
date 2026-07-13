import { TownEventSchema, type TownEvent } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ActivityRegistryError,
  TownActivityRegistry,
  type ActivityContext,
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
    emittedEventTypes: [],
    nextEventId: () => `event-${++eventNumber}`,
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
    });
    expect(registry.require('counter').id).toBe('counter');
    expect(registry.list()).toEqual([
      { id: 'counter', zoneId: 'plaza', capacity: 2 },
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
    context({ emittedEventTypes: ['fortune.revealed', 'fortune.revealed'] }),
    context({ emittedEventTypes: ['not.an-event' as 'fortune.revealed'] }),
  ])('rejects invalid activity context (%s)', (value) => {
    const registry = new TownActivityRegistry().register(definition());
    expect(() => registry.createInitialState('counter', value)).toThrowError(
      expect.objectContaining({ code: 'invalid-context' }),
    );
  });

  it('keeps the emission cursor domain-neutral for other activities', () => {
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
      context({ emittedEventTypes: ['stall.opened'] }),
    );

    expect(received?.emittedEventTypes).toEqual(['stall.opened']);
    expect(Object.isFrozen(received?.emittedEventTypes)).toBe(true);
  });

  it.each([
    null,
    { ...context(), participantIds: null },
    { ...context(), participantIds: 'resident-1' },
    { ...context(), emittedEventTypes: null },
    { ...context(), emittedEventTypes: {} },
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
    const source = context({
      emittedEventTypes: ['stall.opened', 'resident.spoke'],
    });
    const callback = source.nextEventId;

    registry.createInitialState('counter', source);
    source.emittedEventTypes = [];
    source.nextEventId = () => 'changed-event';

    expect(received?.emittedEventTypes).toEqual([
      'stall.opened',
      'resident.spoke',
    ]);
    expect(received?.nextEventId).not.toBe(callback);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.emittedEventTypes)).toBe(true);
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

  it('validates fortune lifecycle events by activity instance ID', () => {
    const registry = new TownActivityRegistry().register(
      definition({
        resultEvents: (_state, activityContext) => [
          TownEventSchema.parse({
            id: activityContext.nextEventId(),
            sessionId: activityContext.sessionId,
            sequence: activityContext.lastEventSequence + 1,
            baseVersion: activityContext.baseVersion,
            type: 'fortune.revealed',
            zoneId: activityContext.zoneId,
            participantIds: activityContext.participantIds,
            timestamp: activityContext.now,
            payload: {
              activityInstanceId: activityContext.activityInstanceId,
              fortuneId: 'selected-fortune',
              rank: 'good',
            },
          }),
        ],
      }),
    );

    expect(
      registry.resultEvents('counter', { count: 0 }, context()),
    ).toHaveLength(1);
    const mismatched = new TownActivityRegistry().register(
      definition({
        resultEvents: (_state, activityContext) => [
          TownEventSchema.parse({
            id: activityContext.nextEventId(),
            sessionId: activityContext.sessionId,
            sequence: activityContext.lastEventSequence + 1,
            baseVersion: activityContext.baseVersion,
            type: 'fortune.revealed',
            zoneId: activityContext.zoneId,
            participantIds: activityContext.participantIds,
            timestamp: activityContext.now,
            payload: {
              activityInstanceId: 'other-activity',
              fortuneId: 'selected-fortune',
              rank: 'good',
            },
          }),
        ],
      }),
    );
    expect(() =>
      mismatched.resultEvents('counter', { count: 0 }, context()),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });

  it('validates fortune start events by the new activity instance field', () => {
    const registryFor = (activityInstanceId: string) =>
      new TownActivityRegistry().register(
        definition({
          resultEvents: (_state, activityContext) => [
            TownEventSchema.parse({
              id: activityContext.nextEventId(),
              sessionId: activityContext.sessionId,
              sequence: activityContext.lastEventSequence + 1,
              baseVersion: activityContext.baseVersion,
              type: 'fortune.started',
              zoneId: activityContext.zoneId,
              participantIds: activityContext.participantIds,
              timestamp: activityContext.now,
              payload: { activityInstanceId },
            }),
          ],
        }),
      );

    expect(
      registryFor('activity-1').resultEvents(
        'counter',
        { count: 0 },
        context(),
      ),
    ).toHaveLength(1);
    expect(() =>
      registryFor('other-activity').resultEvents(
        'counter',
        { count: 0 },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });

  it('exports the registry error as an Error subtype', () => {
    const error = new ActivityRegistryError('invalid-tool', 'bad tool');
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('invalid-tool');
  });
});
