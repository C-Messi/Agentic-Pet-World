import {
  TownEventSchema,
  TownProjectionSchema,
  type TownActivityInstance,
  type TownEvent,
  type TownJsonValue,
  type TownProjection,
  type TownResidentState,
} from '@cat-house/shared';

function domainError(message: string): never {
  throw new Error(`Town event rejected: ${message}`);
}

function requireResident(
  projection: TownProjection,
  residentId: string,
): TownResidentState {
  const resident = projection.residents.find(
    (candidate) => candidate.residentId === residentId,
  );
  return resident ?? domainError(`resident not found: ${residentId}`);
}

function requireActivity(
  projection: TownProjection,
  activityId: string,
): TownActivityInstance {
  const activity = projection.activities.find(
    (candidate) => candidate.id === activityId,
  );
  return activity ?? domainError(`activity not found: ${activityId}`);
}

function jsonObject(state: TownJsonValue): Record<string, TownJsonValue> {
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? state
    : {};
}

function occupyParticipants(
  projection: TownProjection,
  activity: TownActivityInstance,
): void {
  for (const residentId of activity.participantIds) {
    const resident = requireResident(projection, residentId);
    if (
      resident.availability === 'busy' &&
      resident.activityInstanceId !== activity.id
    ) {
      domainError(`resident is busy: ${residentId}`);
    }
    resident.zoneId = activity.zoneId;
    resident.availability = 'busy';
    resident.activityInstanceId = activity.id;
  }
}

function upsertActivity(
  projection: TownProjection,
  activity: TownActivityInstance,
): void {
  const index = projection.activities.findIndex(({ id }) => id === activity.id);
  if (index === -1) projection.activities.push(activity);
  else projection.activities[index] = activity;
  occupyParticipants(projection, activity);
}

function closeActivity(
  projection: TownProjection,
  activityId: string,
): TownActivityInstance {
  const activity = requireActivity(projection, activityId);
  projection.activities = projection.activities.filter(
    ({ id }) => id !== activityId,
  );
  for (const resident of projection.residents) {
    if (resident.activityInstanceId === activityId) {
      resident.availability = 'available';
      delete resident.activityInstanceId;
    }
  }
  return activity;
}

function assertEventReferences(
  projection: TownProjection,
  event: TownEvent,
): void {
  for (const residentId of event.participantIds)
    requireResident(projection, residentId);
}

function assertModificationCanBeAdded(
  projection: TownProjection,
  event: Extract<TownEvent, { type: 'build.completed' }>,
): void {
  const { modification } = event.payload;
  if (projection.modifications.some(({ id }) => id === modification.id)) {
    domainError(`modification already exists: ${modification.id}`);
  }
  const occupied = new Set(
    projection.modifications.flatMap(({ plotId, occupiedCells }) =>
      occupiedCells.map(({ x, y }) => `${plotId}:${x}:${y}`),
    ),
  );
  const conflict = modification.occupiedCells.find(({ x, y }) =>
    occupied.has(`${modification.plotId}:${x}:${y}`),
  );
  if (conflict !== undefined) {
    domainError(
      `occupied cell conflict at ${modification.plotId}:${conflict.x}:${conflict.y}`,
    );
  }
}

export function reduceTownEvent(
  projection: Readonly<TownProjection>,
  event: Readonly<TownEvent>,
): TownProjection {
  const next = TownProjectionSchema.parse(structuredClone(projection));
  const parsedEvent = TownEventSchema.parse(structuredClone(event));

  if (parsedEvent.sessionId !== next.sessionId)
    domainError('event session does not match projection');
  if (parsedEvent.baseVersion !== next.version)
    domainError('event base version does not match projection');
  if (parsedEvent.sequence !== next.lastEventSequence + 1)
    domainError('event sequence is not contiguous');
  assertEventReferences(next, parsedEvent);

  switch (parsedEvent.type) {
    case 'resident.moved': {
      const resident = requireResident(next, parsedEvent.payload.residentId);
      resident.position = parsedEvent.payload.position;
      if (parsedEvent.zoneId !== undefined)
        resident.zoneId = parsedEvent.zoneId;
      break;
    }
    case 'resident.spoke':
      requireResident(next, parsedEvent.payload.residentId);
      break;
    case 'residents.played': {
      const activity = requireActivity(
        next,
        parsedEvent.payload.activityInstanceId,
      );
      activity.version += 1;
      break;
    }
    case 'fortune.started': {
      const existing = next.activities.find(
        ({ id }) => id === parsedEvent.payload.fortuneId,
      );
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.fortuneId,
        activityId: 'fortune-draw',
        zoneId: parsedEvent.zoneId ?? existing?.zoneId ?? 'fortune-pavilion',
        participantIds: [...parsedEvent.participantIds],
        version: existing === undefined ? 1 : existing.version + 1,
        state: { status: 'started' },
      };
      upsertActivity(next, activity);
      break;
    }
    case 'fortune.revealed': {
      const activity = requireActivity(next, parsedEvent.payload.fortuneId);
      activity.version += 1;
      activity.state = {
        ...jsonObject(activity.state),
        status: 'revealed',
        reading: parsedEvent.payload.reading,
      };
      break;
    }
    case 'fortune.interpreted': {
      const activity = requireActivity(next, parsedEvent.payload.fortuneId);
      activity.version += 1;
      activity.state = {
        ...jsonObject(activity.state),
        status: 'interpreted',
        interpretation: parsedEvent.payload.interpretation,
      };
      break;
    }
    case 'build.started': {
      const existing = next.activities.find(
        ({ id }) => id === parsedEvent.payload.modificationId,
      );
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.modificationId,
        activityId: `build:${parsedEvent.payload.recipeId}`,
        zoneId: parsedEvent.zoneId ?? existing?.zoneId ?? 'build-plots',
        participantIds: [...parsedEvent.participantIds],
        version: existing === undefined ? 1 : existing.version + 1,
        state: {
          status: 'started',
          modificationId: parsedEvent.payload.modificationId,
          recipeId: parsedEvent.payload.recipeId,
          plotId: parsedEvent.payload.plotId,
        },
      };
      upsertActivity(next, activity);
      break;
    }
    case 'build.completed':
      assertModificationCanBeAdded(next, parsedEvent);
      next.modifications.push(parsedEvent.payload.modification);
      if (
        next.activities.some(
          ({ id }) => id === parsedEvent.payload.modification.id,
        )
      ) {
        closeActivity(next, parsedEvent.payload.modification.id);
      }
      break;
    case 'stall.opened': {
      const existing = next.activities.find(
        ({ id }) => id === parsedEvent.payload.stallId,
      );
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.stallId,
        activityId: 'showcase-stall',
        zoneId: parsedEvent.zoneId ?? existing?.zoneId ?? 'market',
        participantIds: [...parsedEvent.participantIds],
        version: existing === undefined ? 1 : existing.version + 1,
        state: {
          status: 'open',
          showcaseItemIds: [...parsedEvent.payload.showcaseItemIds],
        },
      };
      upsertActivity(next, activity);
      break;
    }
    case 'stall.visited': {
      requireResident(next, parsedEvent.payload.visitorResidentId);
      const activity = requireActivity(next, parsedEvent.payload.stallId);
      activity.version += 1;
      activity.state = {
        ...jsonObject(activity.state),
        lastVisitorResidentId: parsedEvent.payload.visitorResidentId,
      };
      break;
    }
    case 'stall.closed':
      closeActivity(next, parsedEvent.payload.stallId);
      break;
    case 'outing.started':
    case 'outing.returned': {
      const resident = requireResident(next, parsedEvent.payload.residentId);
      if (parsedEvent.zoneId !== undefined)
        resident.zoneId = parsedEvent.zoneId;
      break;
    }
    case 'relationship.changed': {
      requireResident(next, parsedEvent.payload.residentIdA);
      requireResident(next, parsedEvent.payload.residentIdB);
      const key = [
        parsedEvent.payload.residentIdA,
        parsedEvent.payload.residentIdB,
      ].sort();
      const existing = next.relationships.find(
        ({ residentIdA, residentIdB }) =>
          (residentIdA === key[0] && residentIdB === key[1]) ||
          (residentIdA === key[1] && residentIdB === key[0]),
      );
      const relationship = {
        residentIdA: existing?.residentIdA ?? key[0]!,
        residentIdB: existing?.residentIdB ?? key[1]!,
        affinity: parsedEvent.payload.affinity,
        sourceEventId: parsedEvent.id,
        sourceVersion: next.version + 1,
      };
      if (existing === undefined) next.relationships.push(relationship);
      else Object.assign(existing, relationship);
      break;
    }
    default: {
      const exhaustive: never = parsedEvent;
      return exhaustive;
    }
  }

  next.version += 1;
  next.lastEventSequence = parsedEvent.sequence;
  return TownProjectionSchema.parse(next);
}
