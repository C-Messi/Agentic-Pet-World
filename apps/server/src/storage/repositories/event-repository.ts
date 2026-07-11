import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import type { EventRecord } from '../types.js';
import {
  IdentifierSchema,
  normalizeTimestamp,
  parseJsonCompatible,
  serializeJsonCompatible,
  TimestampSchema,
} from '../validation.js';

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export class EventRepository<TPayload> {
  private readonly recordSchema: z.ZodType<EventRecord<TPayload>>;

  public constructor(
    private readonly database: StorageDatabase,
    private readonly payloadSchema: z.ZodType<TPayload>,
  ) {
    this.recordSchema = z
      .object({
        id: IdentifierSchema,
        sessionId: IdentifierSchema,
        type: z.string().trim().min(1).max(128),
        payload: payloadSchema,
        createdAt: TimestampSchema,
      })
      .strict();
  }

  public create(record: EventRecord<TPayload>): void {
    const event = this.recordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO events (id, session_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.sessionId,
        event.type,
        serializeJsonCompatible(event.payload, this.payloadSchema),
        normalizeTimestamp(event.createdAt),
      );
  }

  public listForSession(sessionId: string): readonly EventRecord<TPayload>[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, type, payload_json, created_at
         FROM events
         WHERE session_id = ?
         ORDER BY created_at, id`,
      )
      .all(sessionId) as EventRow[];

    return rows.map((row) =>
      this.recordSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        payload: parseJsonCompatible(row.payload_json, this.payloadSchema),
        createdAt: row.created_at,
      }),
    );
  }
}
