import {
  TownPulseRequestSchema,
  TownPulseResponseSchema,
  type TownEvent,
  type TownIntent,
  type TownProjection,
  type TownPulseRequest,
  type TownPulseResponse,
} from '@cat-house/shared';
import { randomUUID } from 'node:crypto';

import type { StorageDatabase } from '../storage/database.js';
import {
  TownEventRepository,
  TownProjectionRepository,
  TownPulseRepository,
} from '../storage/repositories/index.js';
import type { AutonomyEventBuilder } from './autonomy-event-builder.js';
import { selectAutonomousResidents } from './autonomy-scheduler.js';
import { reduceTownEvent } from './event-reducer.js';
import { ResidentAgent } from './resident-agent.js';
import type { TownSimulationService } from './simulation-service.js';
import type { TownEventCommitter } from './town-event-committer.js';

const POLL_INTERVAL_MS = 50;
const LEASE_GRACE_MS = 5_000;
const RECENT_EVENT_WINDOW = 256;
const AGENT_EVENT_WINDOW = 8;

type ResidentAgentPort = Pick<ResidentAgent, 'decide' | 'respond' | 'followUp'>;
type SimulationPort = Pick<TownSimulationService, 'candidates'>;

export interface TownPulseServiceOptions {
  readonly residentAgent: ResidentAgentPort;
  readonly simulation: SimulationPort;
  readonly eventBuilder: AutonomyEventBuilder;
  readonly committer: TownEventCommitter;
  readonly createInitialProjection: (sessionId: string) => TownProjection;
  readonly now: () => string;
  readonly llmTimeoutMs: number;
  readonly nextLeaseId?: () => string;
}

type PreparedAction =
  | {
      readonly kind: 'visit';
      readonly residentId: string;
      readonly zoneId: Extract<TownIntent, { type: 'visit-zone' }>['zoneId'];
    }
  | {
      readonly kind: 'encounter';
      readonly initiatorId: string;
      readonly responderId: string;
      readonly opening: string;
      readonly reply: string;
      readonly followUp?: string;
      readonly animation: 'curious' | 'happy' | 'sit' | 'confused';
    };

interface ResidentOutcome {
  readonly residentId: string;
  readonly degraded: boolean;
  readonly action?: PreparedAction;
}

export class TownPulseService {
  readonly #pulses: TownPulseRepository;
  readonly #projections: TownProjectionRepository;
  readonly #events: TownEventRepository;
  readonly #inFlight = new Map<string, Promise<TownPulseResponse>>();
  readonly #residentTails = new Map<string, Promise<void>>();
  readonly #providerSlots = new Semaphore(2);
  readonly #fallbackAgent = new ResidentAgent();

  constructor(
    private readonly database: StorageDatabase,
    private readonly options: TownPulseServiceOptions,
  ) {
    if (!Number.isFinite(options.llmTimeoutMs) || options.llmTimeoutMs <= 0) {
      throw new TypeError('Town pulse LLM timeout must be positive');
    }
    this.#pulses = new TownPulseRepository(database);
    this.#projections = new TownProjectionRepository(database);
    this.#events = new TownEventRepository(database);
  }

  async pulse(
    source: TownPulseRequest,
    signal: AbortSignal,
  ): Promise<TownPulseResponse> {
    const request = TownPulseRequestSchema.parse(source);
    throwIfAborted(signal);

    for (;;) {
      const leaseToken =
        this.options.nextLeaseId?.() ?? `pulse-lease-${randomUUID()}`;
      const now = this.options.now();
      const leaseExpiresAt = new Date(
        Date.parse(now) + this.options.llmTimeoutMs + LEASE_GRACE_MS,
      ).toISOString();
      const claim = this.#pulses.claim({
        ...request,
        leaseToken,
        now,
        leaseExpiresAt,
      });

      if (claim.kind === 'complete') return claim.response;

      const key = `${request.sessionId}\0${request.pulseId}`;
      const local = this.#inFlight.get(key);
      if (claim.kind === 'in-flight') {
        if (local !== undefined) return await waitForPromise(local, signal);
        await abortableDelay(POLL_INTERVAL_MS, signal);
        continue;
      }

      const processing = this.#executeClaim(request, leaseToken, signal);
      this.#inFlight.set(key, processing);
      try {
        return await processing;
      } finally {
        if (this.#inFlight.get(key) === processing) this.#inFlight.delete(key);
      }
    }
  }

  async #executeClaim(
    request: TownPulseRequest,
    leaseToken: string,
    signal: AbortSignal,
  ): Promise<TownPulseResponse> {
    const projection = this.#loadOrCreate(request.sessionId);
    const recentEvents = this.#events.listAfter(
      request.sessionId,
      Math.max(0, projection.lastEventSequence - RECENT_EVENT_WINDOW),
      RECENT_EVENT_WINDOW,
    );

    if (projection.version !== request.baseVersion) {
      const stale = TownPulseResponseSchema.parse({
        status: 'stale',
        projection,
        events: [],
        degraded: false,
        degradedResidentIds: [],
      });
      this.database
        .transaction(() => {
          this.#pulses.complete(
            request.sessionId,
            request.pulseId,
            leaseToken,
            stale,
            this.options.now(),
          );
        })
        .immediate();
      return stale;
    }

    const nowMs = Date.parse(this.options.now());
    if (!Number.isFinite(nowMs))
      throw new TypeError('Town pulse clock is invalid');
    const residentIds = selectAutonomousResidents({
      projection,
      recentEvents,
      nowMs,
      limit: 2,
    });
    const outcomes = await Promise.all(
      residentIds.map((residentId) =>
        this.#prepareResident(
          request,
          residentId,
          projection,
          recentEvents.slice(-AGENT_EVENT_WINDOW),
          signal,
        ),
      ),
    );
    throwIfAborted(signal);

    const degradedResidentIds = new Set(
      outcomes
        .filter(({ degraded }) => degraded)
        .map(({ residentId }) => residentId),
    );
    let response: TownPulseResponse | undefined;
    const committed = this.options.committer.apply(
      request.sessionId,
      request.baseVersion,
      (current) =>
        this.#buildEvents(current, outcomes, (residentId) =>
          degradedResidentIds.add(residentId),
        ),
      (advanced) => {
        const degradedIds = [...degradedResidentIds];
        response = TownPulseResponseSchema.parse({
          ...advanced,
          degraded: degradedIds.length > 0,
          degradedResidentIds: degradedIds,
        });
        this.#pulses.complete(
          request.sessionId,
          request.pulseId,
          leaseToken,
          response,
          this.options.now(),
        );
      },
    );

    if (committed.status === 'stale') {
      const stale = TownPulseResponseSchema.parse({
        ...committed,
        degraded: false,
        degradedResidentIds: [],
      });
      this.database
        .transaction(() => {
          this.#pulses.complete(
            request.sessionId,
            request.pulseId,
            leaseToken,
            stale,
            this.options.now(),
          );
        })
        .immediate();
      return stale;
    }
    return response!;
  }

  async #prepareResident(
    request: TownPulseRequest,
    residentId: string,
    projection: TownProjection,
    recentEvents: readonly TownEvent[],
    signal: AbortSignal,
  ): Promise<ResidentOutcome> {
    const candidates = this.options.simulation
      .candidates(projection, residentId)
      .filter(
        (
          candidate,
        ): candidate is Extract<
          TownIntent,
          { type: 'socialize' | 'visit-zone' }
        > => candidate.type === 'socialize' || candidate.type === 'visit-zone',
      )
      .filter(
        (candidate) =>
          candidate.type !== 'socialize' ||
          this.options.eventBuilder.canEncounter(
            projection,
            residentId,
            candidate.targetResidentId,
          ),
      )
      .sort((left, right) =>
        candidateKey(left).localeCompare(candidateKey(right)),
      )
      .slice(0, 16);
    let callCount = 0;
    let degraded = false;

    const decision = await this.#callResident(
      residentId,
      signal,
      (callSignal) => {
        callCount += 1;
        return this.options.residentAgent.decide({
          residentId,
          candidates,
          projection,
          recentEvents,
          signal: callSignal,
          correlationId: `${request.pulseId}:${residentId}:decide`,
        });
      },
      () =>
        this.#fallbackAgent.decide({
          residentId,
          candidates,
          projection,
          recentEvents,
          signal,
          correlationId: `${request.pulseId}:${residentId}:decide-fallback`,
        }),
    );
    degraded ||= decision.degraded;
    if (decision.decision.kind === 'rest') return { residentId, degraded };

    const chosen = candidates[decision.decision.candidateIndex];
    if (chosen === undefined) return { residentId, degraded: true };
    if (chosen.type === 'visit-zone') {
      return {
        residentId,
        degraded,
        action: { kind: 'visit', residentId, zoneId: chosen.zoneId },
      };
    }

    const response = await this.#callResident(
      chosen.targetResidentId,
      signal,
      (callSignal) => {
        callCount += 1;
        return this.options.residentAgent.respond({
          residentId: chosen.targetResidentId,
          opening: decision.decision.speech,
          initiatorId: residentId,
          projection,
          recentEvents,
          signal: callSignal,
          correlationId: `${request.pulseId}:${chosen.targetResidentId}:respond`,
        });
      },
      () =>
        this.#fallbackAgent.respond({
          residentId: chosen.targetResidentId,
          opening: decision.decision.speech,
          initiatorId: residentId,
          projection,
          recentEvents,
          signal,
          correlationId: `${request.pulseId}:${chosen.targetResidentId}:respond-fallback`,
        }),
    );
    degraded ||= response.degraded;

    let followUp: string | undefined;
    if (response.reply.followUpRequested && callCount < 3) {
      const result = await this.#callResident(
        residentId,
        signal,
        (callSignal) => {
          callCount += 1;
          return this.options.residentAgent.followUp({
            residentId,
            opening: decision.decision.speech,
            reply: response.reply.speech,
            responderId: chosen.targetResidentId,
            projection,
            recentEvents,
            signal: callSignal,
            correlationId: `${request.pulseId}:${residentId}:follow-up`,
          });
        },
        () =>
          this.#fallbackAgent.followUp({
            residentId,
            opening: decision.decision.speech,
            reply: response.reply.speech,
            responderId: chosen.targetResidentId,
            projection,
            recentEvents,
            signal,
            correlationId: `${request.pulseId}:${residentId}:follow-up-fallback`,
          }),
      );
      degraded ||= result.degraded;
      followUp = result.reply.speech;
    }

    return {
      residentId,
      degraded,
      action: {
        kind: 'encounter',
        initiatorId: residentId,
        responderId: chosen.targetResidentId,
        opening: decision.decision.speech,
        reply: response.reply.speech,
        ...(followUp === undefined ? {} : { followUp }),
        animation: response.reply.animation,
      },
    };
  }

  async #callResident<T extends { readonly degraded: boolean }>(
    residentId: string,
    signal: AbortSignal,
    call: (signal: AbortSignal) => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.#serializeResident(residentId, async () => {
        const timeoutSignal = AbortSignal.timeout(this.options.llmTimeoutMs);
        return await call(AbortSignal.any([signal, timeoutSignal]));
      });
    } catch {
      throwIfAborted(signal);
      const result = await this.#serializeResident(residentId, fallback);
      return { ...result, degraded: true };
    }
  }

  async #serializeResident<T>(
    residentId: string,
    call: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#residentTails.get(residentId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        const release = await this.#providerSlots.acquire();
        try {
          return await call();
        } finally {
          release();
        }
      });
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#residentTails.set(residentId, settled);
    try {
      return await operation;
    } finally {
      if (this.#residentTails.get(residentId) === settled) {
        this.#residentTails.delete(residentId);
      }
    }
  }

  #buildEvents(
    source: TownProjection,
    outcomes: readonly ResidentOutcome[],
    markDegraded: (residentId: string) => void,
  ): readonly TownEvent[] {
    let projection = source;
    const events: TownEvent[] = [];
    for (const { action, residentId } of outcomes) {
      if (action === undefined) continue;
      if (
        action.kind === 'encounter' &&
        !this.options.eventBuilder.canEncounter(
          projection,
          action.initiatorId,
          action.responderId,
        )
      ) {
        markDegraded(residentId);
        continue;
      }
      const generated =
        action.kind === 'visit'
          ? this.options.eventBuilder.visit(projection, {
              residentId: action.residentId,
              zoneId: action.zoneId,
            })
          : this.options.eventBuilder.encounter(projection, {
              initiatorId: action.initiatorId,
              responderId: action.responderId,
              opening: action.opening,
              reply: action.reply,
              ...(action.followUp === undefined
                ? {}
                : { followUp: action.followUp }),
              animation: action.animation,
            });
      for (const event of generated) {
        events.push(event);
        projection = reduceTownEvent(projection, event);
      }
    }
    return events;
  }

  #loadOrCreate(sessionId: string): TownProjection {
    const stored = this.#projections.load(sessionId);
    if (stored !== undefined) return stored;
    const initial = this.options.createInitialProjection(sessionId);
    if (this.#projections.save(sessionId, -1, initial)) return initial;
    return this.#projections.load(sessionId)!;
  }
}

class Semaphore {
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.#active >= this.capacity) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
      this.#waiters.shift()?.();
    };
  }
}

function candidateKey(
  candidate: Extract<TownIntent, { type: 'socialize' | 'visit-zone' }>,
): string {
  return candidate.type === 'socialize'
    ? `socialize:${candidate.targetResidentId}`
    : `visit-zone:${candidate.zoneId}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new DOMException('The operation was aborted', 'AbortError');
}

function abortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForPromise<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
