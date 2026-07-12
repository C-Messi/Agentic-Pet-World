import {
  IdentifierSchema,
  TownEventSchema,
  TownIntentSchema,
  TownProjectionSchema,
  TownZoneIdSchema,
  type TownEvent,
  type TownIntent,
  type TownProjection,
  type TownResidentState,
  type TownZoneId,
} from '@cat-house/shared';

import type { DeepReadonly } from './pet-catalog.js';

export interface TownSimulationPorts {
  random(): number;
  now(): string;
  nextId(prefix: 'town-event' | 'activity'): string;
}

export type TownSimulationErrorCode =
  | 'invalid-intent'
  | 'invalid-config'
  | 'id-exhaustion'
  | 'id-exhausted'
  | 'invalid-generated-event';

export class TownSimulationError extends Error {
  constructor(
    readonly code: TownSimulationErrorCode,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
  ) {
    super(`Town simulation rejected: ${message}`);
    this.name = 'TownSimulationError';
  }
}

export interface TownActivityDefinition {
  readonly id: string;
  readonly zoneId: TownZoneId;
  readonly capacity: number;
  readonly enabled?: boolean;
}

export interface TownResidentSimulationContext {
  readonly cooldownIntentTypes: readonly TownIntent['type'][];
  readonly unfinishedGoalType?: TownIntent['type'];
  readonly outingDurationMs: number;
}

export interface TownSimulationOptions {
  readonly accessibleZones?: readonly TownZoneId[];
  readonly activities?: readonly TownActivityDefinition[];
  readonly recipes?: readonly string[];
  readonly buildPlots?: readonly string[];
  readonly isBuildPlotAvailable?: (
    plotId: string,
    projection: DeepReadonly<TownProjection>,
  ) => boolean;
  readonly publicShowcaseItemIds?: (
    actorId: string,
    projection: DeepReadonly<TownProjection>,
  ) => readonly string[];
  readonly contextForResident?: (
    residentId: string,
    projection: DeepReadonly<TownProjection>,
  ) => TownResidentSimulationContext;
}

const ALL_ZONES = TownZoneIdSchema.options;
const DEFAULT_ACTIVITIES: readonly TownActivityDefinition[] = [
  { id: 'fortune-draw', zoneId: 'fortune-pavilion', capacity: 2 },
  { id: 'social-play', zoneId: 'arcade-house', capacity: 4 },
  { id: 'showcase-stall', zoneId: 'market', capacity: 1 },
];
const DEFAULT_RECIPES = [
  'stone-path',
  'flower-patch',
  'street-lamp',
  'showcase-stall',
  'wish-corner',
] as const;
const INTENT_TYPES = [
  'socialize',
  'visit-zone',
  'start-activity',
  'build',
  'open-stall',
  'return-home',
] as const satisfies readonly TownIntent['type'][];
const MAX_OUTING_DURATION_MS = 604_800_000;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function parseFrozenProjection(
  projection: Readonly<TownProjection>,
): TownProjection {
  try {
    return deepFreeze(TownProjectionSchema.parse(structuredClone(projection)));
  } catch {
    return reject('invalid town projection', 'invalid-intent');
  }
}

function parseIntent(intent: Readonly<TownIntent>): TownIntent {
  try {
    return TownIntentSchema.parse(structuredClone(intent));
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    return reject(`invalid town intent${detail}`, 'invalid-intent');
  }
}

function normalizedIdentifiers(
  label: string,
  values: readonly string[],
  max: number,
): readonly string[] {
  if (!Array.isArray(values) || values.length > max) {
    return reject(
      `${label} may contain at most ${max} values`,
      'invalid-config',
    );
  }
  let parsed: string[];
  try {
    parsed = values.map((value) => IdentifierSchema.parse(value));
  } catch {
    return reject(`${label} contains an invalid identifier`, 'invalid-config');
  }
  if (new Set(parsed).size !== parsed.length) {
    return reject(`${label} contains duplicate values`, 'invalid-config');
  }
  return deepFreeze(parsed);
}

function reject(
  message: string,
  code: TownSimulationErrorCode = 'invalid-intent',
  context: Readonly<Record<string, unknown>> = {},
): never {
  throw new TownSimulationError(code, message, context);
}

function requireResident(
  projection: TownProjection,
  residentId: string,
): TownResidentState {
  const resident = projection.residents.find(
    (candidate) => candidate.residentId === residentId,
  );
  return resident ?? reject(`resident not found: ${residentId}`);
}

function requireAvailable(
  projection: TownProjection,
  residentId: string,
): TownResidentState {
  const resident = requireResident(projection, residentId);
  if (resident.availability !== 'available')
    reject(`resident is unavailable or busy: ${residentId}`);
  return resident;
}

function personalityWeight(
  projection: TownProjection,
  resident: TownResidentState,
  intent: TownIntent,
): number {
  switch (intent.type) {
    case 'socialize': {
      const relationship = projection.relationships.find(
        ({ residentIdA, residentIdB }) =>
          (residentIdA === intent.actorId &&
            residentIdB === intent.targetResidentId) ||
          (residentIdB === intent.actorId &&
            residentIdA === intent.targetResidentId),
      );
      const affinityTerm = (relationship?.affinity ?? 0) + 1;
      return 0.25 + resident.pet.personality.sociability * 4 + affinityTerm;
    }
    case 'visit-zone':
      return 0.25 + resident.pet.personality.curiosity * 3;
    case 'start-activity':
      if (intent.activityId === 'social-play')
        return 0.25 + resident.pet.personality.playfulness * 4;
      if (intent.activityId === 'fortune-draw')
        return 0.25 + resident.pet.personality.curiosity * 4;
      return 1;
    case 'build':
    case 'open-stall':
      return 0.25 + resident.pet.personality.creativity * 4;
    case 'return-home':
      return 0.5;
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function townIntentWeight(
  projection: Readonly<TownProjection>,
  intent: Readonly<TownIntent>,
): number {
  const parsedProjection = parseFrozenProjection(projection);
  const parsedIntent = parseIntent(intent);
  return personalityWeight(
    parsedProjection,
    requireResident(parsedProjection, parsedIntent.actorId),
    parsedIntent,
  );
}

export class TownSimulationService {
  readonly #ports: TownSimulationPorts;
  readonly #zones: readonly TownZoneId[];
  readonly #activities: readonly TownActivityDefinition[];
  readonly #recipes: readonly string[];
  readonly #buildPlots: readonly string[];
  readonly #isBuildPlotAvailable: (
    plotId: string,
    projection: DeepReadonly<TownProjection>,
  ) => boolean;
  readonly #publicShowcaseItemIds: (
    actorId: string,
    projection: DeepReadonly<TownProjection>,
  ) => readonly string[];
  readonly #contextForResident: (
    residentId: string,
    projection: DeepReadonly<TownProjection>,
  ) => TownResidentSimulationContext;

  constructor(ports: TownSimulationPorts, options: TownSimulationOptions = {}) {
    this.#ports = ports;
    const zones = options.accessibleZones ?? ALL_ZONES;
    if (zones.length > 7 || new Set(zones).size !== zones.length) {
      reject(
        'accessible zones must be unique and contain at most 7 values',
        'invalid-config',
      );
    }
    try {
      this.#zones = deepFreeze(
        zones.map((zone) => TownZoneIdSchema.parse(zone)),
      );
    } catch {
      reject('accessible zones contain an invalid zone', 'invalid-config');
    }
    const activities = options.activities ?? DEFAULT_ACTIVITIES;
    if (activities.length > 16)
      reject('activities may contain at most 16 values', 'invalid-config');
    const activityIds = new Set<string>();
    try {
      this.#activities = deepFreeze(
        activities.map((definition) => {
          if (
            Object.keys(definition).some(
              (key) => !['id', 'zoneId', 'capacity', 'enabled'].includes(key),
            ) ||
            (definition.enabled !== undefined &&
              typeof definition.enabled !== 'boolean')
          ) {
            reject(
              'activity definition contains invalid fields',
              'invalid-config',
            );
          }
          const id = IdentifierSchema.parse(definition.id);
          if (activityIds.has(id))
            reject('activities contain duplicate IDs', 'invalid-config');
          activityIds.add(id);
          const zoneId = TownZoneIdSchema.parse(definition.zoneId);
          if (
            !Number.isInteger(definition.capacity) ||
            definition.capacity < 1 ||
            definition.capacity > 4
          ) {
            reject(
              `invalid activity capacity: ${definition.id}`,
              'invalid-config',
            );
          }
          return {
            id,
            zoneId,
            capacity: definition.capacity,
            ...(definition.enabled === undefined
              ? {}
              : { enabled: definition.enabled }),
          };
        }),
      );
    } catch (error) {
      if (error instanceof TownSimulationError) throw error;
      reject('activities contain invalid configuration', 'invalid-config');
    }
    this.#recipes = normalizedIdentifiers(
      'recipes',
      options.recipes ?? DEFAULT_RECIPES,
      32,
    );
    this.#buildPlots = normalizedIdentifiers(
      'build plots',
      options.buildPlots ?? [],
      32,
    );
    const isBuildPlotAvailable =
      options.isBuildPlotAvailable ??
      ((plotId: string) => this.#buildPlots.includes(plotId));
    this.#isBuildPlotAvailable = (plotId, projection) => {
      let result: unknown;
      try {
        result = isBuildPlotAvailable(plotId, projection);
      } catch {
        return reject('build plot callback failed', 'invalid-config', {
          callback: 'isBuildPlotAvailable',
        });
      }
      if (typeof result !== 'boolean') {
        return reject(
          'build plot callback must return a boolean',
          'invalid-config',
          {
            callback: 'isBuildPlotAvailable',
          },
        );
      }
      return result;
    };
    this.#publicShowcaseItemIds = options.publicShowcaseItemIds ?? (() => []);
    this.#contextForResident =
      options.contextForResident ??
      (() => ({ cooldownIntentTypes: [], outingDurationMs: 0 }));
  }

  #context(
    residentId: string,
    projection: TownProjection,
  ): TownResidentSimulationContext {
    let value: TownResidentSimulationContext;
    try {
      value = this.#contextForResident(residentId, projection);
    } catch (error) {
      if (error instanceof TownSimulationError) throw error;
      throw error;
    }
    const cooldowns = value?.cooldownIntentTypes;
    if (
      value === null ||
      typeof value !== 'object' ||
      Object.keys(value).some(
        (key) =>
          ![
            'cooldownIntentTypes',
            'unfinishedGoalType',
            'outingDurationMs',
          ].includes(key),
      ) ||
      !Array.isArray(cooldowns) ||
      cooldowns.length > 6 ||
      new Set(cooldowns).size !== cooldowns.length ||
      cooldowns.some((type) => !INTENT_TYPES.includes(type))
    ) {
      return reject('invalid resident cooldown context', 'invalid-config');
    }
    if (
      value.unfinishedGoalType !== undefined &&
      !INTENT_TYPES.includes(value.unfinishedGoalType)
    ) {
      return reject('invalid unfinished goal context', 'invalid-config');
    }
    if (
      !Number.isFinite(value.outingDurationMs) ||
      value.outingDurationMs < 0 ||
      value.outingDurationMs > MAX_OUTING_DURATION_MS
    ) {
      return reject('invalid outing duration context', 'invalid-config');
    }
    return deepFreeze({
      cooldownIntentTypes: [...cooldowns],
      ...(value.unfinishedGoalType === undefined
        ? {}
        : { unfinishedGoalType: value.unfinishedGoalType }),
      outingDurationMs: value.outingDurationMs,
    });
  }

  #weight(
    projection: TownProjection,
    intent: TownIntent,
    context: TownResidentSimulationContext,
  ): number {
    const resident = requireResident(projection, intent.actorId);
    const personalityAndRelationship = personalityWeight(
      projection,
      resident,
      intent,
    );
    const goalMultiplier = context.unfinishedGoalType === intent.type ? 3 : 1;
    const outingTerm =
      intent.type === 'return-home'
        ? (context.outingDurationMs / MAX_OUTING_DURATION_MS) * 4
        : 0;
    const score = personalityAndRelationship * goalMultiplier + outingTerm;
    return Math.min(1_000, Math.max(Number.EPSILON, score));
  }

  #showcaseIds(actorId: string, projection: TownProjection): readonly string[] {
    let values: readonly string[];
    try {
      values = this.#publicShowcaseItemIds(actorId, projection);
    } catch (error) {
      if (error instanceof TownSimulationError) throw error;
      throw error;
    }
    return normalizedIdentifiers('public showcase items', values, 12);
  }

  #destinationZone(projection: TownProjection, intent: TownIntent): TownZoneId {
    switch (intent.type) {
      case 'socialize':
        return requireResident(projection, intent.actorId).zoneId;
      case 'visit-zone':
        return intent.zoneId;
      case 'start-activity': {
        const definition = this.#activities.find(
          ({ id }) => id === intent.activityId,
        );
        return (
          definition?.zoneId ??
          reject(`activity unavailable: ${intent.activityId}`)
        );
      }
      case 'build':
        return 'build-plots';
      case 'open-stall':
        return 'market';
      case 'return-home':
        return 'gate';
      default: {
        const exhaustive: never = intent;
        return exhaustive;
      }
    }
  }

  #freshActivityId(projection: TownProjection): string {
    const occupied = new Set([
      ...projection.activities.map(({ id }) => id),
      ...projection.modifications.map(({ id }) => id),
    ]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = this.#ports.nextId('activity');
      if (
        IdentifierSchema.safeParse(candidate).success &&
        !occupied.has(candidate)
      )
        return candidate;
    }
    return reject('unable to allocate a fresh activity ID', 'id-exhaustion', {
      attempts: 4,
    });
  }

  candidates(
    projection: Readonly<TownProjection>,
    residentId: string,
  ): readonly TownIntent[] {
    const parsed = parseFrozenProjection(projection);
    return this.#candidateSet(parsed, residentId).intents;
  }

  #candidateSet(
    parsed: TownProjection,
    residentId: string,
  ): {
    readonly intents: readonly TownIntent[];
    readonly context?: TownResidentSimulationContext;
  } {
    const actor = parsed.residents.find(
      (resident) => resident.residentId === residentId,
    );
    if (actor === undefined || actor.availability !== 'available')
      return { intents: [] };
    const context = this.#context(actor.residentId, parsed);

    const candidates: TownIntent[] = [];
    for (const target of parsed.residents) {
      if (
        target.residentId !== actor.residentId &&
        target.availability === 'available'
      ) {
        candidates.push({
          type: 'socialize',
          actorId: actor.residentId,
          targetResidentId: target.residentId,
        });
      }
    }
    for (const zoneId of this.#zones) {
      if (zoneId !== actor.zoneId)
        candidates.push({
          type: 'visit-zone',
          actorId: actor.residentId,
          zoneId,
        });
    }
    for (const definition of this.#activities) {
      const liveParticipants = parsed.activities
        .filter(
          ({ activityId, zoneId }) =>
            activityId === definition.id && zoneId === definition.zoneId,
        )
        .reduce((count, activity) => count + activity.participantIds.length, 0);
      if (
        definition.enabled !== false &&
        definition.id !== 'showcase-stall' &&
        liveParticipants < definition.capacity
      ) {
        candidates.push({
          type: 'start-activity',
          actorId: actor.residentId,
          activityId: definition.id,
          invitedResidentIds: [],
        });
      }
    }
    for (const recipeId of this.#recipes) {
      for (const plotId of this.#buildPlots) {
        if (this.#isBuildPlotAvailable(plotId, parsed)) {
          candidates.push({
            type: 'build',
            actorId: actor.residentId,
            recipeId,
            plotId,
          });
        }
      }
    }
    const showcaseIds = [...this.#showcaseIds(actor.residentId, parsed)].slice(
      0,
      3,
    );
    if (showcaseIds.length > 0) {
      candidates.push({
        type: 'open-stall',
        actorId: actor.residentId,
        stallId: `stall-${actor.residentId}`,
        showcaseItemIds: showcaseIds,
      });
    }
    if (actor.pet.source === 'player-pet' && actor.zoneId !== 'gate') {
      candidates.push({ type: 'return-home', actorId: actor.residentId });
    }
    return {
      intents: candidates
        .filter(
          (intent) =>
            !context.cooldownIntentTypes.includes(intent.type) &&
            this.#zones.includes(this.#destinationZone(parsed, intent)),
        )
        .map((intent) => TownIntentSchema.parse(intent)),
      context,
    };
  }

  validateIntent(
    projection: Readonly<TownProjection>,
    intent: TownIntent,
  ): TownIntent {
    const parsedProjection = parseFrozenProjection(projection);
    const parsedIntent = parseIntent(intent);
    return this.#validateIntent(parsedProjection, parsedIntent);
  }

  #validateIntent(
    parsedProjection: TownProjection,
    parsedIntent: TownIntent,
  ): TownIntent {
    const actor = requireAvailable(parsedProjection, parsedIntent.actorId);

    switch (parsedIntent.type) {
      case 'socialize':
        requireAvailable(parsedProjection, parsedIntent.targetResidentId);
        break;
      case 'visit-zone':
        if (!this.#zones.includes(parsedIntent.zoneId))
          reject(`inaccessible zone: ${parsedIntent.zoneId}`);
        break;
      case 'start-activity': {
        const definition = this.#activities.find(
          ({ id }) => id === parsedIntent.activityId,
        );
        if (definition === undefined || definition.enabled === false)
          reject(`activity unavailable: ${parsedIntent.activityId}`);
        for (const residentId of parsedIntent.invitedResidentIds)
          requireAvailable(parsedProjection, residentId);
        const liveParticipants = parsedProjection.activities
          .filter(
            ({ activityId, zoneId }) =>
              activityId === definition.id && zoneId === definition.zoneId,
          )
          .reduce(
            (count, activity) => count + activity.participantIds.length,
            0,
          );
        if (
          liveParticipants + parsedIntent.invitedResidentIds.length + 1 >
          definition.capacity
        ) {
          reject(`activity capacity exceeded: ${parsedIntent.activityId}`);
        }
        break;
      }
      case 'build':
        if (!this.#recipes.includes(parsedIntent.recipeId))
          reject(`unknown recipe: ${parsedIntent.recipeId}`);
        if (!this.#isBuildPlotAvailable(parsedIntent.plotId, parsedProjection))
          reject(`build plot unavailable: ${parsedIntent.plotId}`);
        break;
      case 'open-stall': {
        if (
          parsedProjection.activities.some(
            ({ id }) => id === parsedIntent.stallId,
          ) ||
          parsedProjection.modifications.some(
            ({ id }) => id === parsedIntent.stallId,
          )
        ) {
          reject(`activity already exists: ${parsedIntent.stallId}`);
        }
        const publicIds = new Set(
          this.#showcaseIds(actor.residentId, parsedProjection),
        );
        if (parsedIntent.showcaseItemIds.some((id) => !publicIds.has(id))) {
          reject('unknown or non-public showcase item');
        }
        break;
      }
      case 'return-home':
        if (actor.pet.source !== 'player-pet')
          reject('only the player pet can return home');
        if (actor.zoneId === 'gate') reject('player pet is already home');
        break;
      default: {
        const exhaustive: never = parsedIntent;
        return exhaustive;
      }
    }
    const destination = this.#destinationZone(parsedProjection, parsedIntent);
    if (!this.#zones.includes(destination)) {
      reject(`inaccessible destination zone: ${destination}`);
    }
    return TownIntentSchema.parse(parsedIntent);
  }

  createEvents(
    projection: Readonly<TownProjection>,
    intent: TownIntent,
  ): readonly TownEvent[] {
    const parsedProjection = parseFrozenProjection(projection);
    const parsedIntent = this.#validateIntent(
      parsedProjection,
      parseIntent(intent),
    );
    const actor = requireResident(parsedProjection, parsedIntent.actorId);
    const eventIds = new Set<string>();
    const freshEventId = (): string => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = this.#ports.nextId('town-event');
        if (
          IdentifierSchema.safeParse(candidate).success &&
          !eventIds.has(candidate)
        ) {
          eventIds.add(candidate);
          return candidate;
        }
      }
      return reject('unable to allocate a fresh event ID', 'id-exhausted', {
        attempts: 4,
      });
    };
    const create = (
      type: TownEvent['type'],
      payload: unknown,
      participantIds: string[],
      zoneId: TownZoneId,
      offset = 0,
    ): TownEvent => {
      try {
        return TownEventSchema.parse({
          id: freshEventId(),
          sessionId: parsedProjection.sessionId,
          sequence: parsedProjection.lastEventSequence + offset + 1,
          baseVersion: parsedProjection.version + offset,
          type,
          zoneId,
          participantIds,
          timestamp: this.#ports.now(),
          payload,
        });
      } catch (error) {
        if (error instanceof TownSimulationError) throw error;
        return reject(
          'generated event failed validation',
          'invalid-generated-event',
          {
            type,
            offset,
          },
        );
      }
    };

    switch (parsedIntent.type) {
      case 'socialize':
        return [
          create(
            'resident.spoke',
            {
              residentId: actor.residentId,
              text: 'Let us spend time together.',
            },
            [actor.residentId, parsedIntent.targetResidentId],
            actor.zoneId,
          ),
        ];
      case 'visit-zone':
        return [
          create(
            'resident.moved',
            { residentId: actor.residentId, position: actor.position },
            [actor.residentId],
            parsedIntent.zoneId,
          ),
        ];
      case 'start-activity': {
        const definition = this.#activities.find(
          ({ id }) => id === parsedIntent.activityId,
        )!;
        const participants = [
          actor.residentId,
          ...parsedIntent.invitedResidentIds,
        ];
        if (parsedIntent.activityId === 'fortune-draw') {
          const activityInstanceId = this.#freshActivityId(parsedProjection);
          return [
            create(
              'fortune.started',
              { activityInstanceId },
              participants,
              definition.zoneId,
            ),
          ];
        }
        const activityId = this.#freshActivityId(parsedProjection);
        const events: TownEvent[] = [];
        if (actor.zoneId !== definition.zoneId) {
          events.push(
            create(
              'resident.moved',
              { residentId: actor.residentId, position: actor.position },
              [actor.residentId],
              definition.zoneId,
            ),
          );
        }
        events.push(
          create(
            'activity.started',
            {
              activity: {
                id: activityId,
                activityId: parsedIntent.activityId,
                zoneId: definition.zoneId,
                participantIds: participants,
                version: 0,
                state: {
                  schemaVersion:
                    parsedIntent.activityId === 'social-play'
                      ? 'social-play.v1'
                      : 'generic-activity.v1',
                  phase: 'started',
                },
              },
            },
            participants,
            definition.zoneId,
            events.length,
          ),
        );
        return events;
      }
      case 'build': {
        const modificationId = this.#freshActivityId(parsedProjection);
        return [
          create(
            'build.started',
            {
              modificationId,
              recipeId: parsedIntent.recipeId,
              plotId: parsedIntent.plotId,
            },
            [actor.residentId],
            'build-plots',
          ),
        ];
      }
      case 'open-stall':
        return [
          create(
            'stall.opened',
            {
              stallId: parsedIntent.stallId,
              showcaseItemIds: parsedIntent.showcaseItemIds,
            },
            [actor.residentId],
            'market',
          ),
        ];
      case 'return-home':
        return [
          create(
            'outing.returned',
            { residentId: actor.residentId },
            [actor.residentId],
            'gate',
          ),
        ];
      default: {
        const exhaustive: never = parsedIntent;
        return exhaustive;
      }
    }
  }

  select(
    projection: Readonly<TownProjection>,
    residentId: string,
  ): TownIntent | undefined {
    const parsed = parseFrozenProjection(projection);
    const candidateSet = this.#candidateSet(parsed, residentId);
    const candidates = candidateSet.intents;
    if (candidates.length === 0) return undefined;
    const context = candidateSet.context!;
    const weights = candidates.map((intent) =>
      this.#weight(parsed, intent, context),
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const sample = this.#ports.random();
    const random = Number.isFinite(sample)
      ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
      : 0;
    let cursor = random * total;
    for (const [index, intent] of candidates.entries()) {
      cursor -= weights[index]!;
      if (cursor < 0) return TownIntentSchema.parse(intent);
    }
    return TownIntentSchema.parse(candidates[candidates.length - 1]);
  }
}
