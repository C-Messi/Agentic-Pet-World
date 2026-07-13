import { TownEventSchema } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  TownActivityRegistry,
  type ActivityContext,
  type EmittedActivityResult,
} from '../activity-registry.js';
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
    emittedResults: [],
    nextEventId: () => `event-${++eventNumber}`,
    ...overrides,
  };
}

function persistedResult(
  factKey: string,
  eventType: EmittedActivityResult['eventType'],
  eventId: string,
): EmittedActivityResult {
  return {
    activityInstanceId: 'fortune-session-1',
    factKey,
    eventType,
    eventId,
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

  it.each([
    [0, 'still-pond'],
    [1, 'open-gate'],
    [-1, 'soft-pillow'],
    [42, 'soft-pillow'],
    [Number.MAX_SAFE_INTEGER, 'new-ink'],
    [Number.MIN_SAFE_INTEGER, 'quiet-door'],
  ] as const)('keeps the golden draw vector for seed %s', (seed, fortuneId) => {
    expect(selectFortune(FORTUNE_POOL, seed).id).toBe(fortuneId);
  });

  it('keeps a coarse deterministic distribution across ten thousand seeds', () => {
    const counts = new Map<string, number>();
    for (let seed = 0; seed < 10_000; seed += 1) {
      const id = selectFortune(FORTUNE_POOL, seed).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.size).toBe(FORTUNE_POOL.fortunes.length);
    expect(Math.min(...counts.values())).toBeGreaterThanOrEqual(350);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(500);
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

  it('enforces participant attribution and exact roster before drawing', () => {
    const activity = FORTUNE_ACTIVITY_DEFINITION;
    const activityContext = context();
    const gathering = {
      version: 'fortune-state.v1' as const,
      phase: 'gathering' as const,
      participantIds: ['resident-1', 'resident-2'],
    };

    expect(
      inPhase(
        activity.transition(
          { ...gathering, participantIds: ['resident-2', 'resident-1'] },
          { type: 'draw', seed: 42 },
          activityContext,
        ),
        'drawing',
      ).fortuneId,
    ).toBe('soft-pillow');
    const invalidRosters: Array<[FortuneState, ActivityContext]> = [
      [{ ...gathering, participantIds: ['resident-1'] }, activityContext],
      [gathering, context({ participantIds: ['resident-1'] })],
      [{ ...gathering, participantIds: ['resident-2'] }, activityContext],
    ];
    for (const [state, changedContext] of invalidRosters) {
      expect(() =>
        activity.transition(state, { type: 'draw', seed: 42 }, changedContext),
      ).toThrowError(expect.objectContaining({ code: 'invalid-participant' }));
    }
  });

  it('rejects state participants outside context on every transition', () => {
    const activity = FORTUNE_ACTIVITY_DEFINITION;
    expect(() =>
      activity.transition(
        {
          version: 'fortune-state.v1',
          phase: 'gathering',
          participantIds: ['resident-1', 'resident-2'],
        },
        { type: 'ask', question: 'What now?' },
        context({ participantIds: ['resident-1'] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-participant' }));
    expect(() =>
      activity.transition(
        {
          version: 'fortune-state.v1',
          phase: 'gathering',
          participantIds: ['resident-1', 'resident-1'],
        },
        { type: 'ask', question: 'What now?' },
        context(),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-participant' }));
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

  it.each([
    'You will lose all your money tomorrow.',
    'The police will arrest you next week.',
    'A hurricane will destroy your home.',
    'Your health will worsen soon.',
    'Buy bitcoin tomorrow and you will be rich.',
    'Expect your finances to collapse soon.',
    'Invest all your money now.',
    'This does not predict bankruptcy, but your health will worsen soon.',
    '你明天会失去所有的钱。',
    '警察下周会逮捕你。',
    '飓风会摧毁你的家。',
    '你的健康很快会恶化。',
    '明天买比特币你会发财。',
    '你注定 will go bankrupt 明天。',
    '立即买入股票。',
    '这不是对破产的预测，但你的健康很快会恶化。',
  ])('rejects category-aware predictive risk: %s', (text) => {
    const fortune = FORTUNE_POOL.fortunes[0]!;
    expect(() =>
      validateFortuneInterpretation(fortune, {
        fortuneId: fortune.id,
        text,
        themes: fortune.themes,
      }),
    ).toThrow(/prohibited/i);
  });

  it.each([
    'Use a legal pad to capture the idea.',
    'Ask a doctor for information.',
    'This does not predict bankruptcy.',
    'The old story described a flood years ago.',
    'Storms can be metaphors for change.',
    '这不是对破产的预测。',
    '去年的故事描写了洪水。',
  ])(
    'allows benign, historical, metaphorical, or negated context: %s',
    (text) => {
      const fortune = FORTUNE_POOL.fortunes[0]!;
      expect(
        validateFortuneInterpretation(fortune, {
          fortuneId: fortune.id,
          text,
          themes: fortune.themes,
        }).text,
      ).toBe(text);
    },
  );

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
        emittedResults: [
          persistedResult('fortune-revealed', 'fortune.revealed', 'event-1'),
        ],
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

    const registry = new TownActivityRegistry().register(
      FORTUNE_ACTIVITY_DEFINITION,
    );
    const persistedReveal = persistedResult(
      'fortune-revealed',
      'fortune.revealed',
      'event-1',
    );
    expect(() =>
      registry.resultEvents(
        'fortune-draw',
        completed,
        context({
          baseVersion: 11,
          lastEventSequence: 21,
          emittedResults: [persistedReveal],
          nextEventId: () => 'event-1',
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    expect(
      registry.resultEvents(
        'fortune-draw',
        completed,
        context({
          baseVersion: 11,
          lastEventSequence: 21,
          emittedResults: [persistedReveal],
          nextEventId: () => 'event-2',
        }),
      )[0]?.id,
    ).toBe('event-2');
    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(
        completed,
        context({
          baseVersion: 12,
          lastEventSequence: 22,
          emittedResults: [
            persistedResult('fortune-revealed', 'fortune.revealed', 'event-1'),
            persistedResult(
              'fortune-interpreted',
              'fortune.interpreted',
              'event-2',
            ),
          ],
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
        emittedResults: [
          persistedResult('stall-opened', 'stall.opened', 'stall-event'),
        ],
      }).map(({ type }) => type),
    ).toEqual(['fortune.revealed']);

    expect(
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
        ...activityContext,
        emittedResults: [
          persistedResult('stall-opened', 'stall.opened', 'stall-event'),
          persistedResult('fortune-revealed', 'fortune.revealed', 'event-1'),
          persistedResult('resident-spoke', 'resident.spoke', 'spoke-event'),
        ],
      }),
    ).toEqual([]);

    for (const emittedResults of [
      [
        persistedResult(
          'fortune-interpreted',
          'fortune.interpreted',
          'event-2',
        ),
      ],
      [
        persistedResult(
          'fortune-interpreted',
          'fortune.interpreted',
          'event-2',
        ),
        persistedResult('fortune-revealed', 'fortune.revealed', 'event-1'),
      ],
      [
        persistedResult(
          'fortune-interpreted',
          'fortune.interpreted',
          'event-2',
        ),
        persistedResult('stall-opened', 'stall.opened', 'stall-event'),
        persistedResult('fortune-revealed', 'fortune.revealed', 'event-1'),
      ],
    ] as const) {
      expect(() =>
        FORTUNE_ACTIVITY_DEFINITION.resultEvents(revealed, {
          ...activityContext,
          emittedResults,
        }),
      ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    }
  });

  it('rejects tampered deterministic state and result attribution', () => {
    const { activityContext, drawing, revealed } = advanceToRevealed();
    expect(() =>
      FORTUNE_ACTIVITY_DEFINITION.transition(
        { ...drawing, fortuneId: 'open-gate' },
        { type: 'reveal' },
        activityContext,
      ),
    ).toThrowError(expect.objectContaining({ code: 'illegal-transition' }));
    expect(() =>
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(
        { ...revealed, reading: 'Tampered reading' },
        activityContext,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    expect(() =>
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(
        revealed,
        context({ participantIds: ['resident-1'] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
    expect(() =>
      FORTUNE_ACTIVITY_DEFINITION.resultEvents(
        { ...drawing, participantIds: ['resident-1'] },
        activityContext,
      ),
    ).toThrowError(expect.objectContaining({ code: 'invalid-result-event' }));
  });
});
