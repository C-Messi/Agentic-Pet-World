import type { AgentDecision, MemoryRecord, MessageRecord } from '@cat-house/shared';

import type { StorageDatabase } from '../storage/database.js';
import {
  EventRepository,
  MemoryRepository,
  MessageRepository,
} from '../storage/repositories/index.js';
import type { EventRecord } from '../storage/types.js';
import {
  AgentTurnEventPayloadSchema,
  type AgentTurnEventPayload,
  type TurnPersistence,
} from './agent-service.js';

export class StorageTurnPersistence implements TurnPersistence {
  private readonly messages: MessageRepository;
  private readonly memories: MemoryRepository;
  private readonly events: EventRepository<AgentTurnEventPayload>;

  public constructor(private readonly database: StorageDatabase) {
    this.messages = new MessageRepository(database);
    this.memories = new MemoryRepository(database);
    this.events = new EventRepository(database, AgentTurnEventPayloadSchema);
  }

  public runInTransaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  public findCompletedDecision(
    sessionId: string,
    correlationId: string,
  ): AgentDecision | undefined {
    const events = this.events.listForSession(sessionId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (
        event?.payload.phase === 'completed'
        && event.payload.correlationId === correlationId
      ) {
        return event.payload.decision;
      }
    }
    return undefined;
  }

  public createMessage(record: MessageRecord): void {
    this.messages.create(record);
  }

  public createMemory(record: MemoryRecord): void {
    this.memories.create(record);
  }

  public createEvent(record: EventRecord<AgentTurnEventPayload>): void {
    this.events.create(record);
  }
}
