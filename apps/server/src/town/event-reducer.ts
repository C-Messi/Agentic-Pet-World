import {
  TownEventSchema,
  TownProjectionSchema,
  type TownActivityInstance,
  type TownEvent,
  type TownJsonValue,
  type TownProjection,
  type TownResidentState,
} from '@cat-house/shared';

export type TownReducerErrorCode =
  'stale-version' | 'stale-sequence' | 'invalid-reference' | 'conflict';

export class TownReducerError extends Error {
  constructor(
    readonly code: TownReducerErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(`Town event rejected: ${message}`);
    this.name = 'TownReducerError';
  }
}

function domainError(
  message: string,
  code: TownReducerErrorCode = 'conflict',
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new TownReducerError(code, message, context);
}

function requireResident(
  projection: TownProjection,
  residentId: string,
): TownResidentState {
  const resident = projection.residents.find(
    (candidate) => candidate.residentId === residentId,
  );
  return (
    resident ??
    domainError(`resident not found: ${residentId}`, 'invalid-reference', {
      residentId,
    })
  );
}

function requireActivity(
  projection: TownProjection,
  activityId: string,
): TownActivityInstance {
  const activity = projection.activities.find(
    (candidate) => candidate.id === activityId,
  );
  return (
    activity ??
    domainError(`activity not found: ${activityId}`, 'invalid-reference', {
      activityId,
    })
  );
}

function requireFreshActivityId(
  projection: TownProjection,
  activityId: string,
): void {
  if (
    projection.activities.some(({ id }) => id === activityId) ||
    projection.modifications.some(({ id }) => id === activityId)
  ) {
    domainError(`activity already exists: ${activityId}`);
  }
}

function assertActivityTransition(
  activity: TownActivityInstance,
  event: TownEvent,
  expectedActivityId: string,
): void {
  if (activity.activityId !== expectedActivityId) {
    domainError(
      `activity kind mismatch: expected ${expectedActivityId}, received ${activity.activityId}`,
    );
  }
  if (
    event.participantIds.length !== activity.participantIds.length ||
    !event.participantIds.every((residentId) =>
      activity.participantIds.includes(residentId),
    )
  ) {
    domainError('event participants do not match activity participants');
  }
  if (event.zoneId === undefined || event.zoneId !== activity.zoneId) {
    domainError('event zone does not match activity zone');
  }
}

function assertStandalonePlayEncounter(
  projection: TownProjection,
  event: Extract<TownEvent, { type: 'residents.played' }>,
): void {
  requireFreshActivityId(projection, event.payload.activityInstanceId);
  if (event.participantIds.length !== 2) {
    domainError('standalone play requires exactly two participants');
  }
  if (event.zoneId === undefined) {
    domainError('standalone play requires an event zone');
  }
  for (const residentId of event.participantIds) {
    const resident = requireResident(projection, residentId);
    if (resident.availability !== 'available') {
      domainError(
        `standalone play participant is unavailable or busy: ${residentId}`,
        'conflict',
        {
          residentId,
          activityId: resident.activityInstanceId,
        },
      );
    }
    if (resident.zoneId !== event.zoneId) {
      domainError(
        `standalone play participant zone does not match event zone: ${residentId}`,
        'conflict',
        {
          residentId,
          residentZoneId: resident.zoneId,
          eventZoneId: event.zoneId,
        },
      );
    }
  }
}

function assertStallVisit(
  projection: TownProjection,
  activity: TownActivityInstance,
  event: Extract<TownEvent, { type: 'stall.visited' }>,
): void {
  if (activity.activityId !== 'showcase-stall') {
    domainError(
      `activity kind mismatch: expected showcase-stall, received ${activity.activityId}`,
    );
  }
  if (event.zoneId === undefined || event.zoneId !== activity.zoneId) {
    domainError('event zone does not match activity zone');
  }
  if (
    !activity.participantIds.every((residentId) =>
      event.participantIds.includes(residentId),
    )
  ) {
    domainError('stall visit participants do not include the stall owner');
  }
  if (!event.participantIds.includes(event.payload.visitorResidentId)) {
    domainError('stall visit participants do not include the visitor');
  }
  const visitor = requireResident(projection, event.payload.visitorResidentId);
  if (visitor.availability !== 'available') {
    domainError(`stall visitor is unavailable or busy: ${visitor.residentId}`);
  }
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
    domainError(
      'event base version does not match projection',
      'stale-version',
      {
        expected: next.version,
        received: parsedEvent.baseVersion,
      },
    );
  if (parsedEvent.sequence !== next.lastEventSequence + 1)
    domainError('event sequence is not contiguous', 'stale-sequence', {
      expected: next.lastEventSequence + 1,
      received: parsedEvent.sequence,
    });
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
      if ('standalone' in parsedEvent.payload) {
        assertStandalonePlayEncounter(next, parsedEvent);
        break;
      }
      const activity = requireActivity(
        next,
        parsedEvent.payload.activityInstanceId,
      );
      assertActivityTransition(activity, parsedEvent, 'social-play');
      activity.version += 1;
      break;
    }
    case 'activity.started': {
      const { activity } = parsedEvent.payload;
      requireFreshActivityId(next, activity.id);
      for (const residentId of activity.participantIds) {
        const resident = requireResident(next, residentId);
        if (resident.availability !== 'available') {
          domainError(`resident is busy: ${residentId}`, 'conflict', {
            residentId,
            activityId: resident.activityInstanceId,
          });
        }
      }
      upsertActivity(next, activity);
      break;
    }
    case 'fortune.started': {
      requireFreshActivityId(next, parsedEvent.payload.activityInstanceId);
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.activityInstanceId,
        activityId: 'fortune-draw',
        zoneId: parsedEvent.zoneId ?? 'fortune-pavilion',
        participantIds: [...parsedEvent.participantIds],
        version: 1,
        state: { status: 'started' },
      };
      upsertActivity(next, activity);
      break;
    }
    case 'fortune.revealed': {
      const activity = requireActivity(
        next,
        parsedEvent.payload.activityInstanceId,
      );
      assertActivityTransition(activity, parsedEvent, 'fortune-draw');
      const state = jsonObject(activity.state);
      if (state.status !== 'started' || state.fortuneId !== undefined) {
        domainError('fortune activity has already been revealed');
      }
      activity.version += 1;
      activity.state = {
        status: 'revealed',
        fortuneId: parsedEvent.payload.fortuneId,
        rank: parsedEvent.payload.rank,
      };
      break;
    }
    case 'fortune.interpreted': {
      const activity = requireActivity(
        next,
        parsedEvent.payload.activityInstanceId,
      );
      assertActivityTransition(activity, parsedEvent, 'fortune-draw');
      const state = jsonObject(activity.state);
      if (state.status !== 'revealed' || typeof state.fortuneId !== 'string') {
        domainError('fortune must be revealed before interpretation');
      }
      if (state.fortuneId !== parsedEvent.payload.fortuneId) {
        domainError('selected fortune ID does not match the reveal');
      }
      activity.version += 1;
      activity.state = {
        ...state,
        status: 'interpreted',
        interpretation: parsedEvent.payload.interpretation,
      };
      break;
    }
    case 'build.started': {
      if (
        next.modifications.some(
          ({ id }) => id === parsedEvent.payload.modificationId,
        )
      ) {
        domainError(
          `modification already exists: ${parsedEvent.payload.modificationId}`,
        );
      }
      requireFreshActivityId(next, parsedEvent.payload.modificationId);
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.modificationId,
        activityId: `build:${parsedEvent.payload.recipeId}`,
        zoneId: parsedEvent.zoneId ?? 'build-plots',
        participantIds: [...parsedEvent.participantIds],
        version: 1,
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
    case 'build.completed': {
      const buildActivity = requireActivity(
        next,
        parsedEvent.payload.modification.id,
      );
      assertModificationCanBeAdded(next, parsedEvent);
      const { modification } = parsedEvent.payload;
      assertActivityTransition(
        buildActivity,
        parsedEvent,
        `build:${modification.recipeId}`,
      );
      const state = jsonObject(buildActivity.state);
      if (state.modificationId !== modification.id)
        domainError('build modification ID does not match started activity');
      if (state.recipeId !== modification.recipeId)
        domainError('build recipe does not match started activity');
      if (state.plotId !== modification.plotId)
        domainError('build plot does not match started activity');
      next.modifications.push(parsedEvent.payload.modification);
      closeActivity(next, parsedEvent.payload.modification.id);
      break;
    }
    case 'stall.opened': {
      requireFreshActivityId(next, parsedEvent.payload.stallId);
      const activity: TownActivityInstance = {
        id: parsedEvent.payload.stallId,
        activityId: 'showcase-stall',
        zoneId: parsedEvent.zoneId ?? 'market',
        participantIds: [...parsedEvent.participantIds],
        version: 1,
        state: {
          status: 'open',
          showcaseItemIds: [...parsedEvent.payload.showcaseItemIds],
        },
      };
      upsertActivity(next, activity);
      break;
    }
    case 'stall.visited': {
      const activity = requireActivity(next, parsedEvent.payload.stallId);
      assertStallVisit(next, activity, parsedEvent);
      activity.version += 1;
      activity.state = {
        ...jsonObject(activity.state),
        lastVisitorResidentId: parsedEvent.payload.visitorResidentId,
      };
      break;
    }
    case 'stall.closed': {
      const activity = requireActivity(next, parsedEvent.payload.stallId);
      assertActivityTransition(activity, parsedEvent, 'showcase-stall');
      closeActivity(next, parsedEvent.payload.stallId);
      break;
    }
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
