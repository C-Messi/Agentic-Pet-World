import {
  AgentDecisionSchema,
  type AgentDecision,
  type AgentTurnRequest,
  type MemoryRecord,
  type MessageRecord,
  type WorldSnapshot,
} from '@cat-house/shared';

import type { EventRecord } from '../storage/types.js';
import type { BuiltContext, ContextService } from './context-service.js';
import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCompletionRequest,
  type UntrustedProviderContext,
} from './provider.js';

const MEMORY_IMPORTANCE_THRESHOLD = 0.7;
const MAX_RETRY_DELAY_MS = 2_000;

export type AgentFallbackReason =
  | 'cancelled'
  | 'invalid_output'
  | 'provider_failure'
  | 'provider_unavailable'
  | 'timeout'
  | 'unsafe_target';

export type AgentTurnEventPayload =
  | {
      readonly phase: 'started';
      readonly correlationId: string;
      readonly playerMessageId: string;
    }
  | {
      readonly phase: 'completed';
      readonly correlationId: string;
      readonly agentMessageId: string;
      readonly usedFallback: boolean;
      readonly actionCount: number;
      readonly fallbackReason?: AgentFallbackReason;
    };

interface MessageWriter {
  create(record: MessageRecord): void;
}

interface MemoryWriter {
  create(record: MemoryRecord): void;
}

interface EventWriter {
  create(record: EventRecord<AgentTurnEventPayload>): void;
}

export interface AgentServiceDependencies {
  readonly contextService: Pick<ContextService, 'build'>;
  readonly provider?: ProviderAdapter;
  readonly messages: MessageWriter;
  readonly memories: MemoryWriter;
  readonly events: EventWriter;
  readonly clock: () => string;
  readonly idFactory: (prefix: 'correlation' | 'event' | 'memory' | 'message') => string;
  readonly retryDelayMs?: number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface AgentTurnOptions {
  readonly signal?: AbortSignal;
}

export class AgentService {
  private readonly retryDelayMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;

  public constructor(private readonly dependencies: AgentServiceDependencies) {
    const configuredDelay = dependencies.retryDelayMs ?? 100;
    this.retryDelayMs = Math.max(0, Math.min(MAX_RETRY_DELAY_MS, configuredDelay));
    this.sleep = dependencies.sleep ?? sleepWithCancellation;
  }

  public async turn(
    request: AgentTurnRequest,
    options: AgentTurnOptions = {},
  ): Promise<AgentDecision> {
    const signal = options.signal ?? new AbortController().signal;
    const correlationId = this.dependencies.idFactory('correlation');
    const playerMessageId = this.dependencies.idFactory('message');
    let context: BuiltContext | undefined;
    try {
      context = this.dependencies.contextService.build({
        sessionId: request.sessionId,
        worldSnapshot: request.world,
      });
    } catch {
      context = undefined;
    }

    this.dependencies.messages.create({
      id: playerMessageId,
      sessionId: request.sessionId,
      role: 'player',
      content: request.playerMessage,
      createdAt: this.dependencies.clock(),
    });
    this.dependencies.events.create({
      id: this.dependencies.idFactory('event'),
      sessionId: request.sessionId,
      type: 'agent.turn.started',
      payload: { phase: 'started', correlationId, playerMessageId },
      createdAt: this.dependencies.clock(),
    });

    const outcome = await this.decide(request, context, correlationId, signal);
    const decision = outcome.decision;
    const agentMessageId = this.dependencies.idFactory('message');
    const createdAt = this.dependencies.clock();

    this.dependencies.messages.create({
      id: agentMessageId,
      sessionId: request.sessionId,
      role: 'agent',
      content: decision.speech,
      createdAt,
    });
    for (const candidate of decision.memoryCandidates ?? []) {
      this.dependencies.memories.create({
        id: this.dependencies.idFactory('memory'),
        sessionId: request.sessionId,
        content: candidate.content,
        importance: candidate.importance,
        sourceMessageId: agentMessageId,
        createdAt,
        updatedAt: createdAt,
      });
    }
    this.dependencies.events.create({
      id: this.dependencies.idFactory('event'),
      sessionId: request.sessionId,
      type: 'agent.turn.completed',
      payload: {
        phase: 'completed',
        correlationId,
        agentMessageId,
        usedFallback: outcome.fallbackReason !== undefined,
        actionCount: decision.actions.length,
        ...(outcome.fallbackReason === undefined
          ? {}
          : { fallbackReason: outcome.fallbackReason }),
      },
      createdAt,
    });
    return decision;
  }

  private async decide(
    request: AgentTurnRequest,
    context: BuiltContext | undefined,
    correlationId: string,
    signal: AbortSignal,
  ): Promise<DecisionOutcome> {
    if (context === undefined || this.dependencies.provider === undefined) {
      return fallback('provider_unavailable');
    }

    const providerRequest = buildProviderRequest(
      request,
      context,
      correlationId,
      signal,
    );
    let output: unknown;
    try {
      output = await this.completeWithRetry(providerRequest);
    } catch (error) {
      return fallback(mapProviderFailure(error));
    }

    const structuredOutput = parsePossibleJson(output);
    const parsed = AgentDecisionSchema.safeParse(structuredOutput);
    if (!parsed.success) {
      return fallback('invalid_output');
    }
    if (!targetsAreSafe(parsed.data, request.world)) {
      return fallback('unsafe_target');
    }

    const acceptedCandidates = (parsed.data.memoryCandidates ?? []).filter(
      (candidate) => candidate.importance >= MEMORY_IMPORTANCE_THRESHOLD,
    );
    return {
      decision: {
        ...parsed.data,
        ...(parsed.data.memoryCandidates === undefined
          ? {}
          : { memoryCandidates: acceptedCandidates }),
      },
    };
  }

  private async completeWithRetry(request: ProviderCompletionRequest): Promise<unknown> {
    const provider = this.dependencies.provider;
    if (provider === undefined) {
      throw new ProviderError('configuration', {
        correlationId: request.correlationId,
      });
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await provider.complete(request);
      } catch (error) {
        const mayRetry =
          attempt === 0 && error instanceof ProviderError && error.retryable;
        if (!mayRetry) {
          throw error;
        }
        if (request.signal.aborted) {
          throw new ProviderError('cancelled', {
            correlationId: request.correlationId,
          });
        }
        await this.sleep(this.retryDelayMs, request.signal);
      }
    }
    throw new ProviderError('request_failed', {
      correlationId: request.correlationId,
    });
  }
}

interface DecisionOutcome {
  readonly decision: AgentDecision;
  readonly fallbackReason?: AgentFallbackReason;
}

function buildProviderRequest(
  request: AgentTurnRequest,
  context: BuiltContext,
  correlationId: string,
  signal: AbortSignal,
): ProviderCompletionRequest {
  const trustedInstructions: string[] = [];
  const untrustedContext: UntrustedProviderContext[] = [];
  for (const section of context.sections) {
    if (section.trustLevel === 'untrusted') {
      if (section.kind === 'memories' || section.kind === 'messages') {
        untrustedContext.push({ source: section.kind, content: section.content });
      }
      continue;
    }
    trustedInstructions.push(section.rendered);
  }
  return {
    trustedInstructions,
    untrustedContext,
    messages: [{ role: 'user', content: request.playerMessage }],
    signal,
    correlationId,
  };
}

function parsePossibleJson(output: unknown): unknown {
  if (typeof output !== 'string') {
    return output;
  }
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return undefined;
  }
}

function targetsAreSafe(decision: AgentDecision, world: WorldSnapshot): boolean {
  const objects = new Map(world.objects.map((object) => [object.id, object]));
  for (const action of decision.actions) {
    if (action.type !== 'move_to' && action.type !== 'interact') {
      continue;
    }
    const target = objects.get(action.targetId);
    if (target === undefined || !target.available) {
      return false;
    }
    if (action.type === 'interact' && !target.interactions.includes(action.interaction)) {
      return false;
    }
  }
  return true;
}

function mapProviderFailure(error: unknown): AgentFallbackReason {
  if (!(error instanceof ProviderError)) {
    return 'provider_failure';
  }
  switch (error.code) {
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    case 'invalid_output':
      return 'invalid_output';
    case 'configuration':
      return 'provider_unavailable';
    case 'rate_limited':
    case 'request_failed':
    case 'server_error':
      return 'provider_failure';
  }
}

function fallback(reason: AgentFallbackReason): DecisionOutcome {
  return {
    fallbackReason: reason,
    decision: {
      speech: 'I lost the thread for a moment, but I am still here with you.',
      emotion: reason === 'cancelled' ? 'idle' : 'confused',
      actions: [],
    },
  };
}

async function sleepWithCancellation(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError('cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      reject(new ProviderError('cancelled'));
    };
    signal.addEventListener('abort', cancel, { once: true });
  });
}
