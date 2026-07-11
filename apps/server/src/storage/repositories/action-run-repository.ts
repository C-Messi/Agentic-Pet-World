import {
  ActionResultSchema,
  AgentActionSchema,
  type ActionResult,
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
    action: AgentActionSchema,
    status: ActionRunStatusSchema,
    result: ActionResultSchema.optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const isComplete = !['pending', 'running'].includes(record.status);
    if (isComplete !== (record.result !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Completed action runs require a result and active runs forbid one',
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
  });

interface ActionRunRow {
  id: string;
  session_id: string;
  action_json: string;
  status: string;
  result_json: string | null;
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
           id, session_id, action_json, status, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.sessionId,
        JSON.stringify(run.action),
        run.status,
        result === undefined ? null : JSON.stringify(result),
        normalizeTimestamp(run.createdAt),
        normalizeTimestamp(run.updatedAt),
      );
  }

  public complete(id: string, result: ActionResult, updatedAt: string): void {
    const actionResult = ActionResultSchema.parse(result);
    const normalizedResult = {
      ...actionResult,
      completedAt: normalizeTimestamp(actionResult.completedAt),
    };
    const normalizedUpdatedAt = normalizeTimestamp(updatedAt);
    this.database.transaction(() => {
      const update = this.database
        .prepare(
          `UPDATE action_runs
           SET status = ?, result_json = ?, updated_at = ?
           WHERE id = ? AND status IN ('pending', 'running')`,
        )
        .run(
          normalizedResult.status,
          JSON.stringify(normalizedResult),
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
        `SELECT id, session_id, action_json, status, result_json, created_at, updated_at
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
    return ActionRunRecordSchema.parse({
      id: row.id,
      sessionId: row.session_id,
      action: parseJson(row.action_json, AgentActionSchema),
      status: row.status,
      ...(row.result_json === null
        ? {}
        : { result: parseJson(row.result_json, ActionResultSchema) }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
