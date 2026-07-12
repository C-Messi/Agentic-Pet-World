import {
  ActionResultSchema,
  AgentActionSchema,
  WorldSnapshotSchema,
  type ActionResult,
  type WorldSnapshot,
} from '@cat-house/shared';
import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import type { ActionRunRecord } from '../types.js';
import {
  IdentifierSchema,
  normalizeTimestamp,
  parseJson,
  TimestampSchema,
} from '../validation.js';
import {
  canonicalizeWorldSnapshot,
  worldSnapshotHash,
} from '../../world-identity.js';

const ActionRunStatusSchema = z.enum([
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

const ActionRunRecordSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    turnCorrelationId: IdentifierSchema.max(96),
    action: AgentActionSchema,
    status: ActionRunStatusSchema,
    result: ActionResultSchema.optional(),
    resultWorld: WorldSnapshotSchema.optional(),
    resultWorldHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const isComplete = !['pending', 'running'].includes(record.status);
    if (
      isComplete !== (record.result !== undefined)
      || isComplete !== (record.resultWorld !== undefined)
      || isComplete !== (record.resultWorldHash !== undefined)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed action runs require result world identity and active runs forbid it',
        path: ['result'],
      });
    }
    if (
      record.result !== undefined &&
      (record.result.actionId !== record.action.id ||
        record.result.type !== record.action.type ||
        record.result.status !== record.status)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Action result must match the stored action and run status',
        path: ['result'],
      });
    }
    if (
      record.resultWorld !== undefined
      && record.resultWorldHash !== worldSnapshotHash(record.resultWorld)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Result world hash must match the canonical result world snapshot',
        path: ['resultWorldHash'],
      });
    }
  });

interface ActionRunRow {
  id: string;
  session_id: string;
  turn_correlation_id: string;
  action_json: string;
  status: string;
  result_json: string | null;
  result_world_hash: string | null;
  result_world_json: string | null;
  created_at: string;
  updated_at: string;
}

export class ActionRunRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public create(record: ActionRunRecord): void {
    const run = ActionRunRecordSchema.parse(record);
    const result =
      run.result === undefined
        ? undefined
        : {
            ...run.result,
            completedAt: normalizeTimestamp(run.result.completedAt),
          };
    this.database
      .prepare(
        `INSERT INTO action_runs (
           id, session_id, turn_correlation_id, action_json, status, result_json,
           result_world_hash, result_world_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        run.turnCorrelationId,
        JSON.stringify(run.action),
        run.status,
        result === undefined ? null : JSON.stringify(result),
        run.resultWorldHash ?? null,
        run.resultWorld === undefined ? null : JSON.stringify(run.resultWorld),
        normalizeTimestamp(run.createdAt),
        normalizeTimestamp(run.updatedAt),
      );
  }

  public complete(
    id: string,
    result: ActionResult,
    resultWorld: WorldSnapshot,
    resultWorldHash: string,
    updatedAt: string,
  ): void {
    const actionResult = ActionResultSchema.parse(result);
    const world = canonicalizeWorldSnapshot(WorldSnapshotSchema.parse(resultWorld));
    const worldHash = z.string().regex(/^[a-f0-9]{64}$/).parse(resultWorldHash);
    if (worldHash !== worldSnapshotHash(world)) {
      throw new Error('Result world hash does not match the canonical snapshot');
    }
    const normalizedResult = {
      ...actionResult,
      completedAt: normalizeTimestamp(actionResult.completedAt),
    };
    const normalizedUpdatedAt = normalizeTimestamp(updatedAt);
    this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE action_runs
           SET status = ?, result_json = ?, result_world_hash = ?,
               result_world_json = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(
          normalizedResult.status,
          JSON.stringify(normalizedResult),
          worldHash,
          JSON.stringify(world),
          normalizedUpdatedAt,
          id,
        );
      if (update.changes !== 1) {
        throw new Error(`Action run cannot be completed: ${id}`);
      }

      this.getRequired(id);
    })();
  }

  public get(id: string): ActionRunRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT id, session_id, turn_correlation_id, action_json, status, result_json,
                result_world_hash, result_world_json, created_at, updated_at
         FROM action_runs
         WHERE id = ?`,
      )
      .get(id) as ActionRunRow | undefined;

    return row === undefined ? undefined : this.parseRow(row);
  }

  private getRequired(id: string): ActionRunRecord {
    const run = this.get(id);
    if (run === undefined) {
      throw new Error(`Action run not found after update: ${id}`);
    }
    return run;
  }

  private parseRow(row: ActionRunRow): ActionRunRecord {
    const run = ActionRunRecordSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      turnCorrelationId: row.turn_correlation_id,
      action: parseJson(row.action_json, AgentActionSchema),
      status: row.status,
      ...(row.result_json === null
        ? {}
        : { result: parseJson(row.result_json, ActionResultSchema) }),
      ...(row.result_world_json === null
        ? {}
        : { resultWorld: parseJson(row.result_world_json, WorldSnapshotSchema) }),
      ...(row.result_world_hash === null
        ? {}
        : { resultWorldHash: row.result_world_hash }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return {
      id: run.id,
      sessionId: run.sessionId,
      turnCorrelationId: run.turnCorrelationId,
      action: run.action,
      status: run.status,
      ...(run.result === undefined ? {} : { result: run.result }),
      ...(run.resultWorld === undefined ? {} : { resultWorld: run.resultWorld }),
      ...(run.resultWorldHash === undefined
        ? {}
        : { resultWorldHash: run.resultWorldHash }),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }
}
