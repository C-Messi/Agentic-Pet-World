import {
  ExperienceCardSchema,
  OfflineRecoveryResponseSchema,
  PetDefinitionSchema,
  PublicShowcaseItemSchema,
  TownActivityInstanceSchema,
  TownOutingSchema,
  TownProjectionSchema,
  TownRelationshipSchema,
  TownResidentStateSchema,
  type ExperienceCard,
  type OfflineRecoveryResponse,
  type PublicShowcaseItem,
  type TownOuting,
  type TownProjection,
} from '@cat-house/shared';

import type { StorageDatabase } from '../database.js';
import {
  IdentifierSchema,
  normalizeTimestamp,
  parseJsonCompatible,
  serializeJsonCompatible,
} from '../validation.js';

interface ProjectionRow {
  session_id: string;
  projection_json: string;
  version: number;
  last_sequence: number;
}

interface OutingRow {
  session_id: string;
  resident_id: string;
  outing_json: string;
}

interface RecoveryWindowRow {
  session_id: string;
  recovery_window_id: string;
  outing_json: string;
  result_json: string | null;
}

interface CardRow {
  session_id: string;
  card_id: string;
  card_json: string;
}

interface CardEventRow {
  card_id: string;
  event_id: string;
}

interface ShowcaseRow {
  session_id: string;
  item_id: string;
  item_json: string;
}

export class TownProjectionRepository {
  public constructor(private readonly database: StorageDatabase) {}

  public load(sessionId: string): TownProjection | undefined {
    const id = IdentifierSchema.parse(sessionId);
    const row = this.database
      .prepare(
        `SELECT session_id, projection_json, version, last_sequence
         FROM town_world_states
         WHERE session_id = ?`,
      )
      .get(id) as ProjectionRow | undefined;
    if (row === undefined) return undefined;
    const projection = parseJsonCompatible(row.projection_json, TownProjectionSchema);
    if (
      projection.sessionId !== row.session_id
      || projection.version !== row.version
      || projection.lastEventSequence !== row.last_sequence
    ) {
      throw new Error(`Stored town projection columns do not match payload: ${id}`);
    }
    return projection;
  }

  public save(
    sessionId: string,
    expectedVersion: number,
    projection: TownProjection,
  ): boolean {
    const id = IdentifierSchema.parse(sessionId);
    const parsed = TownProjectionSchema.parse(projection);
    if (parsed.sessionId !== id) throw new Error('Town projection session does not match');
    if (!Number.isInteger(expectedVersion) || expectedVersion < -1) {
      throw new Error('Expected projection version must be an integer at least -1');
    }
    if (parsed.version !== expectedVersion + 1) {
      throw new Error(
        `Invalid town projection version step: expected ${expectedVersion + 1}, received ${parsed.version}`,
      );
    }
    const projectionJson = serializeJsonCompatible(parsed, TownProjectionSchema);

    return this.database.transaction(() => {
      const now = new Date().toISOString();
      let saved: boolean;
      if (expectedVersion === -1) {
        const insert = this.database
          .prepare(
            `INSERT INTO town_world_states
               (session_id, projection_json, version, last_sequence, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO NOTHING`,
          )
          .run(id, projectionJson, parsed.version, parsed.lastEventSequence, now);
        saved = insert.changes === 1;
      } else {
        const update = this.database
          .prepare(
            `UPDATE town_world_states
             SET projection_json = ?, version = ?, last_sequence = ?, updated_at = ?
             WHERE session_id = ? AND version = ?`,
          )
          .run(
            projectionJson,
            parsed.version,
            parsed.lastEventSequence,
            now,
            id,
            expectedVersion,
          );
        saved = update.changes === 1;
      }
      if (!saved) return false;

      const upsertResident = this.database.prepare(
        `INSERT INTO town_residents
           (session_id, resident_id, definition_json, state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, resident_id) DO UPDATE SET
           definition_json = excluded.definition_json,
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
      );
      for (const resident of parsed.residents) {
        upsertResident.run(
          id,
          resident.residentId,
          serializeJsonCompatible(resident.pet, PetDefinitionSchema),
          serializeJsonCompatible(resident, TownResidentStateSchema),
          now,
          now,
        );
      }

      this.database.prepare('DELETE FROM town_relationships WHERE session_id = ?').run(id);
      const insertRelationship = this.database.prepare(
        `INSERT INTO town_relationships
           (session_id, resident_id_a, resident_id_b, relationship_json, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const relationship of parsed.relationships) {
        const [residentA, residentB] = [
          relationship.residentIdA,
          relationship.residentIdB,
        ].sort();
        insertRelationship.run(
          id,
          residentA,
          residentB,
          serializeJsonCompatible(relationship, TownRelationshipSchema),
          now,
        );
      }

      this.database.prepare('DELETE FROM town_activity_instances WHERE session_id = ?').run(id);
      const insertActivity = this.database.prepare(
        `INSERT INTO town_activity_instances
           (session_id, activity_instance_id, activity_id, version, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const activity of parsed.activities) {
        insertActivity.run(
          id,
          activity.id,
          activity.activityId,
          activity.version,
          serializeJsonCompatible(activity, TownActivityInstanceSchema),
          now,
        );
      }

      const residentIds = parsed.residents.map(({ residentId }) => residentId);
      const placeholders = residentIds.map(() => '?').join(', ');
      this.database
        .prepare(
          `DELETE FROM town_residents
           WHERE session_id = ? AND resident_id NOT IN (${placeholders})`,
        )
        .run(id, ...residentIds);
      return true;
    })();
  }

  public loadOuting(sessionId: string): TownOuting | undefined {
    const id = IdentifierSchema.parse(sessionId);
    const row = this.database
      .prepare(
        `SELECT session_id, resident_id, outing_json
         FROM town_outings
         WHERE session_id = ?`,
      )
      .get(id) as OutingRow | undefined;
    if (row === undefined) return undefined;
    const stored = parseJsonCompatible(row.outing_json, TownOutingSchema);
    if (stored.sessionId !== row.session_id || stored.residentId !== row.resident_id) {
      throw new Error(`Stored town outing columns do not match payload: ${id}`);
    }
    return stored;
  }

  public saveOuting(outing: TownOuting): void {
    const parsed = normalizeOuting(outing);
    const outingJson = serializeJsonCompatible(parsed, TownOutingSchema);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO town_outings
             (session_id, resident_id, outing_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             resident_id = excluded.resident_id,
             outing_json = excluded.outing_json,
             updated_at = excluded.updated_at`,
        )
        .run(parsed.sessionId, parsed.residentId, outingJson, new Date().toISOString());
    }).immediate();
  }

  public claimRecoveryWindow(
    outing: TownOuting,
    recoveryWindowId: string,
  ): { claimed: boolean } {
    const parsed = normalizeOuting(outing);
    const windowId = IdentifierSchema.parse(recoveryWindowId);
    const outingJson = serializeJsonCompatible(parsed, TownOutingSchema);
    return this.database.transaction(() => {
      const claim = this.database
        .prepare(
          `INSERT INTO town_recovery_windows
             (session_id, recovery_window_id, outing_json, result_json, created_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(session_id, recovery_window_id) DO NOTHING`,
        )
        .run(parsed.sessionId, windowId, outingJson, new Date().toISOString());
      const storedClaim = this.getRecoveryWindow(parsed.sessionId, windowId);
      if (storedClaim === undefined) {
        throw new Error(`Stored recovery claim disappeared: ${parsed.sessionId}/${windowId}`);
      }
      const storedOuting = this.parseRecoveryOuting(storedClaim);
      const storedOutingJson = serializeJsonCompatible(storedOuting, TownOutingSchema);
      if (storedOutingJson !== outingJson) {
        throw new Error(`Town outing recovery conflict: ${parsed.sessionId}/${windowId}`);
      }
      return { claimed: claim.changes === 1 };
    }).immediate();
  }

  public loadRecoveryResult(
    sessionId: string,
    recoveryWindowId: string,
  ): OfflineRecoveryResponse | undefined {
    const id = IdentifierSchema.parse(sessionId);
    const windowId = IdentifierSchema.parse(recoveryWindowId);
    const row = this.getRecoveryWindow(id, windowId);
    if (row === undefined) return undefined;
    this.parseRecoveryOuting(row);
    if (row.result_json === null) return undefined;
    return this.parseRecoveryResult(row);
  }

  public saveRecoveryResult(
    sessionId: string,
    recoveryWindowId: string,
    result: OfflineRecoveryResponse,
  ): void {
    const id = IdentifierSchema.parse(sessionId);
    const windowId = IdentifierSchema.parse(recoveryWindowId);
    const parsed = OfflineRecoveryResponseSchema.parse(result);
    if (parsed.projection.sessionId !== id) {
      throw new Error('Recovery result session does not match');
    }
    const resultJson = serializeJsonCompatible(parsed, OfflineRecoveryResponseSchema);
    this.database.transaction(() => {
      this.database
        .prepare(
          `UPDATE town_recovery_windows
           SET result_json = ?
           WHERE session_id = ? AND recovery_window_id = ? AND result_json IS NULL`,
        )
        .run(resultJson, id, windowId);
      const stored = this.getRecoveryWindow(id, windowId);
      if (stored === undefined) {
        throw new Error(`Recovery window not found: ${id}/${windowId}`);
      }
      this.parseRecoveryOuting(stored);
      const storedResult = this.parseRecoveryResult(stored);
      const storedResultJson = serializeJsonCompatible(
        storedResult,
        OfflineRecoveryResponseSchema,
      );
      if (storedResultJson !== resultJson) {
        throw new Error(`Town recovery result conflict: ${id}/${windowId}`);
      }
    }).immediate();
  }

  public listCards(sessionId: string): readonly ExperienceCard[] {
    const id = IdentifierSchema.parse(sessionId);
    const rows = this.database
      .prepare(
        `SELECT session_id, card_id, card_json
         FROM town_experience_cards
         WHERE session_id = ?
         ORDER BY created_at DESC, card_id DESC
         LIMIT 100`,
      )
      .all(id) as CardRow[];
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(', ');
    const eventRows = this.database
      .prepare(
        `SELECT card_id, event_id
         FROM town_experience_card_events
         WHERE session_id = ? AND card_id IN (${placeholders})
         ORDER BY card_id, ordinal`,
      )
      .all(id, ...rows.map(({ card_id }) => card_id)) as CardEventRow[];
    const eventIdsByCard = new Map<string, string[]>();
    for (const eventRow of eventRows) {
      const eventIds = eventIdsByCard.get(eventRow.card_id) ?? [];
      eventIds.push(eventRow.event_id);
      eventIdsByCard.set(eventRow.card_id, eventIds);
    }
    return rows.map((row) => {
      const stored = parseJsonCompatible(row.card_json, ExperienceCardSchema);
      if (stored.sessionId !== row.session_id || stored.id !== row.card_id) {
        throw new Error(`Stored experience card columns do not match payload: ${row.card_id}`);
      }
      const linkedEventIds = eventIdsByCard.get(row.card_id) ?? [];
      if (!arraysEqual(stored.sourceEventIds, linkedEventIds)) {
        throw new Error(`Stored card source event links do not match payload: ${row.card_id}`);
      }
      return stored;
    });
  }

  public saveCard(card: ExperienceCard): void {
    const parsed = ExperienceCardSchema.parse({
      ...card,
      timestamp: normalizeTimestamp(card.timestamp),
    });
    const cardJson = serializeJsonCompatible(parsed, ExperienceCardSchema);
    this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO town_experience_cards
             (session_id, card_id, card_json, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, card_id) DO UPDATE SET
             card_json = excluded.card_json,
             created_at = excluded.created_at`,
        )
        .run(parsed.sessionId, parsed.id, cardJson, parsed.timestamp);
      this.database
        .prepare(
          'DELETE FROM town_experience_card_events WHERE session_id = ? AND card_id = ?',
        )
        .run(parsed.sessionId, parsed.id);
      const insertLink = this.database.prepare(
        `INSERT INTO town_experience_card_events
           (session_id, card_id, event_id, ordinal)
         VALUES (?, ?, ?, ?)`,
      );
      parsed.sourceEventIds.forEach((eventId, ordinal) => {
        insertLink.run(parsed.sessionId, parsed.id, eventId, ordinal);
      });
    })();
  }

  public listPublicShowcaseItems(sessionId: string): readonly PublicShowcaseItem[] {
    const id = IdentifierSchema.parse(sessionId);
    const rows = this.database
      .prepare(
        `SELECT session_id, item_id, item_json
         FROM public_showcase_items
         WHERE session_id = ? AND is_public = 1
         ORDER BY created_at, item_id
         LIMIT 12`,
      )
      .all(id) as ShowcaseRow[];
    return rows.map((row) => {
      const item = parseJsonCompatible(row.item_json, PublicShowcaseItemSchema);
      if (item.sessionId !== row.session_id || item.id !== row.item_id) {
        throw new Error(`Stored showcase item columns do not match payload: ${row.item_id}`);
      }
      return item;
    });
  }

  public savePublicShowcaseItem(item: PublicShowcaseItem): void {
    const parsed = PublicShowcaseItemSchema.parse(item);
    const itemJson = serializeJsonCompatible(parsed, PublicShowcaseItemSchema);
    this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT 1
           FROM public_showcase_items
           WHERE session_id = ? AND item_id = ?`,
        )
        .get(parsed.sessionId, parsed.id);
      if (existing === undefined) {
        const { count } = this.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM public_showcase_items
             WHERE session_id = ?`,
          )
          .get(parsed.sessionId) as { count: number };
        if (count >= 12) throw new Error('Public showcase item limit is 12');
      }
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO public_showcase_items
             (session_id, item_id, item_json, is_public, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT(session_id, item_id) DO UPDATE SET
             item_json = excluded.item_json,
             is_public = 1,
             updated_at = excluded.updated_at`,
        )
        .run(parsed.sessionId, parsed.id, itemJson, now, now);
    }).immediate();
  }

  public deletePublicShowcaseItem(sessionId: string, itemId: string): boolean {
    const deleted = this.database
      .prepare('DELETE FROM public_showcase_items WHERE session_id = ? AND item_id = ?')
      .run(IdentifierSchema.parse(sessionId), IdentifierSchema.parse(itemId));
    return deleted.changes === 1;
  }

  private getRecoveryWindow(
    sessionId: string,
    recoveryWindowId: string,
  ): RecoveryWindowRow | undefined {
    return this.database
      .prepare(
        `SELECT session_id, recovery_window_id, outing_json, result_json
         FROM town_recovery_windows
         WHERE session_id = ? AND recovery_window_id = ?`,
      )
      .get(sessionId, recoveryWindowId) as RecoveryWindowRow | undefined;
  }

  private parseRecoveryOuting(row: RecoveryWindowRow): TownOuting {
    const outing = parseJsonCompatible(row.outing_json, TownOutingSchema);
    if (outing.sessionId !== row.session_id) {
      throw new Error(
        `Stored recovery claim columns do not match payload: ${row.session_id}/${row.recovery_window_id}`,
      );
    }
    return outing;
  }

  private parseRecoveryResult(row: RecoveryWindowRow): OfflineRecoveryResponse {
    if (row.result_json === null) {
      throw new Error(`Recovery result not found: ${row.session_id}/${row.recovery_window_id}`);
    }
    const result = parseJsonCompatible(row.result_json, OfflineRecoveryResponseSchema);
    if (result.projection.sessionId !== row.session_id) {
      throw new Error(
        `Stored recovery result columns do not match payload: ${row.session_id}/${row.recovery_window_id}`,
      );
    }
    return result;
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeOuting(outing: TownOuting): TownOuting {
  const parsed = TownOutingSchema.parse(outing);
  return TownOutingSchema.parse({
    ...parsed,
    ...(parsed.startedAt === undefined ? {} : { startedAt: normalizeTimestamp(parsed.startedAt) }),
    ...(parsed.lastConfirmedAt === undefined
      ? {}
      : { lastConfirmedAt: normalizeTimestamp(parsed.lastConfirmedAt) }),
    ...(parsed.returnedAt === undefined ? {} : { returnedAt: normalizeTimestamp(parsed.returnedAt) }),
    ...(parsed.recoveryWindowEndsAt === undefined
      ? {}
      : { recoveryWindowEndsAt: normalizeTimestamp(parsed.recoveryWindowEndsAt) }),
  });
}
