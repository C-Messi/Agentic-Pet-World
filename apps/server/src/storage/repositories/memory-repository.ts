import {
  MemoryRecordSchema,
  type MemoryRecord,
} from '@cat-house/shared';

import type { StorageDatabase } from '../database.js';
import { normalizeTimestamp } from '../validation.js';

interface MemoryRow {
  id: string;
  session_id: string;
  content: string;
  importance: number;
  source_message_id: string | null;
  created_at: string;
  updated_at: string;
}

export class MemoryRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public create(record: MemoryRecord): void {
    const memory = MemoryRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO memories (
           id, session_id, content, importance, source_message_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id,
        memory.sessionId,
        memory.content,
        memory.importance,
        memory.sourceMessageId ?? null,
        normalizeTimestamp(memory.createdAt),
        normalizeTimestamp(memory.updatedAt),
      );
  }

  public listForSession(sessionId: string): readonly MemoryRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, content, importance, source_message_id,
                created_at, updated_at
         FROM memories
         WHERE session_id = ?
         ORDER BY created_at, id`,
      )
      .all(sessionId) as MemoryRow[];

    return rows.map((row) =>
      MemoryRecordSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        content: row.content,
        importance: row.importance,
        ...(row.source_message_id === null
          ? {}
          : { sourceMessageId: row.source_message_id }),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }),
    );
  }
}
