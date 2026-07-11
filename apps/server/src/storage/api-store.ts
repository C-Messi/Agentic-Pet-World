import { createHash } from 'node:crypto';

import {
  ActionResultSchema,
  WorldSnapshotSchema,
  type ActionResult,
  type AgentAction,
  type MemoryRecord,
  type MessageRecord,
  type SessionRecord,
  type WorldSnapshot,
} from '@cat-house/shared';
import { z } from 'zod';

import { ActionResultDomainError, type ApiStore } from '../app.js';
import type { StorageDatabase } from './database.js';
import {
  ActionRunRepository,
  EventRepository,
  MemoryRepository,
  MessageRepository,
  SessionRepository,
  WorldStateRepository,
} from './repositories/index.js';
import {
  canonicalizeWorldSnapshot,
  worldSnapshotHash,
} from '../world-identity.js';

const ActionResultsEventPayloadSchema = z
  .object({
    turnCorrelationId: z.string().min(1).max(96),
    results: z.array(ActionResultSchema).min(1).max(12),
    world: WorldSnapshotSchema,
  })
  .strict();
type ActionResultsEventPayload = z.infer<typeof ActionResultsEventPayloadSchema>;

export class StorageApiStore implements ApiStore {
  private readonly sessions: SessionRepository;
  private readonly worlds: WorldStateRepository;
  private readonly messages: MessageRepository;
  private readonly memories: MemoryRepository;
  private readonly actionRuns: ActionRunRepository;
  private readonly events: EventRepository<ActionResultsEventPayload>;

  public constructor(private readonly database: StorageDatabase) {
    this.sessions = new SessionRepository(database);
    this.worlds = new WorldStateRepository(database);
    this.messages = new MessageRepository(database);
    this.memories = new MemoryRepository(database);
    this.actionRuns = new ActionRunRepository(database);
    this.events = new EventRepository(database, ActionResultsEventPayloadSchema);
  }

  public runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  public createSession(record: SessionRecord): void {
    this.sessions.create(record);
  }

  public getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }

  public touchSession(id: string, updatedAt: string): void {
    this.sessions.touch(id, updatedAt);
  }

  public getWorld(sessionId: string) {
    return this.worlds.get(sessionId);
  }

  public upsertWorld(
    sessionId: string,
    snapshot: WorldSnapshot,
    updatedAt: string,
  ): void {
    this.worlds.upsert(sessionId, snapshot, updatedAt);
  }

  public listMessages(sessionId: string): readonly MessageRecord[] {
    return this.messages.listForSession(sessionId);
  }

  public listMemories(sessionId: string): readonly MemoryRecord[] {
    return this.memories.listForSession(sessionId);
  }

  public createActionRun(
    sessionId: string,
    action: AgentAction,
    turnCorrelationId: string,
    createdAt: string,
  ): void {
    const id = actionRunId(sessionId, turnCorrelationId, action.id);
    if (this.actionRuns.get(id) !== undefined) {
      return;
    }
    this.actionRuns.create({
      id,
      sessionId,
      turnCorrelationId,
      action,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    });
  }

  public completeActionRun(
    sessionId: string,
    turnCorrelationId: string,
    result: ActionResult,
    world: WorldSnapshot,
    updatedAt: string,
  ): boolean {
    const id = actionRunId(sessionId, turnCorrelationId, result.actionId);
    const run = this.actionRuns.get(id);
    if (run === undefined) {
      throw new ActionResultDomainError(
        'not_found',
        `Active action run not found: ${result.actionId}`,
      );
    }
    const resultWorldHash = worldSnapshotHash(world);
    if (run.result !== undefined) {
      if (
        actionResultsEqual(run.result, result)
        && run.resultWorldHash === resultWorldHash
      ) {
        return false;
      }
      throw new ActionResultDomainError(
        'conflict',
        `Action result conflicts with completed run: ${result.actionId}`,
      );
    }
    if (run.action.type !== result.type) {
      throw new ActionResultDomainError(
        'conflict',
        `Action result type conflicts with active run: ${result.actionId}`,
      );
    }
    try {
      this.actionRuns.complete(
        id,
        result,
        canonicalizeWorldSnapshot(world),
        resultWorldHash,
        updatedAt,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ActionResultDomainError(
          'conflict',
          `Action result does not match active run: ${result.actionId}`,
        );
      }
      throw error;
    }
    return true;
  }

  public createActionResultsEvent(event: {
    id: string;
    sessionId: string;
    type: 'actions.results.recorded';
    payload: { results: readonly ActionResult[]; world: WorldSnapshot };
    turnCorrelationId: string;
    createdAt: string;
  }): void {
    const { turnCorrelationId, ...record } = event;
    this.events.create({
      ...record,
      payload: {
        turnCorrelationId,
        results: [...event.payload.results],
        world: event.payload.world,
      },
    });
  }
}

function actionResultsEqual(left: ActionResult, right: ActionResult): boolean {
  return (
    left.actionId === right.actionId
    && left.type === right.type
    && left.status === right.status
    && left.message === right.message
    && left.errorCode === right.errorCode
    && Date.parse(left.completedAt) === Date.parse(right.completedAt)
  );
}

function actionRunId(
  sessionId: string,
  turnCorrelationId: string,
  actionId: string,
): string {
  return `run-${createHash('sha256')
    .update(`${sessionId}\0${turnCorrelationId}\0${actionId}`)
    .digest('hex')}`;
}
