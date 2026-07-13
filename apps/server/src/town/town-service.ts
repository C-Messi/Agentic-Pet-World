import {
  ExperienceCardsResponseSchema,
  ExperienceCardSchema,
  OfflineRecoveryRequestSchema,
  OfflineRecoveryResponseSchema,
  ShowcaseDeleteResponseSchema,
  ShowcaseListResponseSchema,
  ShowcaseUpsertRequestSchema,
  ShowcaseUpsertResponseSchema,
  TownAdvanceRequestSchema,
  TownAdvanceResponseSchema,
  TownEventResultsRequestSchema,
  TownEventResultsResponseSchema,
  TownHistoryResponseSchema,
  TownProjectionSchema,
  TownRecallRequestSchema,
  TownRecallResponseSchema,
  TownRelationshipsResponseSchema,
  TownReleaseRequestSchema,
  TownReleaseResponseSchema,
  TownSnapshotResponseSchema,
  type OfflineRecoveryRequest,
  type OfflineRecoveryResponse,
  type ShowcaseDeleteResponse,
  type ShowcaseListResponse,
  type ShowcaseUpsertRequest,
  type ShowcaseUpsertResponse,
  type TownAdvanceRequest,
  type TownAdvanceResponse,
  type TownEventResultsRequest,
  type TownEventResultsResponse,
  type TownHistoryResponse,
  type TownProjection,
  type TownRecallRequest,
  type TownRecallResponse,
  type TownRelationshipsResponse,
  type TownReleaseRequest,
  type TownReleaseResponse,
  type TownSnapshotResponse,
  type ExperienceCardsResponse,
} from '@cat-house/shared';

import type { StorageDatabase } from '../storage/database.js';
import {
  TownEventRepository,
  TownProjectionRepository,
} from '../storage/repositories/index.js';
import { reduceTownEvent } from './event-reducer.js';
import {
  fallbackReturnHomeRecap,
  deterministicEventSelection,
} from './narrator.js';
import {
  OfflineRecoveryService,
  type OfflineRecoveryResult,
  type OfflineRecoveryStore,
} from './offline-recovery.js';
import { createDefaultPetCatalog } from './pet-catalog.js';
import { createAuthoredPetDefinitions } from './residents.js';
import {
  TownSimulationService,
  type TownSimulationPorts,
} from './simulation-service.js';

export class TownServiceError extends Error {
  constructor(
    readonly kind: 'conflict' | 'not-found' | 'invalid',
    message: string,
  ) {
    super(message);
    this.name = 'TownServiceError';
  }
}

export interface TownServicePort {
  snapshot(sessionId: string): TownSnapshotResponse;
  release(request: TownReleaseRequest): TownReleaseResponse;
  recall(request: TownRecallRequest): TownRecallResponse;
  advance(request: TownAdvanceRequest): TownAdvanceResponse;
  eventResults(request: TownEventResultsRequest): TownEventResultsResponse;
  recover(request: OfflineRecoveryRequest): OfflineRecoveryResponse;
  history(sessionId: string): TownHistoryResponse;
  relationships(sessionId: string): TownRelationshipsResponse;
  experienceCards(sessionId: string): ExperienceCardsResponse;
  showcase(sessionId: string): ShowcaseListResponse;
  upsertShowcase(
    sessionId: string,
    itemId: string,
    request: ShowcaseUpsertRequest,
  ): ShowcaseUpsertResponse;
  deleteShowcase(sessionId: string, itemId: string): ShowcaseDeleteResponse;
}

export class TownService implements TownServicePort {
  readonly #projections: TownProjectionRepository;
  readonly #events: TownEventRepository;
  readonly #simulation: TownSimulationService;

  constructor(
    private readonly database: StorageDatabase,
    private readonly ports: TownSimulationPorts,
  ) {
    this.#projections = new TownProjectionRepository(database);
    this.#events = new TownEventRepository(database);
    this.#simulation = new TownSimulationService(ports, {
      buildPlots: ['plot-1', 'plot-2', 'plot-3', 'plot-4', 'plot-5', 'plot-6'],
      publicShowcaseItemIds: (_actorId, projection) =>
        this.#projections
          .listPublicShowcaseItems(projection.sessionId)
          .map(({ id }) => id),
    });
  }

  snapshot(sessionId: string): TownSnapshotResponse {
    const projection = this.#loadOrCreate(sessionId);
    const outing = this.#projections.loadOuting(sessionId);
    return TownSnapshotResponseSchema.parse({
      projection,
      outings: outing === undefined ? [] : [outing],
      showcaseItems: this.#projections.listPublicShowcaseItems(sessionId),
      experienceCards: this.#projections.listCards(sessionId),
    });
  }

  release(source: TownReleaseRequest): TownReleaseResponse {
    const request = TownReleaseRequestSchema.parse(source);
    const projection = this.#loadOrCreate(request.sessionId);
    this.#requireResident(projection, request.residentId);
    const existing = this.#projections.loadOuting(request.sessionId);
    if (existing?.status === 'town')
      return TownReleaseResponseSchema.parse({ outing: existing, projection });
    const now = this.ports.now();
    const outing = {
      sessionId: request.sessionId,
      residentId: request.residentId,
      status: 'town' as const,
      startedAt: now,
      lastConfirmedAt: now,
    };
    this.#projections.saveOuting(outing);
    return TownReleaseResponseSchema.parse({ outing, projection });
  }

  recall(source: TownRecallRequest): TownRecallResponse {
    const request = TownRecallRequestSchema.parse(source);
    const projection = this.#loadOrCreate(request.sessionId);
    const resident = this.#requireResident(projection, request.residentId);
    if (resident.availability === 'busy')
      throw new TownServiceError(
        'conflict',
        'Pet is in a non-interruptible activity',
      );
    const existing = this.#projections.loadOuting(request.sessionId);
    const now = this.ports.now();
    const outing = {
      sessionId: request.sessionId,
      residentId: request.residentId,
      status: 'home' as const,
      returnedAt: existing?.returnedAt ?? now,
    };
    this.#projections.saveOuting(outing);
    return TownRecallResponseSchema.parse({ outing, projection });
  }

  advance(source: TownAdvanceRequest): TownAdvanceResponse {
    const request = TownAdvanceRequestSchema.parse(source);
    return this.database
      .transaction(() => {
        let projection = this.#loadOrCreate(request.sessionId);
        if (projection.version !== request.baseVersion)
          throw new TownServiceError(
            'conflict',
            'Stale town projection version',
          );
        const events = [];
        for (const intent of request.intents) {
          for (const event of this.#simulation.createEvents(
            projection,
            intent,
          )) {
            if (events.length >= 24) break;
            this.#events.append(event);
            projection = reduceTownEvent(projection, event);
            events.push(event);
          }
          if (events.length >= 24) break;
        }
        if (
          events.length > 0 &&
          !this.#projections.save(
            request.sessionId,
            request.baseVersion,
            projection,
          )
        ) {
          throw new TownServiceError(
            'conflict',
            'Town projection changed concurrently',
          );
        }
        return TownAdvanceResponseSchema.parse({ projection, events });
      })
      .immediate();
  }

  eventResults(source: TownEventResultsRequest): TownEventResultsResponse {
    const request = TownEventResultsRequestSchema.parse(source);
    const projection = this.#loadOrCreate(request.sessionId);
    if (projection.version !== request.baseVersion)
      throw new TownServiceError('conflict', 'Stale town projection version');
    const found = new Set(
      this.#events
        .listByIds(
          request.sessionId,
          request.results.map(({ eventId }) => eventId),
        )
        .map(({ id }) => id),
    );
    if (request.results.some(({ eventId }) => !found.has(eventId)))
      throw new TownServiceError('invalid', 'Unknown town event result');
    return TownEventResultsResponseSchema.parse({
      projection,
      acceptedEventIds: request.results.map(({ eventId }) => eventId),
    });
  }

  recover(source: OfflineRecoveryRequest): OfflineRecoveryResponse {
    const request = OfflineRecoveryRequestSchema.parse(source);
    return this.database
      .transaction(() => {
        const projection = this.#loadOrCreate(request.sessionId);
        const outing = this.#projections.loadOuting(request.sessionId);
        if (
          outing === undefined ||
          outing.residentId !== request.residentId ||
          outing.status !== 'town'
        )
          throw new TownServiceError(
            'invalid',
            'No active outing for resident',
          );
        if (outing.lastConfirmedAt !== request.lastConfirmedAt)
          throw new TownServiceError(
            'conflict',
            'Recovery basis does not match the active outing',
          );
        const cached = this.#projections.loadRecoveryResult(
          request.sessionId,
          request.recoveryWindowId,
        );
        if (cached !== undefined) return cached;

        const store: OfflineRecoveryStore = {
          claimRecoveryWindow: (_sessionId, recoveryWindowId) =>
            this.#projections.claimRecoveryWindow(outing, recoveryWindowId),
          loadRecoveryResult: (sessionId, recoveryWindowId) => {
            const saved = this.#projections.loadRecoveryResult(
              sessionId,
              recoveryWindowId,
            );
            return saved === undefined
              ? undefined
              : {
                  startVersion: projection.version,
                  events: saved.events,
                  finalProjection: saved.projection,
                };
          },
          saveRecoveryResult: () => undefined,
        };
        const recovered = new OfflineRecoveryService(
          this.#simulation,
          store,
        ).recover({
          sessionId: request.sessionId,
          recoveryWindowId: request.recoveryWindowId,
          lastConfirmedAt: request.lastConfirmedAt,
          resumedAt: this.ports.now(),
          projection,
        });
        let persisted = projection;
        for (const event of recovered.events) {
          this.#events.append(event);
          const next = reduceTownEvent(persisted, event);
          if (
            !this.#projections.save(request.sessionId, persisted.version, next)
          )
            throw new TownServiceError(
              'conflict',
              'Town projection changed during recovery',
            );
          persisted = next;
        }
        const cards = this.#createRecoveryCards(
          request.sessionId,
          request.residentId,
          recovered.events,
        );
        for (const card of cards) this.#projections.saveCard(card);
        const result = OfflineRecoveryResponseSchema.parse({
          outing,
          projection: persisted,
          events: recovered.events,
          experienceCards: cards,
        });
        this.#projections.saveRecoveryResult(
          request.sessionId,
          request.recoveryWindowId,
          result,
        );
        return result;
      })
      .immediate();
  }

  history(sessionId: string): TownHistoryResponse {
    this.#loadOrCreate(sessionId);
    return TownHistoryResponseSchema.parse({
      sessionId,
      events: this.#events.listAfter(sessionId, 0, 24),
      experienceCards: this.#projections.listCards(sessionId),
    });
  }
  relationships(sessionId: string): TownRelationshipsResponse {
    const projection = this.#loadOrCreate(sessionId);
    return TownRelationshipsResponseSchema.parse({
      sessionId,
      relationships: projection.relationships,
    });
  }
  experienceCards(sessionId: string): ExperienceCardsResponse {
    this.#loadOrCreate(sessionId);
    return ExperienceCardsResponseSchema.parse({
      sessionId,
      experienceCards: this.#projections.listCards(sessionId),
    });
  }
  showcase(sessionId: string): ShowcaseListResponse {
    this.#loadOrCreate(sessionId);
    return ShowcaseListResponseSchema.parse({
      sessionId,
      items: this.#projections.listPublicShowcaseItems(sessionId),
    });
  }
  upsertShowcase(
    sessionId: string,
    itemId: string,
    source: ShowcaseUpsertRequest,
  ): ShowcaseUpsertResponse {
    this.#loadOrCreate(sessionId);
    const request = ShowcaseUpsertRequestSchema.parse(source);
    if (request.item.sessionId !== sessionId || request.item.id !== itemId)
      throw new TownServiceError(
        'invalid',
        'Showcase item path does not match payload',
      );
    this.#projections.savePublicShowcaseItem(request.item);
    return ShowcaseUpsertResponseSchema.parse(request);
  }
  deleteShowcase(sessionId: string, itemId: string): ShowcaseDeleteResponse {
    this.#loadOrCreate(sessionId);
    if (!this.#projections.deletePublicShowcaseItem(sessionId, itemId))
      throw new TownServiceError('not-found', 'Showcase item not found');
    return ShowcaseDeleteResponseSchema.parse({ deletedItemId: itemId });
  }

  #loadOrCreate(sessionId: string): TownProjection {
    const stored = this.#projections.load(sessionId);
    if (stored !== undefined) return stored;
    const residents = createDefaultPetCatalog()
      .list()
      .map((pet, index) => ({
        residentId: pet.id,
        pet: structuredClone(pet),
        position: { x: 2 + index * 2, y: 4 },
        zoneId: 'gate' as const,
        availability: 'available' as const,
      }));
    const projection = TownProjectionSchema.parse({
      sessionId,
      version: 0,
      lastEventSequence: 0,
      residents,
      relationships: [],
      modifications: [],
      activities: [],
    });
    if (!this.#projections.save(sessionId, -1, projection))
      return this.#projections.load(sessionId)!;
    return projection;
  }
  #requireResident(projection: TownProjection, id: string) {
    const resident = projection.residents.find(
      ({ residentId }) => residentId === id,
    );
    if (resident === undefined)
      throw new TownServiceError('invalid', 'Town resident not found');
    return resident;
  }

  #createRecoveryCards(
    sessionId: string,
    playerResidentId: string,
    events: OfflineRecoveryResult['events'],
  ) {
    const selected = deterministicEventSelection(events);
    if (selected.length === 0) return [];
    const context = {
      sessionId,
      playerResidentId,
      events,
      pets: createAuthoredPetDefinitions(),
      publicShowcaseItems: this.#projections.listPublicShowcaseItems(sessionId),
    };
    const participants = [
      ...new Set(selected.flatMap(({ participantIds }) => participantIds)),
    ].slice(0, 4);
    const card = ExperienceCardSchema.parse({
      id: `card-${selected[0]!.id}`,
      sessionId,
      title: selected.length === 1 ? 'A town memory' : 'Town memories',
      body: fallbackReturnHomeRecap(context),
      location:
        selected.find(({ zoneId }) => zoneId !== undefined)?.zoneId ?? 'plaza',
      participantIds: participants,
      sourceEventIds: selected.map(({ id }) => id),
      timestamp: this.ports.now(),
    });
    return [card];
  }
}
