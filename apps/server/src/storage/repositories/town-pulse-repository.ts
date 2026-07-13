import {
  TownPulseResponseSchema,
  type TownPulseResponse,
} from '@cat-house/shared';
import { z } from 'zod';

import type { StorageDatabase } from '../database.js';
import {
  IdentifierSchema,
  normalizeTimestamp,
  parseJsonCompatible,
  serializeJsonCompatible,
} from '../validation.js';

const VersionSchema = z.number().int().nonnegative();

interface TownPulseRow {
  session_id: string;
  pulse_id: string;
  base_version: number;
  status: 'pending' | 'complete';
  lease_expires_at: string;
  result_json: string | null;
}

export interface TownPulseClaim {
  sessionId: string;
  pulseId: string;
  baseVersion: number;
  leaseToken: string;
  now: string;
  leaseExpiresAt: string;
}

export type TownPulseClaimResult =
  | { kind: 'claimed' }
  | { kind: 'in-flight' }
  | { kind: 'complete'; response: TownPulseResponse };

export class TownPulseRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public claim(claim: TownPulseClaim): TownPulseClaimResult {
    const sessionId = IdentifierSchema.parse(claim.sessionId);
    const pulseId = IdentifierSchema.parse(claim.pulseId);
    const baseVersion = VersionSchema.parse(claim.baseVersion);
    const leaseToken = IdentifierSchema.parse(claim.leaseToken);
    const now = normalizeTimestamp(claim.now);
    const leaseExpiresAt = normalizeTimestamp(claim.leaseExpiresAt);

    const insert = this.database
      .prepare(
        `INSERT INTO town_agent_pulses (
           session_id, pulse_id, base_version, status, lease_token,
           lease_expires_at, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, 'pending', ?, ?, NULL, ?, ?)
         ON CONFLICT(session_id, pulse_id) DO NOTHING`,
      )
      .run(
        sessionId,
        pulseId,
        baseVersion,
        leaseToken,
        leaseExpiresAt,
        now,
        now,
      );
    if (insert.changes === 1) return { kind: 'claimed' };

    const stored = this.loadRow(sessionId, pulseId);
    this.assertBaseVersion(stored, baseVersion);
    const existing = this.resultForStoredRow(stored);
    if (existing !== undefined) return existing;
    if (stored.lease_expires_at > now) return { kind: 'in-flight' };

    const takeover = this.database
      .prepare(
        `UPDATE town_agent_pulses
         SET lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE session_id = ?
           AND pulse_id = ?
           AND base_version = ?
           AND status = 'pending'
           AND lease_expires_at <= ?`,
      )
      .run(
        leaseToken,
        leaseExpiresAt,
        now,
        sessionId,
        pulseId,
        baseVersion,
        now,
      );
    if (takeover.changes === 1) return { kind: 'claimed' };

    const raced = this.loadRow(sessionId, pulseId);
    this.assertBaseVersion(raced, baseVersion);
    return this.resultForStoredRow(raced) ?? { kind: 'in-flight' };
  }

  public complete(
    sessionId: string,
    pulseId: string,
    leaseToken: string,
    response: TownPulseResponse,
    completedAt: string,
  ): void {
    const parsedSessionId = IdentifierSchema.parse(sessionId);
    const parsedPulseId = IdentifierSchema.parse(pulseId);
    const parsedLeaseToken = IdentifierSchema.parse(leaseToken);
    const resultJson = serializeJsonCompatible(
      response,
      TownPulseResponseSchema,
    );
    const timestamp = normalizeTimestamp(completedAt);
    const update = this.database
      .prepare(
        `UPDATE town_agent_pulses
         SET status = 'complete', result_json = ?, updated_at = ?
         WHERE session_id = ?
           AND pulse_id = ?
           AND status = 'pending'
           AND lease_token = ?`,
      )
      .run(
        resultJson,
        timestamp,
        parsedSessionId,
        parsedPulseId,
        parsedLeaseToken,
      );
    if (update.changes !== 1) {
      throw new Error(
        `Town pulse does not have a matching pending lease: ${parsedSessionId}/${parsedPulseId}`,
      );
    }
  }

  private loadRow(sessionId: string, pulseId: string): TownPulseRow {
    const row = this.database
      .prepare(
        `SELECT session_id, pulse_id, base_version, status,
                lease_expires_at, result_json
         FROM town_agent_pulses
         WHERE session_id = ? AND pulse_id = ?`,
      )
      .get(sessionId, pulseId) as TownPulseRow | undefined;
    if (row === undefined) {
      throw new Error(
        `Town pulse disappeared while claiming: ${sessionId}/${pulseId}`,
      );
    }
    return row;
  }

  private assertBaseVersion(row: TownPulseRow, baseVersion: number): void {
    if (row.base_version !== baseVersion) {
      throw new Error(
        `Town pulse base version conflict: ${row.session_id}/${row.pulse_id}`,
      );
    }
  }

  private resultForStoredRow(
    row: TownPulseRow,
  ): Extract<TownPulseClaimResult, { kind: 'complete' }> | undefined {
    if (row.status === 'pending') return undefined;
    if (row.result_json === null) {
      throw new Error(
        `Completed town pulse is missing its result: ${row.session_id}/${row.pulse_id}`,
      );
    }
    return {
      kind: 'complete',
      response: parseJsonCompatible(row.result_json, TownPulseResponseSchema),
    };
  }
}
