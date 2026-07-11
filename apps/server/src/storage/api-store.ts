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

const ActionResultsEventPayloadSchema = z
  .object({
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
    correlationId: string,
    createdAt: string,
  ): void {
    const id = actionRunId(sessionId, correlationId, action.id);
    if (this.actionRuns.get(id) !== undefined) {
      return;
    }
    this.actionRuns.create({
      id,
      sessionId,
      action,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    });
  }

  public completeActionRun(
    sessionId: string,
    result: ActionResult,
    updatedAt: string,
  ): void {
    const row = this.database
      .prepare(
        `SELECT id
         FROM action_runs
         WHERE session_id = ?
           AND status IN ('pending', 'running')
           AND json_extract(action_json, '$.id') = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId, result.actionId) as { id: string } | undefined;
    if (row === undefined) {
      throw new ActionResultDomainError(
        `Active action run not found: ${result.actionId}`,
      );
    }
    try {
      this.actionRuns.complete(row.id, result, updatedAt);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ActionResultDomainError(
          `Action result does not match active run: ${result.actionId}`,
        );
      }
      throw error;
    }
  }

  public createActionResultsEvent(event: {
    id: string;
    sessionId: string;
    type: 'actions.results.recorded';
    payload: { results: readonly ActionResult[]; world: WorldSnapshot };
    createdAt: string;
  }): void {
    this.events.create({
      ...event,
      payload: {
        results: [...event.payload.results],
        world: event.payload.world,
      },
    });
  }
}

function actionRunId(
  sessionId: string,
  correlationId: string,
  actionId: string,
): string {
  return `run-${createHash('sha256')
    .update(`${sessionId}\0${correlationId}\0${actionId}`)
    .digest('hex')}`;
}
