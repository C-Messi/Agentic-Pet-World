import {
  IdentifierSchema,
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { z } from 'zod';

import { reduceTownEvent } from './event-reducer.js';

export interface OfflineRecoveryInput {
  sessionId: string;
  recoveryWindowId: string;
  lastConfirmedAt: string;
  resumedAt: string;
  projection: Readonly<TownProjection>;
}
export interface OfflineRecoveryResult {
  startVersion: number;
  events: readonly TownEvent[];
  finalProjection: TownProjection;
}
export interface OfflineRecoverySimulation {
  candidates(
    projection: Readonly<TownProjection>,
    residentId: string,
  ): readonly TownIntent[];
  select(
    projection: Readonly<TownProjection>,
    residentId: string,
  ): TownIntent | undefined;
  createEvents(
    projection: Readonly<TownProjection>,
    intent: TownIntent,
  ): readonly TownEvent[];
}
export interface OfflineRecoveryStore {
  claimRecoveryWindow(
    sessionId: string,
    recoveryWindowId: string,
    basis: Readonly<{
      lastConfirmedAt: string;
      resumedAt: string;
      startVersion: number;
    }>,
  ): { claimed: boolean };
  loadRecoveryResult(
    sessionId: string,
    recoveryWindowId: string,
  ): OfflineRecoveryResult | undefined;
  saveRecoveryResult(
    sessionId: string,
    recoveryWindowId: string,
    result: OfflineRecoveryResult,
  ): void;
}

export class OfflineRecoveryConflictError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'OfflineRecoveryConflictError';
  }
}

const InputSchema = z
  .object({
    sessionId: IdentifierSchema,
    recoveryWindowId: IdentifierSchema,
    lastConfirmedAt: z.string().datetime({ offset: true }),
    resumedAt: z.string().datetime({ offset: true }),
    projection: TownProjectionSchema,
  })
  .strict();
const ResultSchema = z
  .object({
    startVersion: z.number().int().nonnegative(),
    events: z.array(TownEventSchema).max(5),
    finalProjection: TownProjectionSchema,
  })
  .strict();

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function resultClone(value: OfflineRecoveryResult): OfflineRecoveryResult {
  return freeze(ResultSchema.parse(structuredClone(value)));
}

export class OfflineRecoveryService {
  constructor(
    private readonly simulation: OfflineRecoverySimulation,
    private readonly store: OfflineRecoveryStore,
  ) {}

  recover(source: OfflineRecoveryInput): OfflineRecoveryResult {
    const input = InputSchema.parse(structuredClone(source));
    if (input.projection.sessionId !== input.sessionId)
      throw new Error('Recovery projection session does not match');
    const start = Date.parse(input.lastConfirmedAt);
    const end = Date.parse(input.resumedAt);
    if (end < start)
      throw new Error('Recovery resumedAt precedes lastConfirmedAt');
    const basis = {
      lastConfirmedAt: input.lastConfirmedAt,
      resumedAt: input.resumedAt,
      startVersion: input.projection.version,
    } as const;
    let claim: { claimed: boolean };
    try {
      claim = this.store.claimRecoveryWindow(
        input.sessionId,
        input.recoveryWindowId,
        basis,
      );
    } catch (error) {
      throw new OfflineRecoveryConflictError(
        'Offline recovery window conflicts with its existing claim',
        error,
      );
    }
    if (!claim.claimed) {
      const saved = this.store.loadRecoveryResult(
        input.sessionId,
        input.recoveryWindowId,
      );
      if (saved === undefined)
        throw new OfflineRecoveryConflictError(
          'Offline recovery window is claimed without a result',
        );
      return resultClone(saved);
    }
    const absentMs = end - start;
    const slots =
      absentMs < 5 * 60_000
        ? 0
        : Math.min(5, Math.floor(absentMs / (30 * 60_000)));
    let state = input.projection;
    const events: TownEvent[] = [];
    let built = false;
    const playerId = state.residents.find(
      ({ pet }) => pet.source === 'player-pet',
    )!.residentId;
    for (
      let attempt = 0;
      events.length < slots && attempt < slots * 4;
      attempt++
    ) {
      const candidates = this.simulation
        .candidates(state, playerId)
        .filter(
          (intent) =>
            intent.type !== 'open-stall' && (!built || intent.type !== 'build'),
        );
      if (candidates.length === 0) break;
      const intent = this.simulation.select(state, playerId);
      if (
        intent === undefined ||
        !candidates.some(
          (candidate) => JSON.stringify(candidate) === JSON.stringify(intent),
        )
      ) {
        continue;
      }
      try {
        const generated = this.simulation.createEvents(state, intent);
        for (const raw of generated) {
          if (events.length >= slots) break;
          const event = TownEventSchema.parse(structuredClone(raw));
          if (
            event.type === 'stall.opened' ||
            (event.type === 'build.completed' && built)
          )
            continue;
          if (
            event.sessionId !== input.sessionId ||
            event.baseVersion !== state.version ||
            event.sequence !== state.lastEventSequence + 1
          )
            continue;
          const eventTime = Date.parse(event.timestamp);
          if (eventTime < start || eventTime > end) continue;
          if (
            events.length > 0 &&
            eventTime < Date.parse(events.at(-1)!.timestamp)
          )
            continue;
          state = reduceTownEvent(state, event);
          events.push(event);
          if (event.type === 'build.completed') built = true;
        }
      } catch {
        /* An invalid candidate consumes only a bounded attempt. */
      }
    }
    const result = resultClone({
      startVersion: input.projection.version,
      events,
      finalProjection: TownProjectionSchema.parse(state),
    });
    this.store.saveRecoveryResult(
      input.sessionId,
      input.recoveryWindowId,
      result,
    );
    return result;
  }
}
