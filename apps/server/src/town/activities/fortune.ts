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

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export function loadFortunePool(value: unknown): Readonly<FortunePool> {
  const parsed = FortunePoolSchema.parse(structuredClone(value));
  return deepFreeze(parsed);
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
  const parsedPool = FortunePoolSchema.parse(pool);
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

const PROHIBITED_INTERPRETATION_PATTERNS = [
  /\b(?:diagnos(?:e|ed|is)|disease|cancer|medicine|medical|treatment|doctor|heart attack|cardiac arrest)\b/i,
  /\b(?:stock|investment|profit|lottery|financial|guaranteed returns?|bankrupt|bankruptcy)\b/i,
  /\b(?:lawsuit|court|lawyer|legal)\b/i,
  /\b(?:disaster|earthquake|flood|deadly|death|die|fatal)\b/i,
  /\b(?:destined|inevitable|will happen|guaranteed)\b/i,
  /(?:\u533b\u7597|\u75be\u75c5|\u751f\u75c5|\u764c|\u836f\u7269|\u6cbb\u7597|\u533b\u751f|\u5fc3\u810f\u75c5\u53d1\u4f5c)/u,
  /(?:\u80a1\u7968|\u6295\u8d44|\u53d1\u8d22|\u5f69\u7968|\u8d22\u52a1|\u7834\u4ea7)/u,
  /(?:\u6cd5\u5f8b|\u8bc9\u8bbc|\u6cd5\u9662|\u5f8b\u5e08)/u,
  /(?:\u707e\u96be|\u5730\u9707|\u6d2a\u6c34|\u6b7b\u4ea1|\u53bb\u4e16|\u5fc5\u6b7b)/u,
  /(?:\u547d\u4e2d\u6ce8\u5b9a|\u4e00\u5b9a\u4f1a|\u5fc5\u7136)/u,
] as const;

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
  if (parsed.themes.some((theme) => !parsedFortune.themes.includes(theme))) {
    throw new TypeError(
      'Interpretation contains a theme not allowed by the selected fortune',
    );
  }
  if (
    PROHIBITED_INTERPRETATION_PATTERNS.some((pattern) =>
      pattern.test(parsed.text),
    )
  ) {
    throw new TypeError(
      'Interpretation contains prohibited prediction language',
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

function transitionFortune(
  sourceState: Readonly<FortuneState>,
  sourceTool: FortuneTool,
  context: ActivityContext,
): FortuneState {
  const state = FortuneStateSchema.parse(structuredClone(sourceState));
  const tool = FortuneToolSchema.parse(structuredClone(sourceTool));

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
  if (state.phase !== 'revealed' && state.phase !== 'completed') return [];
  try {
    const fortuneCursor = context.emittedEventTypes.filter(
      (type): type is 'fortune.revealed' | 'fortune.interpreted' =>
        type === 'fortune.revealed' || type === 'fortune.interpreted',
    );
    if (
      (fortuneCursor.length === 1 && fortuneCursor[0] !== 'fortune.revealed') ||
      (fortuneCursor.length === 2 &&
        (fortuneCursor[0] !== 'fortune.revealed' ||
          fortuneCursor[1] !== 'fortune.interpreted')) ||
      fortuneCursor.length > 2
    ) {
      throw new TypeError(
        'Fortune result events must follow reveal then interpretation order',
      );
    }
    const emitted = new Set(fortuneCursor);
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
    if (!emitted.has('fortune.revealed')) {
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
      !emitted.has('fortune.interpreted')
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
  stateSchema: FortuneStateSchema,
  toolSchema: FortuneToolSchema,
  createInitialState: (context) => ({
    version: 'fortune-state.v1',
    phase: 'idle',
    participantIds: [context.participantIds[0]!],
  }),
  transition: transitionFortune,
  resultEvents,
};

export const FORTUNE_ACTIVITY_DEFINITION = Object.freeze(
  FortuneActivityDefinition,
);
