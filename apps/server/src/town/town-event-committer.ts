import {
  TownAdvanceResponseSchema,
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';

import type { StorageDatabase } from '../storage/database.js';
import {
  TownEventRepository,
  TownProjectionRepository,
} from '../storage/repositories/index.js';
import { reduceTownEvent } from './event-reducer.js';

type AdvancedTownCommitResult = {
  status: 'advanced';
  projection: TownProjection;
  events: TownEvent[];
};

type TownCommitResult =
  | AdvancedTownCommitResult
  | {
      status: 'stale';
      projection: TownProjection;
      events: [];
    };

type SynchronousTownEventFactory = (
  projection: TownProjection,
) => readonly TownEvent[];

type TownCommitCompletionHook = (result: AdvancedTownCommitResult) => void;

export class TownEventCommitError extends Error {
  constructor(
    readonly kind: 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TownEventCommitError';
  }
}

export class TownEventCommitter {
  readonly #events: TownEventRepository;
  readonly #projections: TownProjectionRepository;

  constructor(
    private readonly database: StorageDatabase,
    private readonly createInitialProjection: (
      sessionId: string,
    ) => TownProjection,
  ) {
    this.#events = new TownEventRepository(database);
    this.#projections = new TownProjectionRepository(database);
  }

  apply(
    sessionId: string,
    baseVersion: number,
    eventFactory: SynchronousTownEventFactory,
    completionHook?: TownCommitCompletionHook,
  ): TownCommitResult {
    return this.database
      .transaction(() => {
        let projection = this.#loadOrCreate(sessionId);
        if (projection.version !== baseVersion) {
          return {
            status: 'stale' as const,
            projection: TownProjectionSchema.parse(projection),
            events: [] as [],
          };
        }

        const generated = eventFactory(
          TownProjectionSchema.parse(structuredClone(projection)),
        );
        if (!Array.isArray(generated)) {
          throw new TypeError(
            'Town event factory must return events synchronously',
          );
        }
        if (generated.length > 24) {
          throw new Error('Town event factory returned more than 24 events');
        }
        const events = generated.map((event) => TownEventSchema.parse(event));

        for (const event of events) {
          this.#validateNextEvent(sessionId, projection, event);
          this.#events.append(event);
          const next = reduceTownEvent(projection, event);
          if (!this.#projections.save(sessionId, projection.version, next)) {
            throw new TownEventCommitError(
              'conflict',
              'Town projection changed concurrently',
            );
          }
          projection = next;
        }

        const parsed = TownAdvanceResponseSchema.parse({ projection, events });
        const result: AdvancedTownCommitResult = {
          status: 'advanced',
          ...parsed,
        };
        const completion = completionHook?.(result);
        if (isPromiseLike(completion)) {
          throw new TypeError('Town commit hook must complete synchronously');
        }
        return result;
      })
      .immediate();
  }

  #loadOrCreate(sessionId: string): TownProjection {
    const stored = this.#projections.load(sessionId);
    if (stored !== undefined) return stored;
    const initial = TownProjectionSchema.parse(
      this.createInitialProjection(sessionId),
    );
    if (initial.sessionId !== sessionId) {
      throw new Error('Initial town projection session does not match');
    }
    if (this.#projections.save(sessionId, -1, initial)) return initial;
    return this.#projections.load(sessionId)!;
  }

  #validateNextEvent(
    sessionId: string,
    projection: TownProjection,
    event: TownEvent,
  ): void {
    if (event.sessionId !== sessionId) {
      throw new Error('Town event session does not match commit session');
    }
    if (event.sequence !== projection.lastEventSequence + 1) {
      throw new Error('Town event sequence is not contiguous');
    }
    if (event.baseVersion !== projection.version) {
      throw new Error('Town event base version is not contiguous');
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  );
}
