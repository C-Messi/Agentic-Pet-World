import {
  IdentifierSchema,
  TOWN_ENCOUNTER_PAIRS,
  TOWN_GRID,
  TOWN_STATIC_BLOCKED_CELLS,
  TOWN_ZONE_LAYOUT,
  TownEventSchema,
  TownProjectionSchema,
  TownZoneIdSchema,
  type TownEvent,
  type TownProjection,
  type TownResidentState,
  type TownZoneId,
} from '@cat-house/shared';
import { z } from 'zod';

import {
  EncounterAnimationSchema,
  ResidentSpeechSchema,
} from './resident-agent-contracts.js';
import { autonomousPlayRelationshipChange } from './relationship-rules.js';

const MAX_ID_ATTEMPTS = 8;
const TimestampSchema = z.string().datetime({ offset: true });
const OptionalResidentSpeechSchema = z
  .union([ResidentSpeechSchema, z.string().trim().length(0)])
  .optional();

const VisitInputSchema = z
  .object({ residentId: IdentifierSchema, zoneId: TownZoneIdSchema })
  .strict();
const EncounterInputSchema = z
  .object({
    initiatorId: IdentifierSchema,
    responderId: IdentifierSchema,
    zoneId: TownZoneIdSchema.optional(),
    opening: ResidentSpeechSchema,
    reply: ResidentSpeechSchema,
    followUp: OptionalResidentSpeechSchema,
    animation: EncounterAnimationSchema,
  })
  .strict();

export type AutonomyAnimation = z.infer<typeof EncounterAnimationSchema>;
export type AutonomyVisitInput = z.input<typeof VisitInputSchema>;
export type AutonomyEncounterInput = z.input<typeof EncounterInputSchema>;

export interface AutonomyEventBuilderPorts {
  now(): string;
  nextId(prefix: 'town-event' | 'activity'): string;
}

export class AutonomyEventBuilderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AutonomyEventBuilderError';
  }
}

export class AutonomyEventBuilder {
  constructor(private readonly ports: AutonomyEventBuilderPorts) {}

  canEncounter(
    source: Readonly<TownProjection>,
    initiatorId: string,
    responderId: string,
  ): boolean {
    const projection = parseProjection(source);
    const initiator = projection.residents.find(
      (resident) => resident.residentId === initiatorId,
    );
    const responder = projection.residents.find(
      (resident) => resident.residentId === responderId,
    );
    if (
      initiatorId === responderId ||
      initiator?.availability !== 'available' ||
      responder?.availability !== 'available'
    ) {
      return false;
    }
    try {
      requireEncounterPair(projection, initiator.zoneId, [
        initiatorId,
        responderId,
      ]);
      return true;
    } catch (error) {
      if (error instanceof AutonomyEventBuilderError) return false;
      throw error;
    }
  }

  visit(
    source: Readonly<TownProjection>,
    rawInput: AutonomyVisitInput,
  ): readonly TownEvent[] {
    const projection = parseProjection(source);
    const input = parseInput('visit', VisitInputSchema, rawInput);
    const resident = requireResident(projection, input.residentId);
    requireAvailable(resident);
    const timestamp = this.timestamp();
    const usedIds = new Set<string>();

    return [
      this.event(
        projection,
        0,
        input.zoneId,
        [input.residentId],
        'resident.moved',
        () => ({
          residentId: input.residentId,
          position: TOWN_ZONE_LAYOUT[input.zoneId].entrance,
        }),
        timestamp,
        usedIds,
      ),
    ];
  }

  encounter(
    source: Readonly<TownProjection>,
    rawInput: AutonomyEncounterInput,
  ): readonly TownEvent[] {
    const projection = parseProjection(source);
    const input = parseInput('encounter', EncounterInputSchema, rawInput);
    if (input.initiatorId === input.responderId) {
      throw new AutonomyEventBuilderError(
        'Encounter residents must be distinct',
      );
    }
    const initiator = requireResident(projection, input.initiatorId);
    const responder = requireResident(projection, input.responderId);
    requireAvailable(initiator);
    requireAvailable(responder);

    const participantIds = [input.initiatorId, input.responderId];
    const zoneId = input.zoneId ?? initiator.zoneId;
    const pair = requireEncounterPair(projection, zoneId, participantIds);
    const timestamp = this.timestamp();
    const usedIds = new Set<string>();
    const events: TownEvent[] = [];
    const append = (
      type: TownEvent['type'],
      payload: (eventId: string) => unknown,
    ) => {
      events.push(
        this.event(
          projection,
          events.length,
          zoneId,
          participantIds,
          type,
          payload,
          timestamp,
          usedIds,
        ),
      );
    };

    append('resident.moved', () => ({
      residentId: input.initiatorId,
      position: pair[0],
    }));
    append('resident.moved', () => ({
      residentId: input.responderId,
      position: pair[1],
    }));
    append('resident.spoke', () => ({
      residentId: input.initiatorId,
      text: input.opening,
    }));
    append('resident.spoke', () => ({
      residentId: input.responderId,
      text: input.reply,
    }));
    if (input.followUp) {
      append('resident.spoke', () => ({
        residentId: input.initiatorId,
        text: input.followUp,
      }));
    }
    append('residents.played', (eventId) => ({
      standalone: true,
      interactionId: eventId,
    }));

    const affinity = relationshipAffinity(
      projection,
      input.initiatorId,
      input.responderId,
    );
    const relationshipChange = autonomousPlayRelationshipChange(affinity);
    if (relationshipChange.delta !== 0) {
      append('relationship.changed', () => ({
        residentIdA: input.initiatorId,
        residentIdB: input.responderId,
        affinity: relationshipChange.affinity,
      }));
    }

    return events;
  }

  private timestamp(): string {
    let raw: string;
    try {
      raw = this.ports.now();
    } catch (error) {
      throw new AutonomyEventBuilderError(
        `Could not obtain event timestamp: ${errorMessage(error)}`,
        error,
      );
    }
    const parsed = TimestampSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AutonomyEventBuilderError('Event timestamp is invalid');
    }
    return parsed.data;
  }

  private event(
    projection: TownProjection,
    offset: number,
    zoneId: TownZoneId,
    participantIds: readonly string[],
    type: TownEvent['type'],
    payload: (eventId: string) => unknown,
    timestamp: string,
    usedIds: Set<string>,
  ): TownEvent {
    const id = this.uniqueEventId(usedIds);
    return TownEventSchema.parse({
      id,
      sessionId: projection.sessionId,
      sequence: projection.lastEventSequence + offset + 1,
      baseVersion: projection.version + offset,
      type,
      zoneId,
      participantIds,
      timestamp,
      payload: payload(id),
    });
  }

  private uniqueEventId(usedIds: Set<string>): string {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      let candidate: string;
      try {
        candidate = this.ports.nextId('town-event');
      } catch (error) {
        throw new AutonomyEventBuilderError(
          `Could not obtain event ID: ${errorMessage(error)}`,
          error,
        );
      }
      const parsed = IdentifierSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new AutonomyEventBuilderError('Event ID is invalid');
      }
      if (usedIds.has(parsed.data)) continue;
      usedIds.add(parsed.data);
      return parsed.data;
    }
    throw new AutonomyEventBuilderError(
      `Could not obtain a unique event ID after ${MAX_ID_ATTEMPTS} attempts`,
    );
  }
}

function parseProjection(source: Readonly<TownProjection>): TownProjection {
  try {
    return TownProjectionSchema.parse(structuredClone(source));
  } catch (error) {
    throw new AutonomyEventBuilderError(
      `Town projection validation failed: ${errorMessage(error)}`,
      error,
    );
  }
}

function parseInput<S extends z.ZodTypeAny>(
  label: string,
  schema: S,
  raw: unknown,
): z.output<S> {
  const parsed = schema.safeParse(structuredClone(raw));
  if (!parsed.success) {
    throw new AutonomyEventBuilderError(
      `Invalid ${label} input: ${parsed.error.message}`,
      parsed.error,
    );
  }
  return parsed.data as z.output<S>;
}

function requireResident(
  projection: TownProjection,
  residentId: string,
): TownResidentState {
  const resident = projection.residents.find(
    (candidate) => candidate.residentId === residentId,
  );
  if (resident === undefined) {
    throw new AutonomyEventBuilderError(`Unknown town resident: ${residentId}`);
  }
  return resident;
}

function requireAvailable(resident: TownResidentState): void {
  if (resident.availability !== 'available') {
    throw new AutonomyEventBuilderError(
      `Town resident is unavailable or busy: ${resident.residentId}`,
    );
  }
}

function requireEncounterPair(
  projection: TownProjection,
  zoneId: TownZoneId,
  participantIds: readonly string[],
) {
  const pairs = TOWN_ENCOUNTER_PAIRS[zoneId];
  if (pairs.length === 0) {
    throw new AutonomyEventBuilderError(
      `Town zone has no encounter pair: ${zoneId}`,
    );
  }
  const occupied = new Set(
    projection.residents
      .filter(({ residentId }) => !participantIds.includes(residentId))
      .map(({ position }) => `${position.x}:${position.y}`),
  );
  for (const pair of pairs) {
    requireWalkableEncounterPair(zoneId, pair);
    if (pair.every(({ x, y }) => !occupied.has(`${x}:${y}`))) return pair;
  }
  throw new AutonomyEventBuilderError(
    `Town zone has no available encounter pair; all pairs are occupied: ${zoneId}`,
  );
}

function requireWalkableEncounterPair(
  zoneId: TownZoneId,
  pair: (typeof TOWN_ENCOUNTER_PAIRS)[TownZoneId][number],
): void {
  if (pair[0].x === pair[1].x && pair[0].y === pair[1].y) {
    throw new AutonomyEventBuilderError(
      `Town zone encounter pair must be distinct: ${zoneId}`,
    );
  }
  const blocked = new Set(
    TOWN_STATIC_BLOCKED_CELLS.map(({ x, y }) => `${x}:${y}`),
  );
  const valid = pair.every(
    ({ x, y }) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      x < TOWN_GRID.width &&
      y >= 0 &&
      y < TOWN_GRID.height &&
      !blocked.has(`${x}:${y}`),
  );
  if (!valid) {
    throw new AutonomyEventBuilderError(
      `Town zone encounter pair is not walkable: ${zoneId}`,
    );
  }
}

function relationshipAffinity(
  projection: TownProjection,
  residentIdA: string,
  residentIdB: string,
): number {
  return (
    projection.relationships.find(
      (relationship) =>
        (relationship.residentIdA === residentIdA &&
          relationship.residentIdB === residentIdB) ||
        (relationship.residentIdA === residentIdB &&
          relationship.residentIdB === residentIdA),
    )?.affinity ?? 0
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
