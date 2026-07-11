import {
  ActionResultsRequestSchema,
  ActionResultsResponseSchema,
  AgentTurnRequestSchema,
  AgentTurnResponseSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  MemoriesResponseSchema,
  SessionResponseSchema,
  type ActionResult,
  type AgentDecision,
  type AgentTurnRequest,
  type AgentTurnResponse,
  type CreateSessionResponse,
  type MemoryRecord,
  type SessionResponse,
  type WorldSnapshot,
} from '@cat-house/shared';

import type { ActionRunner, CorrelatedActionResult } from '../actions/action-runner';
import { BubbleCoordinator, type BubbleCoordinatorOptions } from '../bubble-coordinator';
import type { GameEventBus } from '../events';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface AgentApiClientOptions {
  baseUrl?: string;
  fetcher?: Fetcher;
  resultRetryCount?: number;
}

export class AgentHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentHttpError';
  }
}

export class AgentApiClient {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;
  private readonly resultRetryCount: number;

  constructor(options: AgentApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.fetcher = options.fetcher ?? fetch;
    this.resultRetryCount = options.resultRetryCount ?? 2;
  }

  async createSession(signal?: AbortSignal): Promise<CreateSessionResponse> {
    const response = await this.fetcher(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: jsonHeaders,
      body: '{}',
      ...(signal === undefined ? {} : { signal }),
    });
    return CreateSessionResponseSchema.parse(await this.requireJson(response));
  }

  async loadSession(sessionId: string, signal?: AbortSignal): Promise<SessionResponse> {
    const response = await this.fetcher(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`,
      signal === undefined ? {} : { signal },
    );
    return SessionResponseSchema.parse(await this.requireJson(response));
  }

  async listMemories(sessionId: string, signal?: AbortSignal): Promise<readonly MemoryRecord[]> {
    const response = await this.fetcher(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/memories`,
      signal === undefined ? {} : { signal },
    );
    const payload = await this.requireJson(response);
    return MemoriesResponseSchema.parse(payload).memories;
  }

  async sendTurn(request: AgentTurnRequest, signal?: AbortSignal): Promise<AgentTurnResponse> {
    const validated = AgentTurnRequestSchema.parse(request);
    const { sessionId, ...body } = validated;
    const response = await this.fetcher(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/turns`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      },
    );
    const payload = await responseJson(response);
    const fallback = AgentTurnResponseSchema.safeParse(payload);
    if (response.status === 503 && fallback.success) return fallback.data;
    if (!response.ok) throw httpError(response.status, payload);
    return AgentTurnResponseSchema.parse(payload);
  }

  async postActionResult(
    sessionId: string,
    correlated: CorrelatedActionResult,
    world: WorldSnapshot,
    signal?: AbortSignal,
  ): Promise<void> {
    const delivery = ActionResultsRequestSchema.parse({
      turnCorrelationId: correlated.turnCorrelationId,
      world,
      results: [correlated.result],
    });
    const body = JSON.stringify(delivery);

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.fetcher(
          `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/action-results`,
          {
            method: 'POST',
            headers: jsonHeaders,
            body,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        const payload = await responseJson(response);
        if (!response.ok) throw httpError(response.status, payload);
        ActionResultsResponseSchema.parse(payload);
        return;
      } catch (error) {
        if (signal?.aborted || attempt >= this.resultRetryCount || !isRetryable(error)) throw error;
      }
    }
  }

  private async requireJson(response: Response): Promise<unknown> {
    const payload = await responseJson(response);
    if (!response.ok) throw httpError(response.status, payload);
    return payload;
  }
}

export interface AgentBridgeApi {
  createSession?(signal?: AbortSignal): Promise<CreateSessionResponse>;
  loadSession?(sessionId: string, signal?: AbortSignal): Promise<SessionResponse>;
  sendTurn(request: AgentTurnRequest, signal?: AbortSignal): Promise<AgentTurnResponse>;
  postActionResult(
    sessionId: string,
    result: CorrelatedActionResult,
    world: WorldSnapshot,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface AgentBridgeTurnOutcome {
  decision: AgentDecision;
  degraded: boolean;
  correlationId: string;
  source: 'server' | 'local';
  fallbackReason?: AgentTurnResponse['fallbackReason'] | 'network_error';
}

export interface AgentBridgeOptions {
  resultDeliveryTimeoutMs?: number;
  bubbleDurationMs?: (text: string) => number;
  bubbles?: BubbleCoordinator;
}

interface OperationToken {
  controller: AbortController;
  generation: number;
}

export class AgentBridge {
  private activeController: AbortController | undefined;
  private operationGeneration = 0;
  private sessionGeneration = 0;
  private activeSessionId: string | undefined;
  private readonly deliveredResults: ActionResult[] = [];
  private readonly executedDecisions = new Set<string>();
  private offlineSequence = 0;
  private readonly resultDeliveryTimeoutMs: number;
  private readonly bubbles: BubbleCoordinator;

  constructor(
    private readonly api: AgentBridgeApi,
    private readonly runner: ActionRunner,
    private readonly events: GameEventBus,
    private readonly getSnapshot: () => WorldSnapshot,
    options: AgentBridgeOptions = {},
  ) {
    this.resultDeliveryTimeoutMs = options.resultDeliveryTimeoutMs ?? 5_000;
    const bubbleOptions: BubbleCoordinatorOptions = options.bubbleDurationMs === undefined
      ? {}
      : { durationMs: options.bubbleDurationMs };
    this.bubbles = options.bubbles ?? new BubbleCoordinator(events, bubbleOptions);
  }

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  async createSession(): Promise<CreateSessionResponse> {
    if (!this.api.createSession) throw new Error('Session creation is unavailable');
    this.events.emit('connection-status', { status: 'connecting' });
    const operation = this.replaceActiveController();
    try {
      const response = await this.api.createSession(operation.controller.signal);
      this.assertOperationCurrent(operation);
      this.commitSession(response.session.id);
      this.assertOperationCurrent(operation);
      this.events.emit('connection-status', { status: 'ready' });
      return response;
    } catch (error) {
      if (!this.isOperationCurrent(operation)) throw staleOperationError();
      this.emitRequestError(error);
      throw error;
    } finally {
      this.finishOperation(operation);
    }
  }

  async loadSession(sessionId: string): Promise<SessionResponse> {
    if (!this.api.loadSession) throw new Error('Session loading is unavailable');
    this.events.emit('connection-status', { status: 'connecting' });
    const operation = this.replaceActiveController();
    try {
      const response = await this.api.loadSession(sessionId, operation.controller.signal);
      this.assertOperationCurrent(operation);
      this.commitSession(response.session.id);
      this.assertOperationCurrent(operation);
      this.events.emit('connection-status', { status: 'ready' });
      return response;
    } catch (error) {
      if (!this.isOperationCurrent(operation)) throw staleOperationError();
      this.emitRequestError(error);
      throw error;
    } finally {
      this.finishOperation(operation);
    }
  }

  replaceSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) return;
    this.invalidateOperation();
    this.commitSession(sessionId);
  }

  cancel(): void {
    this.invalidateOperation();
    this.events.emit('connection-status', { status: 'cancelled' });
  }

  async sendPlayerMessage(playerMessage: string): Promise<AgentBridgeTurnOutcome> {
    const sessionId = this.activeSessionId;
    if (!sessionId) throw new Error('No active session');
    const operation = this.replaceActiveController();
    const capturedSessionGeneration = this.sessionGeneration;
    this.events.emit('connection-status', { status: 'thinking' });
    const currentAction = this.runner.currentAction;
    const request = AgentTurnRequestSchema.parse({
      sessionId,
      playerMessage,
      world: this.getSnapshot(),
      ...(currentAction === undefined ? {} : { currentAction }),
      recentActionResults: this.deliveredResults.slice(-12),
    });
    let responseReceived = false;
    let resultDeliveryFailed = false;

    try {
      const response = await this.api.sendTurn(request, operation.controller.signal);
      this.assertOwnership(operation, capturedSessionGeneration);
      responseReceived = true;
      this.bubbles.showDecision(response.correlationId, response.decision.speech, response.decision.thought);
      this.events.emit('connection-status', {
        status: response.degraded ? 'provider-error' : 'acting',
        ...(response.fallbackReason === undefined ? {} : { message: response.fallbackReason }),
      });
      const decisionKey = `${response.correlationId}:${stableDecision(response.decision)}`;
      if (!this.executedDecisions.has(decisionKey)) {
        this.executedDecisions.add(decisionKey);
        this.assertOwnership(operation, capturedSessionGeneration);
        await this.runner.run(response.decision, response.correlationId, {
          signal: operation.controller.signal,
          onResult: async (result, snapshot) => {
            if (this.sessionGeneration === capturedSessionGeneration) {
              this.deliveredResults.push(result.result);
              if (this.deliveredResults.length > 12) this.deliveredResults.shift();
            }
            const delivered = await this.deliverResult(
              sessionId,
              result,
              snapshot,
              operation,
              capturedSessionGeneration,
            );
            if (!this.hasOwnership(operation, capturedSessionGeneration)) return;
            if (!delivered) {
              resultDeliveryFailed = true;
            }
          },
        });
        this.assertOwnership(operation, capturedSessionGeneration);
      }
      this.assertOwnership(operation, capturedSessionGeneration);
      if (!response.degraded && !resultDeliveryFailed) {
        this.events.emit('connection-status', { status: 'ready' });
      }
      return { ...response, source: 'server' };
    } catch (error) {
      if (!this.hasOwnership(operation, capturedSessionGeneration)) {
        throw staleOperationError();
      }
      this.emitRequestError(error);
      if (!responseReceived && isNetworkError(error)) {
        const fallback = this.localOfflineFallback();
        this.bubbles.showDecision(fallback.correlationId, fallback.decision.speech, fallback.decision.thought);
        await this.runner.run(fallback.decision, fallback.correlationId, {
          signal: operation.controller.signal,
        });
        this.assertOwnership(operation, capturedSessionGeneration);
        return fallback;
      }
      throw error;
    } finally {
      this.finishOperation(operation);
    }
  }

  private replaceActiveController(): OperationToken {
    this.bubbles.reset();
    this.activeController?.abort();
    this.runner.cancel();
    const controller = new AbortController();
    this.operationGeneration += 1;
    this.activeController = controller;
    return { controller, generation: this.operationGeneration };
  }

  private emitRequestError(error: unknown): void {
    if (isAbortError(error)) {
      this.events.emit('connection-status', { status: 'cancelled' });
      return;
    }
    this.events.emit('connection-status', {
      status: error instanceof AgentHttpError ? 'provider-error' : 'offline',
      message: error instanceof Error ? error.message : 'Request failed',
    });
  }

  private async deliverResult(
    sessionId: string,
    result: CorrelatedActionResult,
    snapshot: WorldSnapshot,
    operation: OperationToken,
    capturedSessionGeneration: number,
  ): Promise<boolean> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('Action result delivery timed out'));
      }, this.resultDeliveryTimeoutMs);
    });

    try {
      await Promise.race([
        this.api.postActionResult(sessionId, result, snapshot, controller.signal),
        timeout,
      ]);
      return true;
    } catch (error) {
      if (!this.hasOwnership(operation, capturedSessionGeneration)) return false;
      if (timedOut) {
        this.events.emit('connection-status', {
          status: 'offline',
          message: 'Action result delivery timed out',
        });
      } else {
        this.emitRequestError(error);
      }
      return false;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  private commitSession(sessionId: string): void {
    this.sessionGeneration += 1;
    this.activeSessionId = sessionId;
    this.deliveredResults.length = 0;
    this.executedDecisions.clear();
  }

  private invalidateOperation(): void {
    this.bubbles.reset();
    this.activeController?.abort();
    this.activeController = undefined;
    this.operationGeneration += 1;
    this.runner.cancel();
  }

  private finishOperation(operation: OperationToken): void {
    if (this.isOperationCurrent(operation)) this.activeController = undefined;
  }

  private isOperationCurrent(operation: OperationToken): boolean {
    return (
      this.activeController === operation.controller &&
      this.operationGeneration === operation.generation &&
      !operation.controller.signal.aborted
    );
  }

  private hasOwnership(operation: OperationToken, capturedSessionGeneration: number): boolean {
    return (
      this.isOperationCurrent(operation) &&
      this.sessionGeneration === capturedSessionGeneration
    );
  }

  private assertOperationCurrent(operation: OperationToken): void {
    if (!this.isOperationCurrent(operation)) throw staleOperationError();
  }

  private assertOwnership(operation: OperationToken, capturedSessionGeneration: number): void {
    if (!this.hasOwnership(operation, capturedSessionGeneration)) throw staleOperationError();
  }

  private localOfflineFallback(): AgentBridgeTurnOutcome {
    this.offlineSequence += 1;
    return {
      decision: {
        speech: "I can't reach the server, but I'll stay here with you.",
        thought: 'The room is still safe and playable offline.',
        emotion: 'confused',
        actions: [],
      },
      degraded: true,
      correlationId: `local-offline-${this.offlineSequence}`,
      source: 'local',
      fallbackReason: 'network_error',
    };
  }
}

const jsonHeaders = { 'content-type': 'application/json' } as const;

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AgentHttpError(response.status, 'INVALID_RESPONSE', 'Server returned invalid JSON');
  }
}

function httpError(status: number, payload: unknown): AgentHttpError {
  const parsed = ErrorResponseSchema.safeParse(payload);
  if (parsed.success) {
    return new AgentHttpError(status, parsed.data.error.code, parsed.data.error.message);
  }
  return new AgentHttpError(status, 'HTTP_ERROR', `Request failed with status ${status}`);
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof AgentHttpError) || error.status >= 500;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function staleOperationError(): DOMException {
  return new DOMException('Operation superseded', 'AbortError');
}

function stableDecision(decision: AgentTurnResponse['decision']): string {
  return JSON.stringify(decision);
}
