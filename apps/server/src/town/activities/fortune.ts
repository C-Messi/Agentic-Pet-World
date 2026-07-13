import {
  IdentifierSchema,
  TownEventSchema,
  type TownEvent,
} from '@cat-house/shared';
import { z } from 'zod';

import fortunePoolSource from '../../../content/town/fortunes.json';
import type {
  ActivityContext,
  TownActivityDefinition,
} from '../activity-registry.js';

export const FortuneThemeSchema = z.enum([
  'friendship',
  'creativity',
  'rest',
  'exploration',
  'patience',
  'cooperation',
]);
export const FortuneRankSchema = z.enum([
  'great',
  'good',
  'neutral',
  'caution',
]);

export const FortuneRecordSchema = z
  .object({
    id: IdentifierSchema,
    rank: FortuneRankSchema,
    verse: z.string().trim().min(1).max(120),
    baseInterpretation: z.string().trim().min(1).max(240),
    themes: z.array(FortuneThemeSchema).min(1).max(3),
  })
  .strict()
  .superRefine(({ themes }, refinementContext) => {
    if (new Set(themes).size !== themes.length) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fortune themes must be unique',
        path: ['themes'],
      });
    }
  });

export const FortunePoolSchema = z
  .object({
    schemaVersion: z.literal('fortune-pool.v1'),
    fortunes: z.array(FortuneRecordSchema).min(24),
  })
  .strict()
  .superRefine(({ fortunes }, refinementContext) => {
    const seen = new Set<string>();
    for (const [index, fortune] of fortunes.entries()) {
      if (seen.has(fortune.id)) {
        refinementContext.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate fortune ID: ${fortune.id}`,
          path: ['fortunes', index, 'id'],
        });
      }
      seen.add(fortune.id);
    }
  });

export type FortuneRecord = z.infer<typeof FortuneRecordSchema>;
export type FortunePool = z.infer<typeof FortunePoolSchema>;

const VALIDATED_FORTUNE_POOLS = new WeakSet<object>();

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function loadFortunePool(value: unknown): Readonly<FortunePool> {
  const parsed = FortunePoolSchema.parse(structuredClone(value));
  const frozen = deepFreeze(parsed);
  VALIDATED_FORTUNE_POOLS.add(frozen);
  return frozen;
}

export const FORTUNE_POOL = loadFortunePool(fortunePoolSource);

function hashSeed(seed: number): number {
  let hash = 0x81_1c_9d_c5;
  for (const byte of new TextEncoder().encode(seed.toString(10))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash;
}

export function selectFortune(
  pool: Readonly<FortunePool>,
  seed: number,
): Readonly<FortuneRecord> {
  if (!Number.isSafeInteger(seed)) {
    throw new TypeError('Fortune seed must be a safe integer');
  }
  const parsedPool = VALIDATED_FORTUNE_POOLS.has(pool)
    ? pool
    : loadFortunePool(pool);
  return parsedPool.fortunes[hashSeed(seed) % parsedPool.fortunes.length]!;
}

export const FortuneInterpretationSchema = z
  .object({
    fortuneId: IdentifierSchema,
    text: z.string().trim().min(1).max(280),
    themes: z.array(FortuneThemeSchema).min(1).max(3),
  })
  .strict()
  .superRefine(({ themes }, refinementContext) => {
    if (new Set(themes).size !== themes.length) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Interpretation themes must be unique',
        path: ['themes'],
      });
    }
  });

export type FortuneInterpretation = z.infer<typeof FortuneInterpretationSchema>;

export interface AllowedFortuneInterpretation {
  readonly key: string;
  readonly theme: z.infer<typeof FortuneThemeSchema>;
  readonly text: string;
}

const THEME_INTERPRETATION_TEMPLATES: Record<
  z.infer<typeof FortuneThemeSchema>,
  readonly [string, string]
> = {
  friendship: [
    'Make space for a kind conversation and listen with care.',
    '\u7ed9\u4e00\u6b21\u53cb\u5584\u7684\u4ea4\u8c08\u7559\u51fa\u7a7a\u95f4\uff0c\u4e5f\u7528\u5fc3\u503e\u542c\u3002',
  ],
  creativity: [
    'Give one small creative idea time to take shape.',
    '\u7ed9\u4e00\u4e2a\u5c0f\u5c0f\u7684\u521b\u610f\u4e00\u4e9b\u6210\u5f62\u7684\u65f6\u95f4\u3002',
  ],
  rest: [
    'Choose a quiet pause and return with renewed attention.',
    '\u9009\u62e9\u7247\u523b\u5b89\u9759\u4f11\u606f\uff0c\u518d\u5e26\u7740\u66f4\u4e13\u6ce8\u7684\u5fc3\u60c5\u56de\u6765\u3002',
  ],
  exploration: [
    'Notice one inviting path and explore it with curiosity.',
    '\u7559\u610f\u4e00\u6761\u6709\u8da3\u7684\u8def\uff0c\u5e26\u7740\u597d\u5947\u5fc3\u53bb\u63a2\u7d22\u3002',
  ],
  patience: [
    'Let the next step become clear without rushing it.',
    '\u4e0d\u5fc5\u50ac\u4fc3\uff0c\u8ba9\u4e0b\u4e00\u6b65\u6162\u6162\u53d8\u5f97\u6e05\u6670\u3002',
  ],
  cooperation: [
    'Share the next small task and make room for each voice.',
    '\u5206\u4eab\u4e0b\u4e00\u4e2a\u5c0f\u4efb\u52a1\uff0c\u4e5f\u7ed9\u6bcf\u4e2a\u4eba\u8868\u8fbe\u7684\u7a7a\u95f4\u3002',
  ],
};

export function allowedFortuneInterpretations(
  fortune: Readonly<FortuneRecord>,
): readonly Readonly<AllowedFortuneInterpretation>[] {
  const parsed = FortuneRecordSchema.parse(fortune);
  const entries: AllowedFortuneInterpretation[] = [
    { key: 'base', theme: parsed.themes[0]!, text: parsed.baseInterpretation },
  ];
  for (const theme of parsed.themes) {
    const [english, chinese] = THEME_INTERPRETATION_TEMPLATES[theme];
    entries.push(
      { key: `${theme}-en`, theme, text: english },
      { key: `${theme}-zh`, theme, text: chinese },
    );
  }
  return deepFreeze(entries);
}

export function validateFortuneInterpretation(
  fortune: Readonly<FortuneRecord>,
  value: unknown,
): Readonly<FortuneInterpretation> {
  const parsedFortune = FortuneRecordSchema.parse(fortune);
  const parsed = FortuneInterpretationSchema.parse(structuredClone(value));
  if (parsed.fortuneId !== parsedFortune.id) {
    throw new TypeError(
      'Interpretation fortune ID does not match selected fortune',
    );
  }
  const entry = allowedFortuneInterpretations(parsedFortune).find(
    ({ text }) => text === parsed.text,
  );
  const expectedThemes =
    entry?.key === 'base' ? parsedFortune.themes : entry ? [entry.theme] : [];
  if (
    entry === undefined ||
    parsed.themes.length !== expectedThemes.length ||
    !parsed.themes.every((theme) => expectedThemes.includes(theme))
  ) {
    throw new TypeError(
      'Interpretation text and themes must match the finite allowlist',
    );
  }
  return deepFreeze(parsed);
}

export function createFallbackFortuneInterpretation(
  fortune: Readonly<FortuneRecord>,
): Readonly<FortuneInterpretation> {
  return validateFortuneInterpretation(fortune, {
    fortuneId: fortune.id,
    text: fortune.baseInterpretation,
    themes: fortune.themes,
  });
}

export function safeFortuneInterpretation(
  fortune: Readonly<FortuneRecord>,
  value: unknown,
): Readonly<FortuneInterpretation> {
  try {
    return validateFortuneInterpretation(fortune, value);
  } catch {
    return createFallbackFortuneInterpretation(fortune);
  }
}

const ParticipantIdsSchema = z
  .array(IdentifierSchema)
  .min(1)
  .max(4)
  .superRefine((ids, refinementContext) => {
    if (new Set(ids).size !== ids.length) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Fortune participants must be unique',
      });
    }
  });
const QuestionSchema = z.string().trim().min(1).max(160);
const SeedSchema = z.number().int().safe();
const FortuneStateBase = {
  version: z.literal('fortune-state.v1'),
  participantIds: ParticipantIdsSchema,
  question: QuestionSchema.optional(),
};

const IdleStateSchema = z
  .object({ ...FortuneStateBase, phase: z.literal('idle') })
  .strict();
const GatheringStateSchema = z
  .object({ ...FortuneStateBase, phase: z.literal('gathering') })
  .strict();
const DrawingStateSchema = z
  .object({
    ...FortuneStateBase,
    phase: z.literal('drawing'),
    seed: SeedSchema,
    fortuneId: IdentifierSchema,
  })
  .strict();
const RevealedStateSchema = z
  .object({
    ...FortuneStateBase,
    phase: z.literal('revealed'),
    seed: SeedSchema,
    fortuneId: IdentifierSchema,
    reading: z.string().trim().min(1).max(120),
    interpretation: z.string().trim().min(1).max(280).optional(),
    interpretationThemes: z.array(FortuneThemeSchema).min(1).max(3).optional(),
  })
  .strict();
const CompletedStateSchema = z
  .object({
    ...FortuneStateBase,
    phase: z.literal('completed'),
    seed: SeedSchema,
    fortuneId: IdentifierSchema,
    reading: z.string().trim().min(1).max(120),
    interpretation: z.string().trim().min(1).max(280),
    interpretationThemes: z.array(FortuneThemeSchema).min(1).max(3),
  })
  .strict();

export const FortuneStateSchema = z
  .discriminatedUnion('phase', [
    IdleStateSchema,
    GatheringStateSchema,
    DrawingStateSchema,
    RevealedStateSchema,
    CompletedStateSchema,
  ])
  .superRefine((state, refinementContext) => {
    if (
      state.phase === 'revealed' &&
      (state.interpretation === undefined) !==
        (state.interpretationThemes === undefined)
    ) {
      refinementContext.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Interpretation text and themes must appear together',
      });
    }
  });
export type FortuneState = z.infer<typeof FortuneStateSchema>;

export const FortuneToolSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('invite'), residentId: IdentifierSchema })
    .strict(),
  z.object({ type: z.literal('ask'), question: QuestionSchema }).strict(),
  z.object({ type: z.literal('draw'), seed: SeedSchema }).strict(),
  z.object({ type: z.literal('reveal') }).strict(),
  z
    .object({
      type: z.literal('interpret'),
      fortuneId: IdentifierSchema,
      text: z.string().trim().min(1).max(280),
      themes: z.array(FortuneThemeSchema).min(1).max(3),
    })
    .strict(),
  z.object({ type: z.literal('complete') }).strict(),
]);
export type FortuneTool = z.infer<typeof FortuneToolSchema>;

export type FortuneActivityErrorCode =
  | 'illegal-transition'
  | 'invalid-participant'
  | 'invalid-interpretation'
  | 'invalid-result-event';

export class FortuneActivityError extends Error {
  constructor(
    public readonly code: FortuneActivityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'FortuneActivityError';
  }
}

function illegal(message: string): never {
  throw new FortuneActivityError('illegal-transition', message);
}

function copyQuestion(state: FortuneState): { question?: string } {
  return state.question === undefined ? {} : { question: state.question };
}

function findFortune(fortuneId: string): Readonly<FortuneRecord> {
  const fortune = FORTUNE_POOL.fortunes.find(({ id }) => id === fortuneId);
  if (fortune === undefined)
    throw new TypeError(`Unknown fortune: ${fortuneId}`);
  return fortune;
}

function sameIdentifierSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function validateParticipants(
  state: Readonly<FortuneState>,
  context: ActivityContext,
  exact: boolean,
): void {
  const lead = context.participantIds[0];
  if (
    lead === undefined ||
    !state.participantIds.includes(lead) ||
    new Set(state.participantIds).size !== state.participantIds.length ||
    !state.participantIds.every((id) => context.participantIds.includes(id)) ||
    (exact && !sameIdentifierSet(state.participantIds, context.participantIds))
  ) {
    throw new FortuneActivityError(
      'invalid-participant',
      'Fortune state participants do not match the activity context',
    );
  }
}

function validateDeterministicState(state: Readonly<FortuneState>): void {
  if (state.phase === 'idle' || state.phase === 'gathering') return;
  const fortune = selectFortune(FORTUNE_POOL, state.seed);
  if (state.fortuneId !== fortune.id) {
    throw new TypeError('Fortune selection does not match its recorded seed');
  }
  if (
    (state.phase === 'revealed' || state.phase === 'completed') &&
    state.reading !== fortune.verse
  ) {
    throw new TypeError('Fortune reading does not match the selected record');
  }
  if (
    (state.phase === 'revealed' || state.phase === 'completed') &&
    state.interpretation !== undefined &&
    state.interpretationThemes !== undefined
  ) {
    validateFortuneInterpretation(fortune, {
      fortuneId: state.fortuneId,
      text: state.interpretation,
      themes: state.interpretationThemes,
    });
  }
}

function transitionFortune(
  sourceState: Readonly<FortuneState>,
  sourceTool: FortuneTool,
  context: ActivityContext,
): FortuneState {
  let state: FortuneState;
  try {
    state = FortuneStateSchema.parse(structuredClone(sourceState));
  } catch (error) {
    const participantIds = (sourceState as { participantIds?: unknown })
      ?.participantIds;
    if (
      Array.isArray(participantIds) &&
      new Set(participantIds).size !== participantIds.length
    ) {
      throw new FortuneActivityError(
        'invalid-participant',
        'Fortune state participants must be unique',
        { cause: error },
      );
    }
    throw error;
  }
  const tool = FortuneToolSchema.parse(structuredClone(sourceTool));
  validateParticipants(
    state,
    context,
    (tool.type === 'draw' && state.phase === 'gathering') ||
      (tool.type === 'reveal' && state.phase === 'drawing') ||
      (tool.type === 'interpret' && state.phase === 'revealed') ||
      (tool.type === 'complete' && state.phase === 'revealed'),
  );
  try {
    validateDeterministicState(state);
  } catch (error) {
    throw new FortuneActivityError(
      'illegal-transition',
      'Fortune state violates deterministic selection invariants',
      { cause: error },
    );
  }

  switch (tool.type) {
    case 'invite': {
      if (state.phase !== 'idle' && state.phase !== 'gathering') {
        return illegal('Residents can only be invited while gathering');
      }
      if (
        !context.participantIds.includes(tool.residentId) ||
        state.participantIds.includes(tool.residentId) ||
        state.participantIds.length >= FORTUNE_ACTIVITY_DEFINITION.capacity
      ) {
        return illegal(
          'Invited resident must be a unique authorized participant',
        );
      }
      return {
        version: 'fortune-state.v1',
        phase: 'gathering',
        participantIds: [...state.participantIds, tool.residentId],
        ...copyQuestion(state),
      };
    }
    case 'ask':
      if (state.phase !== 'idle' && state.phase !== 'gathering') {
        return illegal('A question can only be asked while gathering');
      }
      return {
        version: 'fortune-state.v1',
        phase: 'gathering',
        participantIds: [...state.participantIds],
        question: tool.question,
      };
    case 'draw': {
      if (state.phase !== 'gathering')
        return illegal('Fortune can only be drawn after gathering');
      const fortune = selectFortune(FORTUNE_POOL, tool.seed);
      return {
        version: 'fortune-state.v1',
        phase: 'drawing',
        participantIds: [...state.participantIds],
        ...copyQuestion(state),
        seed: tool.seed,
        fortuneId: fortune.id,
      };
    }
    case 'reveal': {
      if (state.phase !== 'drawing')
        return illegal('Only a drawn fortune can be revealed');
      const fortune = findFortune(state.fortuneId);
      return {
        ...state,
        phase: 'revealed',
        reading: fortune.verse,
      };
    }
    case 'interpret': {
      if (state.phase !== 'revealed' || state.interpretation !== undefined) {
        return illegal(
          'Only an uninterpreted revealed fortune can be interpreted',
        );
      }
      let interpretation: Readonly<FortuneInterpretation>;
      try {
        interpretation = validateFortuneInterpretation(
          findFortune(state.fortuneId),
          {
            fortuneId: tool.fortuneId,
            text: tool.text,
            themes: tool.themes,
          },
        );
      } catch (error) {
        throw new FortuneActivityError(
          'invalid-interpretation',
          'Unsafe fortune interpretation',
          { cause: error },
        );
      }
      return {
        ...state,
        interpretation: interpretation.text,
        interpretationThemes: [...interpretation.themes],
      };
    }
    case 'complete':
      if (
        state.phase !== 'revealed' ||
        state.interpretation === undefined ||
        state.interpretationThemes === undefined
      ) {
        return illegal(
          'Fortune requires a safe interpretation before completion',
        );
      }
      return {
        ...state,
        phase: 'completed',
        interpretation: state.interpretation,
        interpretationThemes: state.interpretationThemes,
      };
  }
}

function resultEvents(
  state: Readonly<FortuneState>,
  context: ActivityContext,
): readonly TownEvent[] {
  try {
    validateParticipants(state, context, false);
    validateDeterministicState(state);
    if (state.phase !== 'revealed' && state.phase !== 'completed') return [];
    validateParticipants(state, context, true);
    const fortuneCursor = context.emittedResults.filter(
      ({ factKey }) =>
        factKey === 'fortune-revealed' || factKey === 'fortune-interpreted',
    );
    if (
      (fortuneCursor.length === 1 &&
        (fortuneCursor[0]?.factKey !== 'fortune-revealed' ||
          fortuneCursor[0].eventType !== 'fortune.revealed')) ||
      (fortuneCursor.length === 2 &&
        (fortuneCursor[0]?.factKey !== 'fortune-revealed' ||
          fortuneCursor[0].eventType !== 'fortune.revealed' ||
          fortuneCursor[1]?.factKey !== 'fortune-interpreted' ||
          fortuneCursor[1].eventType !== 'fortune.interpreted')) ||
      fortuneCursor.length > 2
    ) {
      throw new TypeError(
        'Fortune result events must follow reveal then interpretation order',
      );
    }
    const emitted = new Set(fortuneCursor.map(({ factKey }) => factKey));
    const fortune = findFortune(state.fortuneId);
    const facts: Array<
      | {
          type: 'fortune.revealed';
          payload: {
            activityInstanceId: string;
            fortuneId: string;
            rank: FortuneRecord['rank'];
          };
        }
      | {
          type: 'fortune.interpreted';
          payload: {
            activityInstanceId: string;
            fortuneId: string;
            interpretation: string;
          };
        }
    > = [];
    if (!emitted.has('fortune-revealed')) {
      facts.push({
        type: 'fortune.revealed',
        payload: {
          activityInstanceId: context.activityInstanceId,
          fortuneId: state.fortuneId,
          rank: fortune.rank,
        },
      });
    }
    if (
      state.interpretation !== undefined &&
      !emitted.has('fortune-interpreted')
    ) {
      facts.push({
        type: 'fortune.interpreted',
        payload: {
          activityInstanceId: context.activityInstanceId,
          fortuneId: state.fortuneId,
          interpretation: state.interpretation,
        },
      });
    }

    const events = facts.map((fact, index) =>
      TownEventSchema.parse({
        id: context.nextEventId(),
        sessionId: context.sessionId,
        sequence: context.lastEventSequence + index + 1,
        baseVersion: context.baseVersion + index,
        zoneId: context.zoneId,
        participantIds: context.participantIds,
        timestamp: context.now,
        ...fact,
      }),
    );
    if (new Set(events.map(({ id }) => id)).size !== events.length) {
      throw new TypeError('Fortune result event IDs must be unique');
    }
    return events;
  } catch (error) {
    throw new FortuneActivityError(
      'invalid-result-event',
      'Invalid fortune result event',
      { cause: error },
    );
  }
}

const FortuneActivityDefinition: TownActivityDefinition<
  FortuneState,
  FortuneTool
> = {
  id: 'fortune-draw',
  zoneId: 'fortune-pavilion',
  capacity: 4,
  resultEventTypes: ['fortune.revealed', 'fortune.interpreted'],
  stateSchema: FortuneStateSchema,
  toolSchema: FortuneToolSchema,
  createInitialState: (context) => ({
    version: 'fortune-state.v1',
    phase: 'idle',
    participantIds: [context.participantIds[0]!],
  }),
  transition: transitionFortune,
  resultEvents,
  validateResultEvent: (event, state, context) => {
    if (
      event.type !== 'fortune.revealed' &&
      event.type !== 'fortune.interpreted'
    ) {
      return false;
    }
    try {
      validateDeterministicState(state);
    } catch {
      return false;
    }
    if (
      (state.phase !== 'revealed' && state.phase !== 'completed') ||
      !sameIdentifierSet(state.participantIds, context.participantIds) ||
      event.payload.activityInstanceId !== context.activityInstanceId ||
      event.zoneId !== 'fortune-pavilion' ||
      context.zoneId !== 'fortune-pavilion' ||
      !sameIdentifierSet(event.participantIds, context.participantIds) ||
      event.payload.fortuneId !== state.fortuneId
    ) {
      return false;
    }
    const fortune = selectFortune(FORTUNE_POOL, state.seed);
    return event.type === 'fortune.revealed'
      ? event.payload.rank === fortune.rank
      : state.interpretation !== undefined &&
          event.payload.interpretation === state.interpretation;
  },
};

export const FORTUNE_ACTIVITY_DEFINITION = Object.freeze(
  FortuneActivityDefinition,
);
