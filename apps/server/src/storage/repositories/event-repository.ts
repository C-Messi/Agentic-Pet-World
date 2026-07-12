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

const EventTypeSchema = z.string().trim().min(1).max(128);
const EventEnvelopeSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    type: EventTypeSchema,
    payload: z.unknown(),
    createdAt: TimestampSchema,
  })
  .strict();

interface EventRow {
  id: string;
  session_id: string;
  type: string;
  payload_json: string;
  created_at: string;
}

export class EventRepository<TPayload> {
  public constructor(
    private readonly database: StorageDatabase,
    private readonly payloadSchema: z.ZodType<TPayload>,
  ) {}

  public create(record: EventRecord<TPayload>): void {
    const envelope = EventEnvelopeSchema.parse(record);
    const payload = this.payloadSchema.parse(envelope.payload);
    this.database
      .prepare(
        `INSERT INTO events (id, session_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        envelope.id,
        envelope.sessionId,
        envelope.type,
        serializeJsonCompatible(payload, this.payloadSchema),
        normalizeTimestamp(envelope.createdAt),
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

    return this.parseRows(rows);
  }

  public findLatestForSessionByTypeAndCorrelation(
    sessionId: string,
    type: string,
    correlationId: string,
  ): EventRecord<TPayload> | undefined {
    const eventType = EventTypeSchema.parse(type);
    const correlation = IdentifierSchema.parse(correlationId);
    const row = this.database
      .prepare(
        `SELECT id, session_id, type, payload_json, created_at
         FROM events
         WHERE session_id = ?
           AND type = ?
           AND json_extract(payload_json, '$.correlationId') = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(sessionId, eventType, correlation) as EventRow | undefined;

    return row === undefined ? undefined : this.parseRows([row])[0];
  }

  private parseRows(rows: readonly EventRow[]): readonly EventRecord<TPayload>[] {
    return rows.map((row) => {
      const envelope = EventEnvelopeSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        type: row.type,
        payload: parseJsonCompatible(row.payload_json, this.payloadSchema),
        createdAt: row.created_at,
      });
      return {
        id: envelope.id,
        sessionId: envelope.sessionId,
        type: envelope.type,
        payload: this.payloadSchema.parse(envelope.payload),
        createdAt: envelope.createdAt,
      };
    });
  }
}
