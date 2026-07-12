import { TownEventSchema, type TownEvent } from '@cat-house/shared';
import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import {
  IdentifierSchema,
  normalizeTimestamp,
  parseJsonCompatible,
  serializeJsonCompatible,
} from '../validation.js';

const SequenceSchema = z.number().int().nonnegative();
const LimitSchema = z.number().int();

interface TownEventRow {
  session_id: string;
  event_id: string;
  sequence: number;
  event_json: string;
}

export class TownEventRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public append(event: TownEvent): { inserted: boolean; sequence: number } {
    const parsed = TownEventSchema.parse({
      ...event,
      timestamp: normalizeTimestamp(event.timestamp),
    });
    const eventJson = serializeJsonCompatible(parsed, TownEventSchema);
    const existing = this.database
      .prepare(
        `SELECT session_id, event_id, sequence, event_json
         FROM town_events
         WHERE session_id = ? AND event_id = ?`,
      )
      .get(parsed.sessionId, parsed.id) as TownEventRow | undefined;

    if (existing !== undefined) {
      if (existing.event_json !== eventJson) {
        throw new Error(`Town event conflict: ${parsed.sessionId}/${parsed.id}`);
      }
      const stored = this.parseRow(existing);
      return { inserted: false, sequence: stored.sequence };
    }

    this.database
      .prepare(
        `INSERT INTO town_events (session_id, event_id, sequence, event_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(parsed.sessionId, parsed.id, parsed.sequence, eventJson, parsed.timestamp);
    return { inserted: true, sequence: parsed.sequence };
  }

  public listAfter(
    sessionId: string,
    sequence: number,
    limit: number,
  ): readonly TownEvent[] {
    const id = IdentifierSchema.parse(sessionId);
    const after = SequenceSchema.parse(sequence);
    const boundedLimit = Math.min(24, Math.max(1, LimitSchema.parse(limit)));
    const rows = this.database
      .prepare(
        `SELECT session_id, event_id, sequence, event_json
         FROM town_events
         WHERE session_id = ? AND sequence > ?
         ORDER BY sequence
         LIMIT ?`,
      )
      .all(id, after, boundedLimit) as TownEventRow[];
    return rows.map((row) => this.parseRow(row));
  }

  public listByIds(
    sessionId: string,
    eventIds: readonly string[],
  ): readonly TownEvent[] {
    const id = IdentifierSchema.parse(sessionId);
    const ids = eventIds.map((eventId) => IdentifierSchema.parse(eventId));
    if (ids.length > 24) throw new Error('At most 24 town event IDs may be requested');
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate town event IDs are not allowed');
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `SELECT session_id, event_id, sequence, event_json
         FROM town_events
         WHERE session_id = ? AND event_id IN (${placeholders})`,
      )
      .all(id, ...ids) as TownEventRow[];
    const eventsById = new Map(rows.map((row) => [row.event_id, this.parseRow(row)]));
    return ids.flatMap((eventId) => {
      const found = eventsById.get(eventId);
      return found === undefined ? [] : [found];
    });
  }

  private parseRow(row: TownEventRow): TownEvent {
    const event = parseJsonCompatible(row.event_json, TownEventSchema);
    if (
      event.sessionId !== row.session_id
      || event.id !== row.event_id
      || event.sequence !== row.sequence
    ) {
      throw new Error(`Stored town event columns do not match payload: ${row.event_id}`);
    }
    return event;
  }
}
