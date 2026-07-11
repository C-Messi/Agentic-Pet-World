import {
  MessageRecordSchema,
  type MessageRecord,
} from '@cat-house/shared';

import type { StorageDatabase } from '../database.js';

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export class MessageRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public create(record: MessageRecord): void {
    const message = MessageRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.createdAt,
      );
  }

  public listForSession(sessionId: string): readonly MessageRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, session_id, role, content, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at, id`,
      )
      .all(sessionId) as MessageRow[];

    return rows.map((row) =>
      MessageRecordSchema.parse({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      }),
    );
  }
}
