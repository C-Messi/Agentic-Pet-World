import { z } from 'zod';

const ID_MAX_LENGTH = 128;
const ACTION_ID_MAX_LENGTH = 64;
const SHORT_TEXT_MAX_LENGTH = 280;
const LONG_TEXT_MAX_LENGTH = 1_000;

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const ActionIdSchema = IdentifierSchema.max(ACTION_ID_MAX_LENGTH);
const TimestampSchema = z.string().datetime({ offset: true });

export const WorldObjectIdSchema = z.enum([
  'bed',
  'sofa',
  'window',
  'food-bowl',
  'bookshelf',
  'toy-basket',
  'arcade',
]);
export type WorldObjectId = z.infer<typeof WorldObjectIdSchema>;

export const EmotionSchema = z.enum([
  'idle',
  'walk',
  'sit',
  'sleep',
  'happy',
  'curious',
  'confused',
]);
export type Emotion = z.infer<typeof EmotionSchema>;

export const InteractionSchema = z.enum(['inspect', 'rest', 'eat', 'play', 'open']);
export type Interaction = z.infer<typeof InteractionSchema>;

export const AGENT_ACTION_TYPES = [
  'move_to',
  'interact',
  'emote',
  'wait',
  'speak',
] as const;
export const AgentActionTypeSchema = z.enum(AGENT_ACTION_TYPES);
export type AgentActionType = z.infer<typeof AgentActionTypeSchema>;

const [
  MOVE_TO_ACTION_TYPE,
  INTERACT_ACTION_TYPE,
  EMOTE_ACTION_TYPE,
  WAIT_ACTION_TYPE,
  SPEAK_ACTION_TYPE,
] = AGENT_ACTION_TYPES;

export const PositionSchema = z
  .object({
    x: z.number().finite().min(-10_000).max(10_000),
    y: z.number().finite().min(-10_000).max(10_000),
  })
  .strict();
export type Position = z.infer<typeof PositionSchema>;

export const WorldObjectStateSchema = z
  .object({
    id: WorldObjectIdSchema,
    position: PositionSchema,
    available: z.boolean(),
    interactions: z.array(InteractionSchema).max(5),
  })
  .strict();
export type WorldObjectState = z.infer<typeof WorldObjectStateSchema>;

export const CatStateSchema = z
  .object({
    position: PositionSchema,
    emotion: EmotionSchema,
    currentTargetId: WorldObjectIdSchema.optional(),
  })
  .strict();
export type CatState = z.infer<typeof CatStateSchema>;

export const WorldSnapshotSchema = z
  .object({
    cat: CatStateSchema,
    objects: z.array(WorldObjectStateSchema).max(7),
  })
  .strict()
  .superRefine(({ objects }, context) => {
    const objectIds = new Set<WorldObjectId>();

    for (const [index, object] of objects.entries()) {
      if (objectIds.has(object.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate world object ID: ${object.id}`,
          path: ['objects', index, 'id'],
        });
      }
      objectIds.add(object.id);
    }
  });
export type WorldSnapshot = z.infer<typeof WorldSnapshotSchema>;

const MoveToActionSchema = z
  .object({
    id: ActionIdSchema,
    type: z.literal(MOVE_TO_ACTION_TYPE),
    targetId: WorldObjectIdSchema,
    timeoutMs: z.number().int().min(250).max(60_000),
  })
  .strict();

const InteractActionSchema = z
  .object({
    id: ActionIdSchema,
    type: z.literal(INTERACT_ACTION_TYPE),
    targetId: WorldObjectIdSchema,
    interaction: InteractionSchema,
  })
  .strict();

const EmoteActionSchema = z
  .object({
    id: ActionIdSchema,
    type: z.literal(EMOTE_ACTION_TYPE),
    emotion: EmotionSchema,
    durationMs: z.number().int().min(100).max(30_000),
  })
  .strict();

const WaitActionSchema = z
  .object({
    id: ActionIdSchema,
    type: z.literal(WAIT_ACTION_TYPE),
    durationMs: z.number().int().min(100).max(30_000),
  })
  .strict();

const SpeakActionSchema = z
  .object({
    id: ActionIdSchema,
    type: z.literal(SPEAK_ACTION_TYPE),
    text: z.string().trim().min(1).max(SHORT_TEXT_MAX_LENGTH),
  })
  .strict();

export const AgentActionSchema = z.discriminatedUnion('type', [
  MoveToActionSchema,
  InteractActionSchema,
  EmoteActionSchema,
  WaitActionSchema,
  SpeakActionSchema,
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

export const ActionResultSchema = z
  .object({
    actionId: ActionIdSchema,
    type: AgentActionTypeSchema,
    status: z.enum(['succeeded', 'failed', 'cancelled', 'timed_out']),
    message: z.string().trim().min(1).max(500).optional(),
    errorCode: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional(),
    completedAt: TimestampSchema,
  })
  .strict();
export type ActionResult = z.infer<typeof ActionResultSchema>;

export const AgentTurnRequestSchema = z
  .object({
    sessionId: IdentifierSchema,
    playerMessage: z.string().trim().min(1).max(LONG_TEXT_MAX_LENGTH),
    world: WorldSnapshotSchema,
    currentAction: AgentActionSchema.optional(),
    recentActionResults: z.array(ActionResultSchema).max(12),
  })
  .strict();
export type AgentTurnRequest = z.infer<typeof AgentTurnRequestSchema>;

export const MemoryCandidateSchema = z
  .object({
    content: z.string().trim().min(1).max(500),
    importance: z.number().finite().min(0).max(1),
    reason: z.string().trim().min(1).max(240).optional(),
  })
  .strict();
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

export const AgentDecisionSchema = z
  .object({
    speech: z.string().trim().min(1).max(SHORT_TEXT_MAX_LENGTH),
    thought: z.string().trim().min(1).max(240).optional(),
    emotion: EmotionSchema,
    actions: z.array(AgentActionSchema).max(4),
    memoryCandidates: z.array(MemoryCandidateSchema).max(3).optional(),
  })
  .strict()
  .superRefine(({ actions }, context) => {
    const actionIds = new Set<string>();

    for (const [index, action] of actions.entries()) {
      if (actionIds.has(action.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate action ID: ${action.id}`,
          path: ['actions', index, 'id'],
        });
      }
      actionIds.add(action.id);
    }
  });
export type AgentDecision = z.infer<typeof AgentDecisionSchema>;

export const MessageRecordSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    role: z.enum(['player', 'agent', 'system']),
    content: z.string().trim().min(1).max(4_000),
    createdAt: TimestampSchema,
  })
  .strict();
export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const MemoryRecordSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    content: z.string().trim().min(1).max(1_000),
    importance: z.number().finite().min(0).max(1),
    sourceMessageId: IdentifierSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

export const SessionRecordSchema = z
  .object({
    id: IdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const CreateSessionRequestSchema = z.object({}).strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const CreateSessionResponseSchema = z
  .object({ session: SessionRecordSchema })
  .strict();
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const SessionResponseSchema = z
  .object({
    session: SessionRecordSchema,
    world: WorldSnapshotSchema.nullable(),
    messages: z.array(MessageRecordSchema),
  })
  .strict();
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

export const AgentTurnBodySchema = AgentTurnRequestSchema.omit({ sessionId: true });
export type AgentTurnBody = z.infer<typeof AgentTurnBodySchema>;

export const AgentFallbackReasonSchema = z.enum([
  'cancelled',
  'invalid_output',
  'provider_failure',
  'provider_unavailable',
  'timeout',
  'unsafe_target',
]);

export const AgentTurnResponseSchema = z
  .object({
    decision: AgentDecisionSchema,
    degraded: z.boolean(),
    fallbackReason: AgentFallbackReasonSchema.optional(),
    correlationId: IdentifierSchema.max(96),
  })
  .strict()
  .superRefine((response, context) => {
    if (response.degraded !== (response.fallbackReason !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Degraded responses require a fallback reason',
        path: ['fallbackReason'],
      });
    }
  });
export type AgentTurnResponse = z.infer<typeof AgentTurnResponseSchema>;

export const ActionResultsRequestSchema = z
  .object({
    turnCorrelationId: IdentifierSchema.max(96),
    world: WorldSnapshotSchema,
    results: z.array(ActionResultSchema).min(1).max(12),
  })
  .strict();
export type ActionResultsRequest = z.infer<typeof ActionResultsRequestSchema>;

export const ActionResultsResponseSchema = z
  .object({ accepted: z.number().int().min(1).max(12) })
  .strict();

export const MemoriesResponseSchema = z
  .object({ memories: z.array(MemoryRecordSchema) })
  .strict();

export const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    checks: z
      .object({
        config: z.boolean(),
        storage: z.boolean(),
        knowledge: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
        message: z.string().min(1).max(500),
        correlationId: IdentifierSchema.max(96),
        details: z
          .array(
            z
              .object({
                path: z.string().max(240),
                message: z.string().min(1).max(500),
              })
              .strict(),
          )
          .max(24)
          .optional(),
        retryAfterMs: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
