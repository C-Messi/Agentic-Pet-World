import { TownEventSchema } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import type { ActivityContext } from '../activity-registry.js';
import {
  createFallbackFortuneInterpretation,
  FORTUNE_ACTIVITY_DEFINITION,
  FORTUNE_POOL,
  FortuneActivityError,
  FortuneInterpretationSchema,
  FortunePoolSchema,
  type FortuneState,
  loadFortunePool,
  safeFortuneInterpretation,
  selectFortune,
  validateFortuneInterpretation,
} from './fortune.js';

function inPhase<Phase extends FortuneState['phase']>(
  state: FortuneState,
  phase: Phase,
): Extract<FortuneState, { phase: Phase }> {
  expect(state.phase).toBe(phase);
  if (state.phase !== phase) throw new Error(`Expected fortune phase ${phase}`);
  return state as Extract<FortuneState, { phase: Phase }>;
}

function context(overrides: Partial<ActivityContext> = {}): ActivityContext {
  let eventNumber = 0;
  return {
    sessionId: 'session-1',
    activityInstanceId: 'fortune-session-1',
    baseVersion: 10,
    lastEventSequence: 20,
    participantIds: ['resident-1', 'resident-2'],
    zoneId: 'fortune-pavilion',
    now: '2026-07-13T10:00:00.000Z',
    emittedEventTypes: [],
    nextEventId: () => `event-${++eventNumber}`,
    ...overrides,
  };
}

function advanceToRevealed() {
  const activity = FORTUNE_ACTIVITY_DEFINITION;
  const activityContext = context();
  const idle = activity.createInitialState(activityContext);
  const gathering = activity.transition(
    idle,
    { type: 'invite', residentId: 'resident-2' },
    activityContext,
  );
  const drawing = inPhase(
    activity.transition(gathering, { type: 'draw', seed: 42 }, activityContext),
    'drawing',
  );
  return {
    activityContext,
    drawing,
    revealed: inPhase(
      activity.transition(drawing, { type: 'reveal' }, activityContext),
      'revealed',
    ),
  };
}

describe('fortune pool', () => {
  it('loads a versioned, deeply frozen pool with at least 24 unique records', () => {
    expect(FortunePoolSchema.parse(FORTUNE_POOL)).toEqual(FORTUNE_POOL);
    expect(FORTUNE_POOL.schemaVersion).toBe('fortune-pool.v1');
    expect(FORTUNE_POOL.fortunes.length).toBeGreaterThanOrEqual(24);
    expect(new Set(FORTUNE_POOL.fortunes.map(({ id }) => id)).size).toBe(
      FORTUNE_POOL.fortunes.length,
    );
    expect(Object.isFrozen(FORTUNE_POOL)).toBe(true);
    expect(Object.isFrozen(FORTUNE_POOL.fortunes)).toBe(true);
    expect(Object.isFrozen(FORTUNE_POOL.fortunes[0])).toBe(true);
  });

  it('rejects duplicate IDs, unknown themes, and extra fields', () => {
    const first = structuredClone(FORTUNE_POOL.fortunes[0]!);
    expect(() =>
      loadFortunePool({
        schemaVersion: 'fortune-pool.v1',
        fortunes: [first, structuredClone(first)],
      }),
    ).toThrow(/Duplicate fortune ID/);
    expect(() =>
      loadFortunePool({
        schemaVersion: 'fortune-pool.v1',
        fortunes: [{ ...first, themes: ['luck'] }],
      }),
    ).toThrow();
    expect(() =>
      loadFortunePool({
        schemaVersion: 'fortune-pool.v1',
        fortunes: [{ ...first, executableCode: 'run()' }],
      }),
    ).toThrow();
  });

  it('draws reproducibly from stable pool order using a safe integer seed', () => {
    expect(selectFortune(FORTUNE_POOL, 42).id).toBe(
      selectFortune(FORTUNE_POOL, 42).id,
    );
    expect(selectFortune(FORTUNE_POOL, -42).id).toBe(
      selectFortune(FORTUNE_POOL, -42).id,
    );
    expect(selectFortune(FORTUNE_POOL, 42).id).not.toBe(
      selectFortune(FORTUNE_POOL, 43).id,
    );
    expect(() => selectFortune(FORTUNE_POOL, Number.MAX_VALUE)).toThrow();
  });
});

describe('fortune activity transitions', () => {
  it('declares the stable activity identity and starts idle with the lead participant', () => {
    const initial = FORTUNE_ACTIVITY_DEFINITION.createInitialState(context());
    expect(FORTUNE_ACTIVITY_DEFINITION).toMatchObject({
      id: 'fortune-draw',
      zoneId: 'fortune-pavilion',
      capacity: 4,
    });
    expect(initial).toEqual({
      version: 'fortune-state.v1',
      phase: 'idle',
      participantIds: ['resident-1'],
    });
    expect(FORTUNE_ACTIVITY_DEFINITION.stateSchema.parse(initial)).toEqual(
      initial,
    );
  });

  it('follows idle -> gathering -> drawing -> revealed -> completed', () => {
    const activity = FORTUNE_ACTIVITY_DEFINITION;
    const activityContext = context();
    const idle = activity.createInitialState(activityContext);
    const gathering = activity.transition(
      idle,
      { type: 'invite', residentId: 'resident-2' },
      activityContext,
    );
    const asked = activity.transition(
      gathering,
      { type: 'ask', question: 'Where should our curiosity lead today?' },
      activityContext,
    );
    const drawing = inPhase(
      activity.transition(asked, { type: 'draw', seed: 42 }, activityContext),
      'drawing',
    );
    const revealed = inPhase(
      activity.transition(drawing, { type: 'reveal' }, activityContext),
      'revealed',
    );
    const fortune = FORTUNE_POOL.fortunes.find(
      ({ id }) => id === revealed.fortuneId,
    )!;
    const interpretation = createFallbackFortuneInterpretation(fortune);
    const interpreted = activity.transition(
      revealed,
      { type: 'interpret', ...interpretation },
      activityContext,
    );
    const completed = activity.transition(
      interpreted,
      { type: 'complete' },
      activityContext,
    );

    expect(gathering.phase).toBe('gathering');
    expect(asked).toMatchObject({
      phase: 'gathering',
      question: 'Where should our curiosity lead today?',
    });
    expect(drawing).toMatchObject({
      phase: 'drawing',
      seed: 42,
      fortuneId: expect.any(String),
    });
    expect(revealed).toMatchObject({
      phase: 'revealed',
      fortuneId: drawing.fortuneId,
      reading: fortune.verse,
    });
    expect(interpreted).toMatchObject({
      phase: 'revealed',
      fortuneId: drawing.fortuneId,
      interpretation: interpretation.text,
      interpretationThemes: interpretation.themes,
    });
    expect(completed).toMatchObject({
      phase: 'completed',
      fortuneId: drawing.fortuneId,
      interpretation: interpretation.text,
    });
  });

  it('only invites unique residents already authorized by context', () => {
    const activity = FORTUNE_ACTIVITY_DEFINITION;
    const activityContext = context();
    const idle = activity.createInitialState(activityContext);

    for (const residentId of ['resident-1', 'resident-3']) {
      expect(() =>
        activity.transition(
          idle,
          { type: 'invite', residentId },
          activityContext,
        ),
      ).toThrowError(expect.objectContaining({ code: 'illegal-transition' }));
    }
    expect(idle).toEqual({
      version: 'fortune-state.v1',
      phase: 'idle',
      participantIds: ['resident-1'],
    });
  });

  it('rejects illegal phase/tool combinations without mutating input', () => {
    const activity = FORTUNE_ACTIVITY_DEFINITION;
    const activityContext = context();
    const idle = activity.createInitialState(activityContext);
    const snapshot = structuredClone(idle);

    for (const tool of [
      { type: 'reveal' as const },
      {
        type: 'interpret' as const,
        fortuneId: 'fortune-01',
        text: 'Look around.',
        themes: ['rest' as const],
      },
      { type: 'complete' as const },
    ]) {
      expect(() =>
        activity.transition(idle, tool, activityContext),
      ).toThrowError(expect.objectContaining({ code: 'illegal-transition' }));
    }
    expect(idle).toEqual(snapshot);
    expect(
      new FortuneActivityError('illegal-transition', 'bad'),
    ).toBeInstanceOf(Error);
  });

  it('uses a strict tool union and bounded question and seed fields', () => {
    const schema = FORTUNE_ACTIVITY_DEFINITION.toolSchema;
    expect(() => schema.parse({ type: 'unknown' })).toThrow();
    expect(() => schema.parse({ type: 'reveal', extra: true })).toThrow();
    expect(() => schema.parse({ type: 'ask', question: '' })).toThrow();
    expect(() =>
      schema.parse({ type: 'ask', question: 'x'.repeat(161) }),
    ).toThrow();
    expect(() => schema.parse({ type: 'draw', seed: 1.5 })).toThrow();
    expect(() =>
      schema.parse({ type: 'draw', seed: Number.MAX_VALUE }),
    ).toThrow();
  });
});

describe('fortune interpretation safety', () => {
  it('creates a deterministic valid fallback from the authored interpretation', () => {
    const fortune = FORTUNE_POOL.fortunes[0]!;
    const first = createFallbackFortuneInterpretation(fortune);
    const second = createFallbackFortuneInterpretation(fortune);
    expect(first).toEqual(second);
    expect(first).toEqual({
      fortuneId: fortune.id,
      text: fortune.baseInterpretation,
      themes: fortune.themes,
    });
    expect(validateFortuneInterpretation(fortune, first)).toEqual(first);
    expect(FortuneInterpretationSchema.parse(first)).toEqual(first);
  });

  it.each([
    {
      fortuneId: 'changed',
      text: 'Pause and notice a new idea.',
      themes: ['rest'],
    },
    { fortuneId: '', text: 'Pause and notice a new idea.', themes: ['luck'] },
    { fortuneId: '', text: '', themes: ['rest'] },
    { fortuneId: '', text: 'x'.repeat(281), themes: ['rest'] },
    { fortuneId: '', text: 'Pause.', themes: ['rest'], extra: true },
  ])('rejects structurally unsafe interpretation: %s', (candidate) => {
    const fortune =
      FORTUNE_POOL.fortunes.find(({ themes }) => !themes.includes('rest')) ??
      FORTUNE_POOL.fortunes[0]!;
    const value = {
      ...candidate,
      fortuneId: candidate.fortuneId || fortune.id,
    };
    expect(() => validateFortuneInterpretation(fortune, value)).toThrow();
  });

  it.each([
    'You will be diagnosed with a disease.',
    'This guarantees investment profit.',
    'A lawsuit is inevitable.',
    'A deadly disaster will happen.',
    '你一定会生病需要治疗。',
    '投资必然发财。',
    '法院诉讼命中注定。',
    '灾难和死亡一定会发生。',
    'You will have a heart attack.',
    'You will go bankrupt.',
    '你会心脏病发作。',
    '你将破产。',
  ])('rejects representative prohibited prediction language: %s', (text) => {
    const fortune = FORTUNE_POOL.fortunes[0]!;
    expect(() =>
      validateFortuneInterpretation(fortune, {
        fortuneId: fortune.id,
        text,
        themes: fortune.themes,
      }),
    ).toThrow(/prohibited/i);
  });

  it('routes unsafe interpretation output to the deterministic fallback', () => {
    const fortune = FORTUNE_POOL.fortunes[0]!;
    expect(
      safeFortuneInterpretation(fortune, {
        fortuneId: fortune.id,
        text: 'You will have a heart attack.',
        themes: fortune.themes,
      }),
    ).toEqual(createFallbackFortuneInterpretation(fortune));
  });
});

describe('fortune result events', () => {
  it('emits two distinct sequential facts from completed state with an empty cursor', () => {
    const { activityContext, revealed } = advanceToRevealed();
    const fortune = FORTUNE_POOL.fortunes.find(
      ({ id }) => id === revealed.fortuneId,
    )!;
    const interpreted = FORTUNE_ACTIVITY_DEFINITION.transition(
      revealed,
      { type: 'interpret', ...createFallbackFortuneInterpretation(fortune) },
      activityContext,
    );
    const completed = FORTUNE_ACTIVITY_DEFINITION.transition(
      interpreted,
      { type: 'complete' },
      activityContext,
    );

    const events = FORTUNE_ACTIVITY_DEFINITION.resultEvents(
      completed,
      activityContext,
    );
    expect(events.map(({ type }) => type)).toEqual([
      'fortune.revealed',
      'fortune.interpreted',
    ]);
    expect(events[0]).toMatchObject({
      id: 'event-1',
      sessionId: 'session-1',
      sequence: 21,
      baseVersion: 10,
      zoneId: 'fortune-pavilion',
      participantIds: ['resident-1', 'resident-2'],
      payload: {
        activityInstanceId: 'fortune-session-1',
        fortuneId: fortune.id,
        rank: fortune.rank,
      },
    });
    expect(events[1]).toMatchObject({
      id: 'event-2',
      sequence: 22,
      baseVersion: 11,
      payload: {
        activityInstanceId: 'fortune-session-1',
        fortuneId: fortune.id,
        interpretation: fortune.baseInterpretation,
      },
    });
    for (const event of events)
      expect(TownEventSchema.parse(event)).toEqual(event);
    expect(new Set(events.map(({ id }) => id)).size).toBe(2);
  });

  it('emits reveal once, then only interpretation after the persisted cursor advances', () => {
    const { activityContext, drawing, revealed } = advanceToRevealed();
    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(drawing, activityContext),
    ).toEqual([]);
    const [reveal] = FORTUNE_ACTIVITY_DEFINITION.resultEvents(
      revealed,
      activityContext,
    );
    expect(reveal).toMatchObject({
      id: 'event-1',
      type: 'fortune.revealed',
      sequence: 21,
      baseVersion: 10,
      payload: {
        activityInstanceId: 'fortune-session-1',
        fortuneId: revealed.fortuneId,
      },
    });

    const fortune = FORTUNE_POOL.fortunes.find(
      ({ id }) => id === revealed.fortuneId,
    )!;
    const interpreted = FORTUNE_ACTIVITY_DEFINITION.transition(
      revealed,
      { type: 'interpret', ...createFallbackFortuneInterpretation(fortune) },
      activityContext,
    );
    const completed = FORTUNE_ACTIVITY_DEFINITION.transition(
      interpreted,
      { type: 'complete' },
      activityContext,
    );
    const [interpretation] = FORTUNE_ACTIVITY_DEFINITION.resultEvents(
      completed,
      context({
        baseVersion: 11,
        lastEventSequence: 21,
        emittedEventTypes: ['fortune.revealed'],
        nextEventId: () => 'event-2',
      }),
    );
    expect(interpretation).toMatchObject({
      id: 'event-2',
      type: 'fortune.interpreted',
      sequence: 22,
      baseVersion: 11,
      payload: {
        activityInstanceId: 'fortune-session-1',
        fortuneId: revealed.fortuneId,
      },
    });
    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(
        completed,
        context({
          baseVersion: 12,
          lastEventSequence: 22,
          emittedEventTypes: ['fortune.revealed', 'fortune.interpreted'],
          nextEventId: () => {
            throw new Error('cursor should suppress all emitted facts');
          },
        }),
      ),
    ).toEqual([]);
  });

  it('translates an invalid injected event ID into a typed activity error', () => {
    const { activityContext, revealed } = advanceToRevealed();
    expect(() =>
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
        ...activityContext,
        nextEventId: () => 'bad id!',
      }),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });

  it('ignores unrelated cursor types but rejects an invalid fortune prefix', () => {
    const { activityContext, revealed } = advanceToRevealed();
    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
        ...activityContext,
        emittedEventTypes: ['stall.opened'],
      }).map(({ type }) => type),
    ).toEqual(['fortune.revealed']);

    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
        ...activityContext,
        emittedEventTypes: [
          'stall.opened',
          'fortune.revealed',
          'resident.spoke',
        ],
      }),
    ).toEqual([]);

    for (const emittedEventTypes of [
      ['fortune.interpreted'],
      ['fortune.interpreted', 'fortune.revealed'],
      ['fortune.interpreted', 'stall.opened', 'fortune.revealed'],
      ['stall.opened', 'fortune.interpreted'],
    ] as const) {
      expect(() =>
        FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
          ...activityContext,
          emittedEventTypes,
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    }
  });
});
