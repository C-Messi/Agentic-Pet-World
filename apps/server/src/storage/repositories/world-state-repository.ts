import {
  WorldSnapshotSchema,
  type WorldSnapshot,
} from '@cat-house/shared';
import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import type { WorldStateRecord } from '../types.js';
import { IdentifierSchema, parseJson, TimestampSchema } from '../validation.js';

const WorldStateRecordSchema = z
  .object({
    sessionId: IdentifierSchema,
    snapshot: WorldSnapshotSchema,
    updatedAt: TimestampSchema,
  })
  .strict();

interface WorldStateRow {
  session_id: string;
  snapshot_json: string;
  updated_at: string;
}

export class WorldStateRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public upsert(sessionId: string, snapshot: WorldSnapshot, updatedAt: string): void {
    const worldState = WorldStateRecordSchema.parse({
      sessionId,
      snapshot,
      updatedAt,
    });
    this.database
      .prepare(
        `INSERT INTO world_states (session_id, snapshot_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           snapshot_json = excluded.snapshot_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        worldState.sessionId,
        JSON.stringify(worldState.snapshot),
        worldState.updatedAt,
      );
  }

  public get(sessionId: string): WorldStateRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT session_id, snapshot_json, updated_at
         FROM world_states
         WHERE session_id = ?`,
      )
      .get(sessionId) as WorldStateRow | undefined;

    return row === undefined
      ? undefined
      : WorldStateRecordSchema.parse({
          sessionId: row.session_id,
          snapshot: parseJson(row.snapshot_json, WorldSnapshotSchema),
          updatedAt: row.updated_at,
        });
  }
}
