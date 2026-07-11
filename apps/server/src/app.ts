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
  completeActionRun(sessionId: string, result: ActionResult, updatedAt: string): void;
  createActionResultsEvent(event: {
    id: string;
    sessionId: string;
    type: 'actions.results.recorded';
    payload: { results: readonly ActionResult[]; world: WorldSnapshot };
    createdAt: string;
  }): void;
}

export class ActionResultDomainError extends Error {
  public constructor(message: string) {
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
  readonly rateLimit?: { readonly max: number; readonly windowMs: number };
  readonly requestAbortSignal?: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => AbortSignal;
}

interface AbortEventSource {
  once(event: 'aborted' | 'close', listener: () => void): unknown;
  removeListener?(event: 'aborted' | 'close', listener: () => void): unknown;
  readonly aborted?: boolean;
  readonly writableEnded?: boolean;
}

export function createRequestAbortSignal(
  request: AbortEventSource,
  response?: AbortEventSource,
): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => {
    if (response?.writableEnded !== true) {
      controller.abort();
    }
  };
  if (request.aborted === true) {
    controller.abort();
    return controller.signal;
  }
  request.once('aborted', abort);
  response?.once('close', close);
  controller.signal.addEventListener('abort', () => {
    request.removeListener?.('aborted', abort);
    response?.removeListener?.('close', close);
  }, { once: true });
  return controller.signal;
}

export function buildApp(dependencies: BuildAppDependencies): FastifyInstance {
  const rateLimit = dependencies.rateLimit ?? { max: 8, windowMs: 60_000 };
  validateRateLimit(rateLimit);
  const limiter = new FixedWindowRateLimiter(rateLimit.max, rateLimit.windowMs);
  const activeTurns = new Set<string>();
  const app = Fastify({
    logger: false,
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
    const statusCode = 'statusCode' in error && error.statusCode === 400 ? 400 : 500;
    sendError(
      reply,
      request.id,
      statusCode,
      statusCode === 400 ? 'INVALID_JSON' : 'INTERNAL_ERROR',
      statusCode === 400 ? 'Request JSON is invalid' : 'The request could not be completed',
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
    const limit = limiter.consume(sessionId, Date.now());
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
        for (const result of body.results) {
          dependencies.store.completeActionRun(sessionId, result, updatedAt);
        }
        dependencies.store.upsertWorld(sessionId, body.world, updatedAt);
        dependencies.store.touchSession(sessionId, updatedAt);
        dependencies.store.createActionResultsEvent({
          id: dependencies.idFactory('event'),
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

class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; startedAt: number }>();

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  public consume(key: string, now: number):
    | { allowed: true }
    | { allowed: false; retryAfterMs: number } {
    const current = this.windows.get(key);
    if (current === undefined || now - current.startedAt >= this.windowMs) {
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
}

function validateRateLimit(rateLimit: { max: number; windowMs: number }): void {
  if (!Number.isInteger(rateLimit.max) || rateLimit.max <= 0) {
    throw new Error('Rate limit max must be a positive integer');
  }
  if (!Number.isInteger(rateLimit.windowMs) || rateLimit.windowMs <= 0) {
    throw new Error('Rate limit windowMs must be a positive integer');
  }
}
