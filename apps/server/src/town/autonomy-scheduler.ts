import {
  IdentifierSchema,
  TownEventSchema,
  TownProjectionSchema,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import { z } from 'zod';

const RECENT_EVENT_LIMIT = 256;
const MIN_COOLDOWN_MS = 12_000;
const COOLDOWN_RANGE = 18_001;

const SchedulerInputSchema = z
  .object({
    projection: TownProjectionSchema,
    recentEvents: z.array(TownEventSchema).max(RECENT_EVENT_LIMIT),
    nowMs: z.number().finite().int().nonnegative(),
    limit: z.number().int().min(1).max(2),
  })
  .strict();

export interface AutonomousResidentSelectionInput {
  readonly projection: Readonly<TownProjection>;
  readonly recentEvents: readonly Readonly<TownEvent>[];
  readonly nowMs: number;
  readonly limit: number;
}

export function residentCooldownMs(residentId: string): number {
  const parsedResidentId = IdentifierSchema.parse(residentId);
  let hash = 2_166_136_261;

  for (const character of parsedResidentId) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }

  return MIN_COOLDOWN_MS + (Math.abs(hash) % COOLDOWN_RANGE);
}

export function selectAutonomousResidents(
  source: AutonomousResidentSelectionInput,
): readonly string[] {
  const input = SchedulerInputSchema.parse(structuredClone(source));
  const residentIds = new Set(
    input.projection.residents.map(({ residentId }) => residentId),
  );
  const latestDecisionMs = new Map<string, number>();

  const updateLatestDecision = (residentId: string, timestamp: string) => {
    if (!residentIds.has(residentId)) return;
    const timestampMs = Date.parse(timestamp);
    const current = latestDecisionMs.get(residentId);
    if (current === undefined || timestampMs > current) {
      latestDecisionMs.set(residentId, timestampMs);
    }
  };

  for (const townEvent of input.recentEvents) {
    if (townEvent.sessionId !== input.projection.sessionId) {
      throw new TypeError('Recent event session does not match projection');
    }
    switch (townEvent.type) {
      case 'resident.moved':
      case 'resident.spoke':
      case 'residents.played':
        for (const residentId of townEvent.participantIds) {
          updateLatestDecision(residentId, townEvent.timestamp);
        }
        break;
    }
  }

  const selected = input.projection.residents
    .map((resident, projectionIndex) => ({
      residentId: resident.residentId,
      availability: resident.availability,
      projectionIndex,
      latestDecisionMs: latestDecisionMs.get(resident.residentId),
    }))
    .filter(({ residentId, availability, latestDecisionMs: latest }) => {
      if (availability !== 'available') return false;
      return (
        latest === undefined ||
        input.nowMs - latest >= residentCooldownMs(residentId)
      );
    })
    .sort((left, right) => {
      if (left.latestDecisionMs === undefined) {
        return right.latestDecisionMs === undefined
          ? left.projectionIndex - right.projectionIndex
          : -1;
      }
      if (right.latestDecisionMs === undefined) return 1;
      return (
        left.latestDecisionMs - right.latestDecisionMs ||
        left.projectionIndex - right.projectionIndex
      );
    })
    .slice(0, input.limit)
    .map(({ residentId }) => residentId);

  return Object.freeze(selected);
}
