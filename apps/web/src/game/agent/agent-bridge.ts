import {
  ActionResultsRequestSchema,
  ActionResultsResponseSchema,
  AgentTurnRequestSchema,
  AgentTurnResponseSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  SessionResponseSchema,
  type ActionResult,
  type AgentTurnRequest,
  type AgentTurnResponse,
  type CreateSessionResponse,
  type SessionResponse,
  type WorldSnapshot,
} from '@cat-house/shared';

import type { ActionRunner, CorrelatedActionResult } from '../actions/action-runner';
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

export class AgentBridge {
  private activeController: AbortController | undefined;
  private activeSessionId: string | undefined;
  private readonly deliveredResults: ActionResult[] = [];
  private readonly executedDecisions = new Set<string>();

  constructor(
    private readonly api: AgentBridgeApi,
    private readonly runner: ActionRunner,
    private readonly events: GameEventBus,
    private readonly getSnapshot: () => WorldSnapshot,
  ) {}

  get sessionId(): string | undefined {
    return this.activeSessionId;
  }

  async createSession(): Promise<CreateSessionResponse> {
    if (!this.api.createSession) throw new Error('Session creation is unavailable');
    this.events.emit('connection-status', { status: 'connecting' });
    const controller = this.replaceActiveController();
    try {
      const response = await this.api.createSession(controller.signal);
      this.replaceSession(response.session.id);
      this.events.emit('connection-status', { status: 'ready' });
      return response;
    } catch (error) {
      this.emitRequestError(error);
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  async loadSession(sessionId: string): Promise<SessionResponse> {
    if (!this.api.loadSession) throw new Error('Session loading is unavailable');
    this.events.emit('connection-status', { status: 'connecting' });
    const controller = this.replaceActiveController();
    try {
      const response = await this.api.loadSession(sessionId, controller.signal);
      this.replaceSession(response.session.id);
      this.events.emit('connection-status', { status: 'ready' });
      return response;
    } catch (error) {
      this.emitRequestError(error);
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  replaceSession(sessionId: string): void {
    if (this.activeSessionId === sessionId) return;
    this.activeController?.abort();
    this.activeController = undefined;
    this.runner.cancel();
    this.activeSessionId = sessionId;
    this.deliveredResults.length = 0;
    this.executedDecisions.clear();
  }

  cancel(): void {
    this.activeController?.abort();
    this.runner.cancel();
    this.events.emit('connection-status', { status: 'cancelled' });
  }

  async sendPlayerMessage(playerMessage: string): Promise<AgentTurnResponse> {
    const sessionId = this.activeSessionId;
    if (!sessionId) throw new Error('No active session');
    const controller = this.replaceActiveController();
    this.events.emit('connection-status', { status: 'thinking' });
    const currentAction = this.runner.currentAction;
    const request = AgentTurnRequestSchema.parse({
      sessionId,
      playerMessage,
      world: this.getSnapshot(),
      ...(currentAction === undefined ? {} : { currentAction }),
      recentActionResults: this.deliveredResults.slice(-12),
    });

    try {
      const response = await this.api.sendTurn(request, controller.signal);
      this.events.emit('bubble-changed', { kind: 'speech', text: response.decision.speech });
      if (response.decision.thought) {
        this.events.emit('bubble-changed', { kind: 'thought', text: response.decision.thought });
      }
      this.events.emit('connection-status', {
        status: response.degraded ? 'provider-error' : 'acting',
        ...(response.fallbackReason === undefined ? {} : { message: response.fallbackReason }),
      });
      const decisionKey = `${response.correlationId}:${stableDecision(response.decision)}`;
      if (!this.executedDecisions.has(decisionKey)) {
        this.executedDecisions.add(decisionKey);
        await this.runner.run(response.decision, response.correlationId, {
          signal: controller.signal,
          onResult: async (result, snapshot) => {
            this.deliveredResults.push(result.result);
            if (this.deliveredResults.length > 12) this.deliveredResults.shift();
            try {
              await this.api.postActionResult(sessionId, result, snapshot, controller.signal);
            } catch (error) {
              this.emitRequestError(error);
            }
          },
        });
      }
      if (!response.degraded && !controller.signal.aborted) {
        this.events.emit('connection-status', { status: 'ready' });
      }
      return response;
    } catch (error) {
      this.emitRequestError(error);
      throw error;
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private replaceActiveController(): AbortController {
    this.activeController?.abort();
    this.runner.cancel();
    const controller = new AbortController();
    this.activeController = controller;
    return controller;
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

function stableDecision(decision: AgentTurnResponse['decision']): string {
  return JSON.stringify(decision);
}
