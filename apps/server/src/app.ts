import { createHash } from 'node:crypto';

import {
  ActionResultsRequestSchema,
  ActionResultsResponseSchema,
  AgentTurnBodySchema,
  AgentTurnResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  MemoriesResponseSchema,
  SessionResponseSchema,
  type ActionResult,
  type AgentAction,
  type AgentFallbackReason,
  type AgentTurnRequest,
  type MemoryRecord,
  type MessageRecord,
  type SessionRecord,
  type WorldSnapshot,
} from '@cat-house/shared';
import cors from '@fastify/cors';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';

const CorrelationIdSchema = z
  .string()
  .min(1)
  .max(96)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const SessionParamsSchema = z.object({ id: z.string().min(1).max(128) }).strict();

export interface ApiStore {
  runInTransaction<T>(operation: () => T): T;
  createSession(record: SessionRecord): void;
  touchSession(id: string, updatedAt: string): void;
  getSession(id: string): SessionRecord | undefined;
  getWorld(sessionId: string):
    | { sessionId: string; snapshot: WorldSnapshot; updatedAt: string }
    | undefined;
  upsertWorld(sessionId: string, snapshot: WorldSnapshot, updatedAt: string): void;
  listMessages(sessionId: string): readonly MessageRecord[];
  listMemories(sessionId: string): readonly MemoryRecord[];
  createActionRun(
    sessionId: string,
    action: AgentAction,
    correlationId: string,
    createdAt: string,
  ): void;
  completeActionRun(sessionId: string, result: ActionResult, updatedAt: string): boolean;
  createActionResultsEvent(event: {
    id: string;
    sessionId: string;
    type: 'actions.results.recorded';
    payload: { results: readonly ActionResult[]; world: WorldSnapshot };
    createdAt: string;
  }): void;
}

export class ActionResultDomainError extends Error {
  public constructor(
    public readonly kind: 'conflict' | 'not_found',
    message: string,
  ) {
    super(message);
    this.name = 'ActionResultDomainError';
  }
}

export interface AppAgentService {
  turnDetailed(
    request: AgentTurnRequest,
    options: { signal: AbortSignal; correlationId: string },
  ): Promise<{
    decision: import('@cat-house/shared').AgentDecision;
    fallbackReason?: AgentFallbackReason;
  }>;
}

export interface BuildAppDependencies {
  readonly webOrigin: string;
  readonly store: ApiStore;
  readonly agentService: AppAgentService;
  readonly readiness: () => {
    readonly config: boolean;
    readonly storage: boolean;
    readonly knowledge: boolean;
  };
  readonly clock: () => string;
  readonly idFactory: (
    prefix: 'session' | 'request' | 'event' | 'action-run',
  ) => string;
  readonly rateLimit?: {
    readonly max: number;
    readonly windowMs: number;
    readonly maxEntries?: number;
  };
  readonly nowMs?: () => number;
  readonly bodyLimitBytes?: number;
  readonly requestAbortSignal?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AbortSignal;
}

interface AbortEventSource {
  once(event: 'aborted' | 'close' | 'finish', listener: () => void): unknown;
  removeListener?(event: 'aborted' | 'close' | 'finish', listener: () => void): unknown;
  readonly aborted?: boolean;
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  readonly socket?: { readonly destroyed?: boolean };
  readonly writableEnded?: boolean;
}

export function createRequestAbortSignal(
  request: AbortEventSource,
  response?: AbortEventSource,
): AbortSignal {
  const controller = new AbortController();
  const cleanup = () => {
    request.removeListener?.('aborted', abort);
    response?.removeListener?.('close', close);
    response?.removeListener?.('finish', finish);
  };
  const abort = () => {
    cleanup();
    controller.abort();
  };
  const close = () => {
    if (response?.writableEnded !== true) {
      abort();
      return;
    }
    cleanup();
  };
  const finish = () => cleanup();
  if (
    request.aborted === true
    || request.socket?.destroyed === true
    || response?.closed === true
    || response?.destroyed === true
    || response?.socket?.destroyed === true
    || response?.writableEnded === true
  ) {
    controller.abort();
    return controller.signal;
  }
  request.once('aborted', abort);
  response?.once('close', close);
  response?.once('finish', finish);
  return controller.signal;
}

export function buildApp(dependencies: BuildAppDependencies): FastifyInstance {
  const rateLimit = dependencies.rateLimit ?? {
    max: 8,
    windowMs: 60_000,
    maxEntries: 1_000,
  };
  validateRateLimit(rateLimit);
  const limiter = new FixedWindowRateLimiter(
    rateLimit.max,
    rateLimit.windowMs,
    rateLimit.maxEntries,
  );
  const activeTurns = new Set<string>();
  const app = Fastify({
    logger: false,
    bodyLimit: dependencies.bodyLimitBytes ?? 1_048_576,
    genReqId: (request) => {
      const supplied = request.headers['x-correlation-id'];
      const parsed = CorrelationIdSchema.safeParse(
        Array.isArray(supplied) ? supplied[0] : supplied,
      );
      return parsed.success ? parsed.data : dependencies.idFactory('request');
    },
  });

  void app.register(cors, {
    origin(origin, callback) {
      callback(null, origin === undefined || origin === dependencies.webOrigin);
    },
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-correlation-id', request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      sendError(reply, request.id, error.statusCode, error.code, error.message, {
        ...(error.details === undefined ? {} : { details: error.details }),
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
      });
      return;
    }
    const clientError = mapFastifyClientError(error);
    if (clientError !== undefined) {
      sendError(
        reply,
        request.id,
        clientError.statusCode,
        clientError.code,
        clientError.message,
      );
      return;
    }
    sendError(
      reply,
      request.id,
      500,
      'INTERNAL_ERROR',
      'The request could not be completed',
    );
  });

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, request.id, 404, 'ROUTE_NOT_FOUND', 'Route not found');
  });

  app.get('/health', async (_request, reply) => {
    const checks = dependencies.readiness();
    const ready = checks.config && checks.storage && checks.knowledge;
    const body = HealthResponseSchema.parse({
      status: ready ? 'ok' : 'degraded',
      checks,
    });
    return reply.code(ready ? 200 : 503).send(body);
  });

  app.post('/api/sessions', async (request, reply) => {
    parseBody(CreateSessionRequestSchema, request.body ?? {});
    const timestamp = dependencies.clock();
    const session = {
      id: dependencies.idFactory('session'),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    dependencies.store.createSession(session);
    return reply.code(201).send(CreateSessionResponseSchema.parse({ session }));
  });

  app.get('/api/sessions/:id', async (request, reply) => {
    const sessionId = parseSessionId(request.params);
    const session = requireSession(dependencies.store, sessionId);
    const worldState = dependencies.store.getWorld(sessionId);
    return reply.send(SessionResponseSchema.parse({
      session,
      world: worldState?.snapshot ?? null,
      messages: dependencies.store.listMessages(sessionId),
    }));
  });

  app.post('/api/sessions/:id/turns', async (request, reply) => {
    const sessionId = parseSessionId(request.params);
    const body = parseBody(AgentTurnBodySchema, request.body);
    requireSession(dependencies.store, sessionId);
    if (activeTurns.has(sessionId)) {
      throw new ApiError(409, 'TURN_IN_PROGRESS', 'A turn is already running for this session');
    }
    const limit = limiter.consume(sessionId, (dependencies.nowMs ?? Date.now)());
    if (!limit.allowed) {
      reply.header('retry-after', Math.ceil(limit.retryAfterMs / 1_000));
      throw new ApiError(
        429,
        'RATE_LIMITED',
        'Too many turn requests',
        undefined,
        limit.retryAfterMs,
      );
    }

    activeTurns.add(sessionId);
    try {
      const signal = (dependencies.requestAbortSignal ?? defaultRequestAbortSignal)(
        request,
        reply,
      );
      const outcome = await dependencies.agentService.turnDetailed(
        { sessionId, ...body },
        { signal, correlationId: request.id },
      );
      const createdAt = dependencies.clock();
      dependencies.store.runInTransaction(() => {
        dependencies.store.upsertWorld(sessionId, body.world, createdAt);
        dependencies.store.touchSession(sessionId, createdAt);
        for (const action of outcome.decision.actions) {
          dependencies.store.createActionRun(
            sessionId,
            action,
            request.id,
            createdAt,
          );
        }
      });
      const degraded = outcome.fallbackReason !== undefined;
      const response = AgentTurnResponseSchema.parse({
        decision: outcome.decision,
        degraded,
        ...(outcome.fallbackReason === undefined
          ? {}
          : { fallbackReason: outcome.fallbackReason }),
        correlationId: request.id,
      });
      return reply.code(degraded ? 503 : 200).send(response);
    } finally {
      activeTurns.delete(sessionId);
    }
  });

  app.post('/api/sessions/:id/action-results', async (request, reply) => {
    const sessionId = parseSessionId(request.params);
    const body = parseBody(ActionResultsRequestSchema, request.body);
    requireSession(dependencies.store, sessionId);
    const updatedAt = dependencies.clock();
    try {
      dependencies.store.runInTransaction(() => {
        let hasNewResult = false;
        for (const result of body.results) {
          hasNewResult = dependencies.store.completeActionRun(
            sessionId,
            result,
            updatedAt,
          ) || hasNewResult;
        }
        if (!hasNewResult) {
          return;
        }
        dependencies.store.upsertWorld(sessionId, body.world, updatedAt);
        dependencies.store.touchSession(sessionId, updatedAt);
        dependencies.store.createActionResultsEvent({
          id: actionResultsEventId(sessionId, body.results),
          sessionId,
          type: 'actions.results.recorded',
          payload: { results: body.results, world: body.world },
          createdAt: updatedAt,
        });
      });
    } catch (error) {
      if (!(error instanceof ActionResultDomainError)) {
        throw error;
      }
      if (error.kind === 'conflict') {
        throw new ApiError(
          409,
          'ACTION_RESULT_CONFLICT',
          'Action result conflicts with an existing result',
        );
      }
      throw new ApiError(
        422,
        'ACTION_RESULT_INVALID',
        'Action results do not match active actions',
      );
    }
    return reply.code(202).send(
      ActionResultsResponseSchema.parse({ accepted: body.results.length }),
    );
  });

  app.get('/api/sessions/:id/memories', async (request, reply) => {
    const sessionId = parseSessionId(request.params);
    requireSession(dependencies.store, sessionId);
    return reply.send(MemoriesResponseSchema.parse({
      memories: dependencies.store.listMemories(sessionId),
    }));
  });

  return app;
}

function defaultRequestAbortSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): AbortSignal {
  return createRequestAbortSignal(request.raw, reply.raw);
}

function parseSessionId(params: unknown): string {
  const parsed = SessionParamsSchema.safeParse(params);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }
  return parsed.data.id;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw validationError(parsed.error);
  }
  return parsed.data;
}

function validationError(error: z.ZodError): ApiError {
  return new ApiError(
    422,
    'VALIDATION_ERROR',
    'Request body is invalid',
    error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  );
}

function requireSession(store: ApiStore, sessionId: string): SessionRecord {
  const session = store.getSession(sessionId);
  if (session === undefined) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }
  return session;
}

function sendError(
  reply: FastifyReply,
  correlationId: string,
  statusCode: number,
  code: string,
  message: string,
  extras: {
    details?: readonly { path: string; message: string }[];
    retryAfterMs?: number;
  } = {},
): void {
  reply.code(statusCode).send(ErrorResponseSchema.parse({
    error: { code, message, correlationId, ...extras },
  }));
}

class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: readonly { path: string; message: string }[],
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();
  private nextSweepAt = 0;

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxEntries = 1_000,
  ) {
    validateRateLimit({ max, windowMs, maxEntries });
  }

  public get size(): number {
    return this.windows.size;
  }

  public consume(key: string, now: number):
    | { allowed: true }
    | { allowed: false; retryAfterMs: number } {
    if (this.nextSweepAt === 0) {
      this.nextSweepAt = now + this.windowMs;
    } else if (now >= this.nextSweepAt) {
      this.sweepExpired(now);
      this.nextSweepAt = now + this.windowMs;
    }
    const current = this.windows.get(key);
    if (current === undefined || now - current.startedAt >= this.windowMs) {
      this.ensureCapacity(now);
      this.windows.set(key, { count: 1, startedAt: now });
      return { allowed: true };
    }
    if (current.count >= this.max) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1, this.windowMs - (now - current.startedAt)),
      };
    }
    current.count += 1;
    return { allowed: true };
  }

  private ensureCapacity(now: number): void {
    if (this.windows.size < this.maxEntries) {
      return;
    }
    this.sweepExpired(now);
    while (this.windows.size >= this.maxEntries) {
      const oldestKey = this.windows.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        return;
      }
      this.windows.delete(oldestKey);
    }
  }

  private sweepExpired(now: number): void {
    for (const [key, window] of this.windows) {
      if (now - window.startedAt >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}

function validateRateLimit(rateLimit: {
  max: number;
  windowMs: number;
  maxEntries?: number;
}): void {
  if (!Number.isInteger(rateLimit.max) || rateLimit.max <= 0) {
    throw new Error('Rate limit max must be a positive integer');
  }
  if (!Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs <= 0) {
    throw new Error('Rate limit windowMs must be a positive integer');
  }
  if (
    rateLimit.maxEntries !== undefined
    && (!Number.isInteger(rateLimit.maxEntries) || rateLimit.maxEntries <= 0)
  ) {
    throw new Error('Rate limit maxEntries must be a positive integer');
  }
}

function actionResultsEventId(
  sessionId: string,
  results: readonly ActionResult[],
): string {
  const identity = results.map(canonicalActionResult);
  return `event-actions-${createHash('sha256')
    .update(JSON.stringify({ sessionId, results: identity }))
    .digest('hex')}`;
}

function canonicalActionResult(result: ActionResult): Record<string, unknown> {
  return {
    actionId: result.actionId,
    type: result.type,
    status: result.status,
    completedAt: new Date(result.completedAt).toISOString(),
    ...(result.message === undefined ? {} : { message: result.message }),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

function mapFastifyClientError(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const statusCode = error.statusCode;
  if (
    typeof statusCode !== 'number'
    || !Number.isInteger(statusCode)
    || statusCode < 400
    || statusCode > 499
  ) {
    return undefined;
  }
  const fastifyCode = 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  if (statusCode === 413 || fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' };
  }
  if (statusCode === 415 || fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Request media type is unsupported',
    };
  }
  if (fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY' || error instanceof SyntaxError) {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'Request JSON is invalid' };
  }
  return {
    statusCode,
    code: statusCode === 400 ? 'BAD_REQUEST' : 'REQUEST_REJECTED',
    message: 'Request was rejected',
  };
}
