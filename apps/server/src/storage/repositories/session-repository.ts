import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import type { SessionRecord } from '../types.js';
import { IdentifierSchema, TimestampSchema } from '../validation.js';

const SessionRecordSchema = z
  .object({
    id: IdentifierSchema,
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
}

export class SessionRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public create(record: SessionRecord): void {
    const session = SessionRecordSchema.parse(record);
    this.database
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at)
         VALUES (?, ?, ?)`,
      )
      .run(session.id, session.createdAt, session.updatedAt);
  }

  public get(id: string): SessionRecord | undefined {
    const row = this.database
      .prepare('SELECT id, created_at, updated_at FROM sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;

    return row === undefined
      ? undefined
      : SessionRecordSchema.parse({
          id: row.id,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
  }
}
