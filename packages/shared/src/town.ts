import { z } from 'zod';

import { PetDefinitionSchema } from './pet.js';
import { IdentifierSchema, PositionSchema } from './protocol.js';

const TimestampSchema = z.string().datetime({ offset: true });
const TextSchema = z.string().trim().min(1).max(280);
const VersionSchema = z.number().int().nonnegative();
const ParticipantIdsSchema = z
  .array(IdentifierSchema)
  .min(1)
  .max(4)
  .superRefine((ids, context) => addDuplicateIssues(ids, context));

export const TownZoneIdSchema = z.enum([
  'gate',
  'plaza',
  'fortune-pavilion',
  'market',
  'garden',
  'build-plots',
  'arcade-house',
]);
export type TownZoneId = z.infer<typeof TownZoneIdSchema>;

export const TownEventTypeSchema = z.enum([
  'resident.moved',
  'resident.spoke',
  'residents.played',
  'activity.started',
  'fortune.started',
  'fortune.revealed',
  'fortune.interpreted',
  'build.started',
  'build.completed',
  'stall.opened',
  'stall.visited',
  'stall.closed',
  'outing.started',
  'outing.returned',
  'relationship.changed',
]);
export type TownEventType = z.infer<typeof TownEventTypeSchema>;

export const TownFortuneRankSchema = z.enum(['great', 'good', 'neutral', 'caution']);
export type TownFortuneRank = z.infer<typeof TownFortuneRankSchema>;

const SocializeIntentSchema = z
  .object({ type: z.literal('socialize'), actorId: IdentifierSchema, targetResidentId: IdentifierSchema })
  .strict()
  .refine(({ actorId, targetResidentId }) => actorId !== targetResidentId, {
    message: 'A resident cannot socialize with itself',
    path: ['targetResidentId'],
  });
const VisitZoneIntentSchema = z
  .object({ type: z.literal('visit-zone'), actorId: IdentifierSchema, zoneId: TownZoneIdSchema })
  .strict();
const StartActivityIntentSchema = z
  .object({
    type: z.literal('start-activity'),
    actorId: IdentifierSchema,
    activityId: IdentifierSchema,
    invitedResidentIds: z.array(IdentifierSchema).max(3),
  })
  .strict()
  .superRefine(({ actorId, invitedResidentIds }, context) => {
    addDuplicateIssues(invitedResidentIds, context, ['invitedResidentIds']);
    if (invitedResidentIds.includes(actorId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The actor cannot also be invited',
        path: ['invitedResidentIds'],
      });
    }
  });
const BuildIntentSchema = z
  .object({ type: z.literal('build'), actorId: IdentifierSchema, recipeId: IdentifierSchema, plotId: IdentifierSchema })
  .strict();
const OpenStallIntentSchema = z
  .object({
    type: z.literal('open-stall'),
    actorId: IdentifierSchema,
    stallId: IdentifierSchema,
    showcaseItemIds: z.array(IdentifierSchema).min(1).max(3),
  })
  .strict()
  .superRefine(({ showcaseItemIds }, context) => addDuplicateIssues(showcaseItemIds, context, ['showcaseItemIds']));
const ReturnHomeIntentSchema = z
  .object({ type: z.literal('return-home'), actorId: IdentifierSchema })
  .strict();

export const TownIntentSchema = z.union([
  SocializeIntentSchema,
  VisitZoneIntentSchema,
  StartActivityIntentSchema,
  BuildIntentSchema,
  OpenStallIntentSchema,
  ReturnHomeIntentSchema,
]);
export type TownIntent = z.infer<typeof TownIntentSchema>;

export const TownResidentStateSchema = z
  .object({
    residentId: IdentifierSchema,
    pet: PetDefinitionSchema,
    position: PositionSchema,
    zoneId: TownZoneIdSchema,
    activityInstanceId: IdentifierSchema.optional(),
    availability: z.enum(['available', 'busy']),
  })
  .strict()
  .superRefine(({ activityInstanceId, availability }, context) => {
    if (availability === 'busy' && !activityInstanceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Busy residents require an activity', path: ['activityInstanceId'] });
    }
    if (availability === 'available' && activityInstanceId) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Available residents cannot have an activity', path: ['activityInstanceId'] });
    }
  });
export type TownResidentState = z.infer<typeof TownResidentStateSchema>;

export const TownRelationshipSchema = z
  .object({
    residentIdA: IdentifierSchema,
    residentIdB: IdentifierSchema,
    affinity: z.number().finite().min(-1).max(1),
    sourceEventId: IdentifierSchema,
    sourceVersion: VersionSchema,
  })
  .strict()
  .refine(({ residentIdA, residentIdB }) => residentIdA !== residentIdB, {
    message: 'Relationship residents must be distinct',
    path: ['residentIdB'],
  });
export type TownRelationship = z.infer<typeof TownRelationshipSchema>;

const GridCellSchema = z.object({ x: z.number().int().min(-1_000).max(1_000), y: z.number().int().min(-1_000).max(1_000) }).strict();
export const TownWorldModificationSchema = z
  .object({
    id: IdentifierSchema,
    recipeId: IdentifierSchema,
    plotId: IdentifierSchema,
    occupiedCells: z.array(GridCellSchema).min(1).max(64),
    atlasFrame: z.number().int().nonnegative().max(65_535),
    collision: z.boolean(),
  })
  .strict()
  .superRefine(({ occupiedCells }, context) => {
    addDuplicateIssues(occupiedCells.map(({ x, y }) => `${x}:${y}`), context, ['occupiedCells']);
  });
export type TownWorldModification = z.infer<typeof TownWorldModificationSchema>;

export type TownJsonValue = null | boolean | number | string | TownJsonValue[] | { [key: string]: TownJsonValue };

function boundedJsonSchema(depth: number): z.ZodType<TownJsonValue> {
  const primitive: z.ZodType<TownJsonValue> = z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(280),
  ]);
  if (depth === 0) return primitive;
  const child = boundedJsonSchema(depth - 1);
  const array = z.preprocess(
    (value) => {
      if (Array.isArray(value) && Reflect.ownKeys(value).some((key) => !isJsonArrayKey(key))) {
        return Symbol('invalid-json-array');
      }
      return value;
    },
    z.array(child).max(32),
  );
  const object = z.preprocess(
    (value) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const prototype = Object.getPrototypeOf(value) as object | null;
        if (prototype !== Object.prototype && prototype !== null) return Symbol('invalid-json-object');
        if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) return Symbol('invalid-json-key');
      }
      return value;
    },
    z.record(z.string().min(1).max(64), child).superRefine((value, context) => {
      if (Object.keys(value).length > 32) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'JSON objects may have at most 32 keys' });
      }
    }),
  );
  return z.union([primitive, array, object]) as z.ZodType<TownJsonValue>;
}

function isJsonArrayKey(key: string | symbol): boolean {
  if (key === 'length') return true;
  if (typeof key === 'symbol' || !/^(0|[1-9][0-9]*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295;
}

export const TownActivityStateSchema = boundedJsonSchema(5);
export const TownActivityInstanceSchema = z
  .object({
    id: IdentifierSchema,
    activityId: IdentifierSchema,
    zoneId: TownZoneIdSchema,
    participantIds: ParticipantIdsSchema,
    version: VersionSchema,
    state: TownActivityStateSchema,
  })
  .strict();
export type TownActivityInstance = z.infer<typeof TownActivityInstanceSchema>;

type TownProjectionData = {
  sessionId: string;
  version: number;
  lastEventSequence: number;
  residents: z.infer<typeof TownResidentStateSchema>[];
  relationships: z.infer<typeof TownRelationshipSchema>[];
  modifications: z.infer<typeof TownWorldModificationSchema>[];
  activities: z.infer<typeof TownActivityInstanceSchema>[];
};

export const TownProjectionSchema = z
  .object({
    sessionId: IdentifierSchema,
    version: VersionSchema,
    lastEventSequence: VersionSchema,
    residents: z.array(TownResidentStateSchema).min(1).max(16),
    relationships: z.array(TownRelationshipSchema).max(120),
    modifications: z.array(TownWorldModificationSchema).max(128),
    activities: z.array(TownActivityInstanceSchema).max(16),
  })
  .strict()
  .superRefine((projection, context) => validateProjection(projection, context));
export type TownProjection = z.infer<typeof TownProjectionSchema>;

const EventBase = {
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  sequence: z.number().int().positive(),
  baseVersion: VersionSchema,
  zoneId: TownZoneIdSchema.optional(),
  participantIds: ParticipantIdsSchema,
  timestamp: TimestampSchema,
};
const event = <T extends TownEventType, S extends z.ZodTypeAny>(type: T, payload: S) =>
  z.object({ ...EventBase, type: z.literal(type), payload }).strict();
const ResidentIdPayload = z.object({ residentId: IdentifierSchema }).strict();
const FortunePayload = z.object({ activityInstanceId: IdentifierSchema }).strict();
const BuildPayload = z.object({ modificationId: IdentifierSchema, recipeId: IdentifierSchema, plotId: IdentifierSchema }).strict();
const BuildCompletedPayload = z.object({ modification: TownWorldModificationSchema }).strict();
const FortuneRevealedPayload = z
  .object({
    activityInstanceId: IdentifierSchema,
    fortuneId: IdentifierSchema,
    rank: TownFortuneRankSchema,
  })
  .strict()
  .refine(({ activityInstanceId, fortuneId }) => activityInstanceId !== fortuneId, {
    message: 'Fortune activity and result IDs must be distinct',
    path: ['fortuneId'],
  });
const FortuneInterpretedPayload = z
  .object({
    activityInstanceId: IdentifierSchema,
    fortuneId: IdentifierSchema,
    interpretation: TextSchema,
  })
  .strict()
  .refine(({ activityInstanceId, fortuneId }) => activityInstanceId !== fortuneId, {
    message: 'Fortune activity and result IDs must be distinct',
    path: ['fortuneId'],
  });

export const TownEventSchema = z.discriminatedUnion('type', [
  event('resident.moved', z.object({ residentId: IdentifierSchema, position: PositionSchema }).strict()),
  event('resident.spoke', z.object({ residentId: IdentifierSchema, text: TextSchema }).strict()),
  event('residents.played', z.object({ activityInstanceId: IdentifierSchema }).strict()),
  event('activity.started', z.object({ activity: TownActivityInstanceSchema }).strict()),
  event('fortune.started', FortunePayload),
  event('fortune.revealed', FortuneRevealedPayload),
  event('fortune.interpreted', FortuneInterpretedPayload),
  event('build.started', BuildPayload),
  event('build.completed', BuildCompletedPayload),
  event('stall.opened', z.object({ stallId: IdentifierSchema, showcaseItemIds: z.array(IdentifierSchema).min(1).max(3) }).strict()),
  event('stall.visited', z.object({ stallId: IdentifierSchema, visitorResidentId: IdentifierSchema }).strict()),
  event('stall.closed', z.object({ stallId: IdentifierSchema }).strict()),
  event('outing.started', ResidentIdPayload),
  event('outing.returned', ResidentIdPayload),
  event('relationship.changed', z.object({ residentIdA: IdentifierSchema, residentIdB: IdentifierSchema, affinity: z.number().finite().min(-1).max(1) }).strict().refine(({ residentIdA, residentIdB }) => residentIdA !== residentIdB)),
]).superRefine((value, context) => {
  const payloadIds = eventResidentIds(value);
  for (const id of payloadIds) {
    if (!value.participantIds.includes(id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `Payload resident ${id} must be a participant`, path: ['participantIds'] });
    }
  }
  if (value.type === 'stall.opened') addDuplicateIssues(value.payload.showcaseItemIds, context, ['payload', 'showcaseItemIds']);
  if (value.type === 'activity.started') {
    if (!sameIdentifierSet(value.participantIds, value.payload.activity.participantIds)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity start participants must exactly match the activity', path: ['participantIds'] });
    if (value.zoneId !== value.payload.activity.zoneId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity start zone must match the activity', path: ['zoneId'] });
  }
});
export type TownEvent = z.infer<typeof TownEventSchema>;

export const TownOutingSchema = z
  .object({
    sessionId: IdentifierSchema,
    residentId: IdentifierSchema,
    status: z.enum(['home', 'town', 'returning']),
    startedAt: TimestampSchema.optional(),
    lastConfirmedAt: TimestampSchema.optional(),
    returnedAt: TimestampSchema.optional(),
    recoveryWindowEndsAt: TimestampSchema.optional(),
  })
  .strict()
  .superRefine((outing, context) => {
    if (outing.status !== 'home' && (!outing.startedAt || !outing.lastConfirmedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Active outings require start and confirmation timestamps' });
    }
    if (outing.status === 'returning' && !outing.recoveryWindowEndsAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Returning outings require a recovery window', path: ['recoveryWindowEndsAt'] });
    }
    if (outing.status !== 'home' && outing.returnedAt) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only home outings may have a returned timestamp', path: ['returnedAt'] });
    }
  });
export type TownOuting = z.infer<typeof TownOutingSchema>;

export const PublicShowcaseItemSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    kind: z.enum(['text', 'interest', 'work']),
    title: TextSchema,
    content: TextSchema,
    presetIconId: IdentifierSchema,
    isPublic: z.literal(true),
  })
  .strict();
export type PublicShowcaseItem = z.infer<typeof PublicShowcaseItemSchema>;

export const ExperienceCardSchema = z
  .object({
    id: IdentifierSchema,
    sessionId: IdentifierSchema,
    title: TextSchema,
    body: TextSchema,
    location: TownZoneIdSchema,
    participantIds: ParticipantIdsSchema,
    sourceEventIds: z.array(IdentifierSchema).min(1).max(5),
    timestamp: TimestampSchema,
  })
  .strict()
  .superRefine(({ sourceEventIds }, context) => addDuplicateIssues(sourceEventIds, context, ['sourceEventIds']));
export type ExperienceCard = z.infer<typeof ExperienceCardSchema>;

const eventsSchema = (max: number) => z.array(TownEventSchema).max(max).superRefine((events, context) => validateEvents(events, context));
const cardsSchema = (max: number) => z.array(ExperienceCardSchema).max(max).superRefine((cards, context) => addDuplicateIssues(cards.map(({ id }) => id), context));
const EventsSchema = eventsSchema(24);
const CardsSchema = cardsSchema(100);
const OutingsSchema = z.array(TownOutingSchema).max(16).superRefine((outings, context) => addDuplicateIssues(outings.map(({ residentId }) => residentId), context));
const ShowcaseItemsSchema = z.array(PublicShowcaseItemSchema).max(12).superRefine((items, context) => addDuplicateIssues(items.map(({ id }) => id), context));

export const TownSnapshotResponseSchema = z.object({ projection: TownProjectionSchema, outings: OutingsSchema, showcaseItems: ShowcaseItemsSchema, experienceCards: CardsSchema }).strict().superRefine((value, context) => validateSnapshotResponse(value, context));
export type TownSnapshotResponse = z.infer<typeof TownSnapshotResponseSchema>;

export const TownReleaseRequestSchema = z.object({ sessionId: IdentifierSchema, residentId: IdentifierSchema }).strict();
export type TownReleaseRequest = z.infer<typeof TownReleaseRequestSchema>;
export const TownReleaseResponseSchema = z.object({ outing: TownOutingSchema, projection: TownProjectionSchema }).strict().superRefine((value, context) => validateOutingProjection(value, context));
export type TownReleaseResponse = z.infer<typeof TownReleaseResponseSchema>;

export const TownRecallRequestSchema = TownReleaseRequestSchema;
export type TownRecallRequest = z.infer<typeof TownRecallRequestSchema>;
export const TownRecallResponseSchema = TownReleaseResponseSchema;
export type TownRecallResponse = z.infer<typeof TownRecallResponseSchema>;

export const TownAdvanceRequestSchema = z.object({ sessionId: IdentifierSchema, baseVersion: VersionSchema, intents: z.array(TownIntentSchema).min(1).max(16) }).strict();
export type TownAdvanceRequest = z.infer<typeof TownAdvanceRequestSchema>;
export const TownAdvanceResponseSchema = z.object({ projection: TownProjectionSchema, events: EventsSchema }).strict().superRefine((value, context) => validateProjectionEventsResponse(value, context));
export type TownAdvanceResponse = z.infer<typeof TownAdvanceResponseSchema>;

const TownEventResultSchema = z.object({ eventId: IdentifierSchema, status: z.enum(['applied', 'failed']), message: TextSchema.optional() }).strict();
export const TownEventResultsRequestSchema = z.object({ sessionId: IdentifierSchema, baseVersion: VersionSchema, results: z.array(TownEventResultSchema).min(1).max(24) }).strict().superRefine(({ results }, context) => addDuplicateIssues(results.map(({ eventId }) => eventId), context, ['results']));
export type TownEventResultsRequest = z.infer<typeof TownEventResultsRequestSchema>;
export const TownEventResultsResponseSchema = z.object({ projection: TownProjectionSchema, acceptedEventIds: z.array(IdentifierSchema).max(24) }).strict().superRefine(({ acceptedEventIds }, context) => addDuplicateIssues(acceptedEventIds, context, ['acceptedEventIds']));
export type TownEventResultsResponse = z.infer<typeof TownEventResultsResponseSchema>;

export const OfflineRecoveryRequestSchema = z.object({ sessionId: IdentifierSchema, residentId: IdentifierSchema, lastConfirmedAt: TimestampSchema, recoveryWindowId: IdentifierSchema }).strict();
export type OfflineRecoveryRequest = z.infer<typeof OfflineRecoveryRequestSchema>;
export const OfflineRecoveryResponseSchema = z.object({ outing: TownOutingSchema, projection: TownProjectionSchema, events: eventsSchema(5), experienceCards: cardsSchema(5) }).strict().superRefine((value, context) => { validateOutingProjection(value, context); validateProjectionEventsResponse(value, context); validateProjectionCards(value, context); validateCardEventReferences(value, context); });
export type OfflineRecoveryResponse = z.infer<typeof OfflineRecoveryResponseSchema>;

export const TownHistoryResponseSchema = z.object({ sessionId: IdentifierSchema, events: EventsSchema, experienceCards: CardsSchema }).strict().superRefine((value, context) => { validateHistorySession(value, context); validateCardEventReferences(value, context); });
export type TownHistoryResponse = z.infer<typeof TownHistoryResponseSchema>;
export const TownRelationshipsResponseSchema = z.object({ sessionId: IdentifierSchema, relationships: z.array(TownRelationshipSchema).max(120) }).strict().superRefine(({ relationships }, context) => validateRelationshipPairs(relationships, context));
export type TownRelationshipsResponse = z.infer<typeof TownRelationshipsResponseSchema>;
export const ExperienceCardsResponseSchema = z.object({ sessionId: IdentifierSchema, experienceCards: CardsSchema }).strict().superRefine(({ sessionId, experienceCards }, context) => validateSessionRecords(sessionId, experienceCards, context, 'experienceCards'));
export type ExperienceCardsResponse = z.infer<typeof ExperienceCardsResponseSchema>;

export const ShowcaseListResponseSchema = z.object({ sessionId: IdentifierSchema, items: ShowcaseItemsSchema }).strict().superRefine(({ sessionId, items }, context) => validateSessionRecords(sessionId, items, context, 'items'));
export type ShowcaseListResponse = z.infer<typeof ShowcaseListResponseSchema>;
export const ShowcaseUpsertRequestSchema = z.object({ item: PublicShowcaseItemSchema }).strict();
export type ShowcaseUpsertRequest = z.infer<typeof ShowcaseUpsertRequestSchema>;
export const ShowcaseUpsertResponseSchema = ShowcaseUpsertRequestSchema;
export type ShowcaseUpsertResponse = z.infer<typeof ShowcaseUpsertResponseSchema>;
export const ShowcaseDeleteRequestSchema = z.object({ sessionId: IdentifierSchema, itemId: IdentifierSchema }).strict();
export type ShowcaseDeleteRequest = z.infer<typeof ShowcaseDeleteRequestSchema>;
export const ShowcaseDeleteResponseSchema = z.object({ deletedItemId: IdentifierSchema }).strict();
export type ShowcaseDeleteResponse = z.infer<typeof ShowcaseDeleteResponseSchema>;

function addDuplicateIssues(values: readonly string[], context: z.RefinementCtx, path: (string | number)[] = []) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate value: ${value}`, path: [...path, index] });
    seen.add(value);
  });
}

function validateRelationshipPairs(relationships: readonly z.infer<typeof TownRelationshipSchema>[], context: z.RefinementCtx, path: (string | number)[] = []) {
  const pairs = relationships.map(({ residentIdA, residentIdB }) => [residentIdA, residentIdB].sort().join('\0'));
  addDuplicateIssues(pairs, context, path);
}

function validateProjection(projection: TownProjectionData, context: z.RefinementCtx) {
  const residentIds = projection.residents.map(({ residentId }) => residentId);
  addDuplicateIssues(residentIds, context, ['residents']);
  if (projection.residents.filter(({ pet }) => pet.source === 'player-pet').length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Projection requires exactly one player pet', path: ['residents'] });
  }
  const residentSet = new Set(residentIds);
  validateRelationshipPairs(projection.relationships, context, ['relationships']);
  projection.relationships.forEach((relationship, index) => {
    for (const field of ['residentIdA', 'residentIdB'] as const) if (!residentSet.has(relationship[field])) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Relationship references an unknown resident', path: ['relationships', index, field] });
    if (relationship.sourceVersion > projection.version) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Relationship source version is ahead of the projection', path: ['relationships', index, 'sourceVersion'] });
  });
  addDuplicateIssues(projection.modifications.map(({ id }) => id), context, ['modifications']);
  const occupiedCells = new Set<string>();
  projection.modifications.forEach(({ plotId, occupiedCells: cells }, modificationIndex) => {
    cells.forEach(({ x, y }, cellIndex) => {
      const key = `${plotId}:${x}:${y}`;
      if (occupiedCells.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate occupied cell: ${x}:${y}`, path: ['modifications', modificationIndex, 'occupiedCells', cellIndex] });
      occupiedCells.add(key);
    });
  });
  addDuplicateIssues(projection.activities.map(({ id }) => id), context, ['activities']);
  const activityIds = new Set(projection.activities.map(({ id }) => id));
  projection.activities.forEach((activity, index) => activity.participantIds.forEach((id) => {
    if (!residentSet.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity references an unknown resident', path: ['activities', index, 'participantIds'] });
    const resident = projection.residents.find(({ residentId }) => residentId === id);
    if (resident && (resident.availability !== 'busy' || resident.activityInstanceId !== activity.id || resident.zoneId !== activity.zoneId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity participant state must match the activity', path: ['activities', index, 'participantIds'] });
    }
  }));
  projection.residents.forEach((value, index) => {
    if (value.activityInstanceId && !activityIds.has(value.activityInstanceId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resident references an unknown activity', path: ['residents', index, 'activityInstanceId'] });
    const activity = projection.activities.find(({ id }) => id === value.activityInstanceId);
    if (activity && (!activity.participantIds.includes(value.residentId) || activity.zoneId !== value.zoneId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Resident activity state is inconsistent', path: ['residents', index, 'activityInstanceId'] });
  });
}

function eventResidentIds(value: z.infer<typeof TownEventSchema>): string[] {
  switch (value.type) {
    case 'resident.moved': case 'resident.spoke': case 'outing.started': case 'outing.returned': return [value.payload.residentId];
    case 'stall.visited': return [value.payload.visitorResidentId];
    case 'relationship.changed': return [value.payload.residentIdA, value.payload.residentIdB];
    default: return [];
  }
}

function validateEvents(events: readonly z.infer<typeof TownEventSchema>[], context: z.RefinementCtx) {
  addDuplicateIssues(events.map(({ id }) => id), context);
  addDuplicateIssues(events.map(({ sequence }) => String(sequence)), context);
  const startedActivityIds = new Set<string>();
  events.forEach((townEvent, index) => {
    const startedActivity = activityStartedByEvent(townEvent);
    if (!startedActivity) return;
    const activityId = startedActivity.id;
    if (startedActivityIds.has(activityId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate activity start', path: [index, ...activityStartIdPath(townEvent)] });
    startedActivityIds.add(activityId);
  });
}

function validateProjectionEventsResponse(value: { projection: z.infer<typeof TownProjectionSchema>; events: z.infer<typeof TownEventSchema>[] }, context: z.RefinementCtx) {
  const residents = new Set(value.projection.residents.map(({ residentId }) => residentId));
  const activities = new Map(value.projection.activities.map((activity) => [activity.id, activity]));
  const finalModifications = new Map(value.projection.modifications.map((modification) => [modification.id, modification]));
  const completedModificationIds = new Set<string>();
  const completedOccupiedCells = new Set<string>();
  const startedActivityIds = new Set<string>();
  const previouslyReferencedActivityIds = new Set<string>();
  const closedActivityIds = new Map<string, number>();
  const unresolvedStallVisits = new Map<string, number[]>();
  const fortuneFacts = new Map<string, {
    reveal?: { fortuneId: string; rank: TownFortuneRank };
    interpretation?: string;
  }>();
  const activityLifecycles = new Map<string, {
    activity: z.infer<typeof TownActivityInstanceSchema>;
    eventIndex: number;
    closed: boolean;
  }>();
  value.events.forEach((townEvent, index) => {
    if (townEvent.sessionId !== value.projection.sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event session does not match projection', path: ['events', index, 'sessionId'] });
    if (townEvent.baseVersion > value.projection.version) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event base version is ahead of the projection', path: ['events', index, 'baseVersion'] });
    if (townEvent.sequence > value.projection.lastEventSequence) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event sequence is ahead of the projection', path: ['events', index, 'sequence'] });
    townEvent.participantIds.forEach((id) => { if (!residents.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event references an unknown resident', path: ['events', index, 'participantIds'] }); });
    const startedActivity = activityStartedByEvent(townEvent);
    if (startedActivity) {
      const startPath = ['events', index, ...activityStartIdPath(townEvent)];
      if (startedActivityIds.has(startedActivity.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate activity start', path: startPath });
      if (previouslyReferencedActivityIds.has(startedActivity.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity was referenced before its start event', path: startPath });
      if (closedActivityIds.has(startedActivity.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity start occurs after closure', path: startPath });
      if (!startedActivityIds.has(startedActivity.id)) {
        activityLifecycles.set(startedActivity.id, { activity: startedActivity, eventIndex: index, closed: false });
      }
      startedActivityIds.add(startedActivity.id);
    }
    if (townEvent.type === 'residents.played') {
      const lifecycle = activityLifecycles.get(townEvent.payload.activityInstanceId);
      if (closedActivityIds.has(townEvent.payload.activityInstanceId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'activityInstanceId'] });
      if (lifecycle?.closed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'activityInstanceId'] });
      const activity = lifecycle?.activity ?? activities.get(townEvent.payload.activityInstanceId);
      if (!activity) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event references an unknown activity', path: ['events', index, 'payload', 'activityInstanceId'] });
      else {
        validateExactActivityTransition(activity, townEvent, index, context);
        if (lifecycle && activity.activityId !== 'social-play') context.addIssue({ code: z.ZodIssueCode.custom, message: 'Played lifecycle requires social-play', path: ['events', index, 'payload', 'activityInstanceId'] });
        if (lifecycle) activity.version += 1;
      }
      previouslyReferencedActivityIds.add(townEvent.payload.activityInstanceId);
    }
    if (townEvent.type === 'fortune.revealed' || townEvent.type === 'fortune.interpreted') {
      const { activityInstanceId, fortuneId } = townEvent.payload;
      const lifecycle = activityLifecycles.get(activityInstanceId);
      if (closedActivityIds.has(activityInstanceId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'activityInstanceId'] });
      if (lifecycle?.closed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'activityInstanceId'] });
      const activity = lifecycle?.activity ?? activities.get(activityInstanceId);
      if (!activity) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event references an unknown activity', path: ['events', index, 'payload', 'activityInstanceId'] });
      else {
        validateExactActivityTransition(activity, townEvent, index, context);
        const state = jsonObjectValue(activity.state);
        const facts = fortuneFacts.get(activityInstanceId) ?? {};
        if (townEvent.type === 'fortune.revealed') {
          if (facts.reveal !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fortune may only be revealed once', path: ['events', index, 'payload', 'fortuneId'] });
          if (facts.interpretation !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fortune reveal cannot follow interpretation', path: ['events', index, 'payload', 'fortuneId'] });
          if (facts.reveal === undefined) facts.reveal = { fortuneId, rank: townEvent.payload.rank };
        } else {
          const knownFortuneId = facts.reveal?.fortuneId ?? (!lifecycle && typeof state.fortuneId === 'string' ? state.fortuneId : undefined);
          if (knownFortuneId === undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fortune must be revealed before interpretation', path: ['events', index, 'payload', 'fortuneId'] });
          else if (knownFortuneId !== fortuneId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Interpreted fortune must match the revealed fortune', path: ['events', index, 'payload', 'fortuneId'] });
          if (facts.interpretation !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fortune may only be interpreted once', path: ['events', index, 'payload', 'interpretation'] });
          if (facts.interpretation === undefined) facts.interpretation = townEvent.payload.interpretation;
        }
        fortuneFacts.set(activityInstanceId, facts);
        if (lifecycle) {
          if (activity.activityId !== 'fortune-draw') context.addIssue({ code: z.ZodIssueCode.custom, message: 'Fortune lifecycle has the wrong activity kind', path: ['events', index, 'payload', 'activityInstanceId'] });
          activity.version += 1;
          activity.state = townEvent.type === 'fortune.revealed'
            ? { ...state, status: 'revealed', fortuneId, rank: townEvent.payload.rank }
            : { ...state, status: 'interpreted', fortuneId, interpretation: townEvent.payload.interpretation };
        }
      }
      previouslyReferencedActivityIds.add(activityInstanceId);
    }
    if (townEvent.type === 'stall.visited') {
      const lifecycle = activityLifecycles.get(townEvent.payload.stallId);
      const wasClosed = closedActivityIds.has(townEvent.payload.stallId);
      if (wasClosed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'stallId'] });
      if (lifecycle?.closed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity transition occurs after closure', path: ['events', index, 'payload', 'stallId'] });
      const activity = lifecycle?.activity ?? activities.get(townEvent.payload.stallId);
      if (activity) {
        if (!activity.participantIds.every((id) => townEvent.participantIds.includes(id))) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stall visit must include activity participants', path: ['events', index, 'participantIds'] });
        if (townEvent.zoneId !== activity.zoneId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stall visit zone must match the activity', path: ['events', index, 'zoneId'] });
        if (lifecycle) {
          if (activity.activityId !== 'showcase-stall') context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stall lifecycle has the wrong activity kind', path: ['events', index, 'payload', 'stallId'] });
          activity.version += 1;
          activity.state = { ...jsonObjectValue(activity.state), lastVisitorResidentId: townEvent.payload.visitorResidentId };
        }
      }
      if (!activity && !wasClosed) {
        const visits = unresolvedStallVisits.get(townEvent.payload.stallId) ?? [];
        visits.push(index);
        unresolvedStallVisits.set(townEvent.payload.stallId, visits);
      }
      previouslyReferencedActivityIds.add(townEvent.payload.stallId);
    }
    if (townEvent.type === 'stall.closed') {
      const lifecycle = activityLifecycles.get(townEvent.payload.stallId);
      if (closedActivityIds.has(townEvent.payload.stallId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity is already closed', path: ['events', index, 'payload', 'stallId'] });
      if (lifecycle?.closed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity is already closed', path: ['events', index, 'payload', 'stallId'] });
      const activity = lifecycle?.activity ?? activities.get(townEvent.payload.stallId);
      if (activity) validateExactActivityTransition(activity, townEvent, index, context);
      if (lifecycle) {
        if (lifecycle.activity.activityId !== 'showcase-stall') context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stall lifecycle has the wrong activity kind', path: ['events', index, 'payload', 'stallId'] });
        lifecycle.closed = true;
      }
      if (!closedActivityIds.has(townEvent.payload.stallId)) closedActivityIds.set(townEvent.payload.stallId, index);
      previouslyReferencedActivityIds.add(townEvent.payload.stallId);
    }
    if (townEvent.type === 'build.completed') {
      const { modification } = townEvent.payload;
      const finalModification = finalModifications.get(modification.id);
      if (!finalModification) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed modification is missing from the final projection', path: ['events', index, 'payload', 'modification', 'id'] });
      else if (!modificationsEqual(modification, finalModification)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed modification does not match the final projection', path: ['events', index, 'payload', 'modification'] });
      if (completedModificationIds.has(modification.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate completed modification ID', path: ['events', index, 'payload', 'modification', 'id'] });
      completedModificationIds.add(modification.id);
      modification.occupiedCells.forEach(({ x, y }, cellIndex) => {
        const key = `${modification.plotId}:${x}:${y}`;
        if (completedOccupiedCells.has(key)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Completed modifications overlap an occupied cell', path: ['events', index, 'payload', 'modification', 'occupiedCells', cellIndex] });
      });
      modification.occupiedCells.forEach(({ x, y }) => completedOccupiedCells.add(`${modification.plotId}:${x}:${y}`));
      const lifecycle = activityLifecycles.get(modification.id);
      if (closedActivityIds.has(modification.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity is already closed', path: ['events', index, 'payload', 'modification', 'id'] });
      if (lifecycle) {
        if (lifecycle.closed) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Activity is already closed', path: ['events', index, 'payload', 'modification', 'id'] });
        validateExactActivityTransition(lifecycle.activity, townEvent, index, context);
        const state = jsonObjectValue(lifecycle.activity.state);
        if (lifecycle.activity.activityId !== `build:${modification.recipeId}`
          || state.modificationId !== modification.id
          || state.recipeId !== modification.recipeId
          || state.plotId !== modification.plotId) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: 'Build completion does not match the started lifecycle', path: ['events', index, 'payload', 'modification'] });
        }
        lifecycle.closed = true;
      }
      if (!closedActivityIds.has(modification.id)) closedActivityIds.set(modification.id, index);
      previouslyReferencedActivityIds.add(modification.id);
    }
  });
  unresolvedStallVisits.forEach((eventIndexes, activityId) => {
    if (closedActivityIds.has(activityId) || activities.has(activityId)) return;
    eventIndexes.forEach((eventIndex) => context.addIssue({ code: z.ZodIssueCode.custom, message: 'Stall visit references an unresolved activity', path: ['events', eventIndex, 'payload', 'stallId'] }));
  });
  closedActivityIds.forEach((eventIndex, activityId) => {
    if (activities.has(activityId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Closed activity remains in the final projection', path: ['events', eventIndex, 'payload'] });
  });
  fortuneFacts.forEach((facts, activityInstanceId) => {
    const activity = activities.get(activityInstanceId);
    if (!activity) return;
    const state = jsonObjectValue(activity.state);
    const finalRank = TownFortuneRankSchema.safeParse(state.rank);
    if (facts.interpretation !== undefined) {
      const expectedFortuneId = facts.reveal?.fortuneId ?? state.fortuneId;
      if (state.status !== 'interpreted'
        || state.fortuneId !== expectedFortuneId
        || state.interpretation !== facts.interpretation
        || !finalRank.success
        || (facts.reveal !== undefined && finalRank.data !== facts.reveal.rank)
        || activity.version < 3) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Final fortune interpretation state does not match emitted facts', path: ['activities', activityInstanceId] });
      }
    } else if (facts.reveal !== undefined) {
      if (state.status !== 'revealed'
        || state.fortuneId !== facts.reveal.fortuneId
        || !finalRank.success
        || finalRank.data !== facts.reveal.rank
        || activity.version < 2) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: 'Final fortune reveal state does not match emitted facts', path: ['activities', activityInstanceId] });
      }
    }
  });
  activityLifecycles.forEach(({ activity, eventIndex, closed }) => {
    const finalActivity = activities.get(activity.id);
    if (closed && finalActivity) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Closed activity remains in the final projection', path: ['events', eventIndex, 'payload'] });
    if (!closed && !finalActivity) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Started activity is missing from the final projection', path: ['events', eventIndex, 'payload'] });
    if (!closed && finalActivity && !activitiesEqual(activity, finalActivity)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Evolved started activity does not match the final projection', path: ['events', eventIndex, 'payload'] });
  });
  validateEventTransitionChain(value, context);
}

function activityStartedByEvent(
  townEvent: z.infer<typeof TownEventSchema>,
): z.infer<typeof TownActivityInstanceSchema> | undefined {
  switch (townEvent.type) {
    case 'activity.started':
      return { ...townEvent.payload.activity, participantIds: [...townEvent.payload.activity.participantIds] };
    case 'fortune.started':
      return {
        id: townEvent.payload.activityInstanceId,
        activityId: 'fortune-draw',
        zoneId: townEvent.zoneId ?? 'fortune-pavilion',
        participantIds: [...townEvent.participantIds],
        version: 1,
        state: { status: 'started' },
      };
    case 'build.started':
      return {
        id: townEvent.payload.modificationId,
        activityId: `build:${townEvent.payload.recipeId}`,
        zoneId: townEvent.zoneId ?? 'build-plots',
        participantIds: [...townEvent.participantIds],
        version: 1,
        state: {
          status: 'started',
          modificationId: townEvent.payload.modificationId,
          recipeId: townEvent.payload.recipeId,
          plotId: townEvent.payload.plotId,
        },
      };
    case 'stall.opened':
      return {
        id: townEvent.payload.stallId,
        activityId: 'showcase-stall',
        zoneId: townEvent.zoneId ?? 'market',
        participantIds: [...townEvent.participantIds],
        version: 1,
        state: { status: 'open', showcaseItemIds: [...townEvent.payload.showcaseItemIds] },
      };
    default:
      return undefined;
  }
}

function activityStartIdPath(
  townEvent: z.infer<typeof TownEventSchema>,
): string[] {
  switch (townEvent.type) {
    case 'activity.started':
      return ['payload', 'activity', 'id'];
    case 'fortune.started':
      return ['payload', 'activityInstanceId'];
    case 'build.started':
      return ['payload', 'modificationId'];
    case 'stall.opened':
      return ['payload', 'stallId'];
    default:
      return ['payload'];
  }
}

function validateExactActivityTransition(
  activity: z.infer<typeof TownActivityInstanceSchema>,
  townEvent: z.infer<typeof TownEventSchema>,
  eventIndex: number,
  context: z.RefinementCtx,
): void {
  if (!sameIdentifierSet(townEvent.participantIds, activity.participantIds)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event participants must exactly match the activity', path: ['events', eventIndex, 'participantIds'] });
  if (townEvent.zoneId !== activity.zoneId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event zone must match the activity', path: ['events', eventIndex, 'zoneId'] });
}

function jsonObjectValue(state: TownJsonValue): Record<string, TownJsonValue> {
  return state !== null && typeof state === 'object' && !Array.isArray(state) ? state : {};
}

function sameIdentifierSet(left: readonly string[], right: readonly string[]): boolean {
  const rightIds = new Set(right);
  return left.length === rightIds.size && left.every((id) => rightIds.has(id));
}

function activitiesEqual(
  left: z.infer<typeof TownActivityInstanceSchema>,
  right: z.infer<typeof TownActivityInstanceSchema>,
): boolean {
  return left.id === right.id
    && left.activityId === right.activityId
    && left.zoneId === right.zoneId
    && left.version === right.version
    && sameIdentifierSet(left.participantIds, right.participantIds)
    && jsonValuesEqual(left.state, right.state);
}

function jsonValuesEqual(left: TownJsonValue, right: TownJsonValue): boolean {
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]!));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key]!, right[key]!));
}

function modificationsEqual(
  left: z.infer<typeof TownWorldModificationSchema>,
  right: z.infer<typeof TownWorldModificationSchema>,
): boolean {
  return left.id === right.id
    && left.recipeId === right.recipeId
    && left.plotId === right.plotId
    && left.atlasFrame === right.atlasFrame
    && left.collision === right.collision
    && left.occupiedCells.length === right.occupiedCells.length
    && left.occupiedCells.every((cell, index) => {
      const other = right.occupiedCells[index];
      return other !== undefined && cell.x === other.x && cell.y === other.y;
    });
}

function validateEventTransitionChain(value: { projection: z.infer<typeof TownProjectionSchema>; events: z.infer<typeof TownEventSchema>[] }, context: z.RefinementCtx) {
  if (value.events.length === 0) return;
  for (let index = 1; index < value.events.length; index += 1) {
    const previous = value.events[index - 1]!;
    const current = value.events[index]!;
    if (current.sequence !== previous.sequence + 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event sequences must be ascending and contiguous', path: ['events', index, 'sequence'] });
    if (current.baseVersion !== previous.baseVersion + 1) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Event base versions must progress by one', path: ['events', index, 'baseVersion'] });
  }
  const last = value.events[value.events.length - 1]!;
  if (last.sequence !== value.projection.lastEventSequence) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Final event sequence must match the projection', path: ['events', value.events.length - 1, 'sequence'] });
  if (last.baseVersion + 1 !== value.projection.version) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Final event version must produce the projection version', path: ['events', value.events.length - 1, 'baseVersion'] });
}

function validateCardEventReferences(value: { events: z.infer<typeof TownEventSchema>[]; experienceCards: z.infer<typeof ExperienceCardSchema>[] }, context: z.RefinementCtx) {
  const events = new Map(value.events.map((townEvent) => [townEvent.id, townEvent]));
  value.experienceCards.forEach((card, cardIndex) => card.sourceEventIds.forEach((id, eventIndex) => {
    const townEvent = events.get(id);
    if (!townEvent) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Card references an unknown event', path: ['experienceCards', cardIndex, 'sourceEventIds', eventIndex] });
    else if (townEvent.sessionId !== card.sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Card and event sessions do not match', path: ['experienceCards', cardIndex, 'sessionId'] });
  }));
}

function validateSessionRecords(sessionId: string, records: readonly { sessionId: string }[], context: z.RefinementCtx, path: string) {
  records.forEach((record, index) => {
    if (record.sessionId !== sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Record session does not match response', path: [path, index, 'sessionId'] });
  });
}

function validateHistorySession(value: { sessionId: string; events: z.infer<typeof TownEventSchema>[]; experienceCards: z.infer<typeof ExperienceCardSchema>[] }, context: z.RefinementCtx) {
  validateSessionRecords(value.sessionId, value.events, context, 'events');
  validateSessionRecords(value.sessionId, value.experienceCards, context, 'experienceCards');
}

function validateOutingProjection(value: { outing: z.infer<typeof TownOutingSchema>; projection: TownProjectionData }, context: z.RefinementCtx) {
  if (value.outing.sessionId !== value.projection.sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Outing session does not match projection', path: ['outing', 'sessionId'] });
  if (!value.projection.residents.some(({ residentId }) => residentId === value.outing.residentId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Outing references an unknown resident', path: ['outing', 'residentId'] });
}

function validateProjectionCards(value: { projection: TownProjectionData; experienceCards: z.infer<typeof ExperienceCardSchema>[] }, context: z.RefinementCtx) {
  const residents = new Set(value.projection.residents.map(({ residentId }) => residentId));
  value.experienceCards.forEach((card, index) => {
    if (card.sessionId !== value.projection.sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Card session does not match projection', path: ['experienceCards', index, 'sessionId'] });
    card.participantIds.forEach((id, participantIndex) => { if (!residents.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Card references an unknown resident', path: ['experienceCards', index, 'participantIds', participantIndex] }); });
  });
}

type SnapshotResponseData = {
  projection: TownProjectionData;
  outings: z.infer<typeof TownOutingSchema>[];
  showcaseItems: z.infer<typeof PublicShowcaseItemSchema>[];
  experienceCards: z.infer<typeof ExperienceCardSchema>[];
};

function validateSnapshotResponse(value: SnapshotResponseData, context: z.RefinementCtx) {
  const sessionId = value.projection.sessionId;
  for (const [collection, records] of [['outings', value.outings], ['showcaseItems', value.showcaseItems], ['experienceCards', value.experienceCards]] as const) {
    records.forEach((record, index) => { if (record.sessionId !== sessionId) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Session does not match projection', path: [collection, index, 'sessionId'] }); });
  }
  const residents = new Set(value.projection.residents.map(({ residentId }) => residentId));
  value.outings.forEach((outing, index) => { if (!residents.has(outing.residentId)) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Outing references an unknown resident', path: ['outings', index, 'residentId'] }); });
  validateProjectionCards(value, context);
}
