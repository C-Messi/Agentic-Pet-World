import {
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

export interface TownSimulationPorts {
  random(): number;
  now(): string;
  nextId(prefix: 'town-event' | 'activity'): string;
}

export interface TownActivityDefinition {
  readonly id: string;
  readonly zoneId: TownZoneId;
  readonly capacity: number;
  readonly enabled?: boolean;
}

export interface TownSimulationOptions {
  readonly accessibleZones?: readonly TownZoneId[];
  readonly activities?: readonly TownActivityDefinition[];
  readonly recipes?: readonly string[];
  readonly buildPlots?: readonly string[];
  readonly isBuildPlotAvailable?: (
    plotId: string,
    projection: Readonly<TownProjection>,
  ) => boolean;
  readonly publicShowcaseItemIds?: (actorId: string) => readonly string[];
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

function reject(message: string): never {
  throw new Error(`Town intent rejected: ${message}`);
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
  resident: TownResidentState,
  intent: TownIntent,
): number {
  switch (intent.type) {
    case 'socialize':
      return 0.25 + resident.pet.personality.sociability * 4;
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
  const parsedProjection = TownProjectionSchema.parse(
    structuredClone(projection),
  );
  const parsedIntent = TownIntentSchema.parse(structuredClone(intent));
  return personalityWeight(
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
    projection: Readonly<TownProjection>,
  ) => boolean;
  readonly #publicShowcaseItemIds: (actorId: string) => readonly string[];

  constructor(ports: TownSimulationPorts, options: TownSimulationOptions = {}) {
    this.#ports = ports;
    this.#zones = [...(options.accessibleZones ?? ALL_ZONES)].map((zone) =>
      TownZoneIdSchema.parse(zone),
    );
    this.#activities = (options.activities ?? DEFAULT_ACTIVITIES).map(
      (definition) => {
        if (
          !Number.isInteger(definition.capacity) ||
          definition.capacity < 1 ||
          definition.capacity > 4
        ) {
          throw new Error(`Invalid activity capacity: ${definition.id}`);
        }
        return { ...definition };
      },
    );
    this.#recipes = [...(options.recipes ?? DEFAULT_RECIPES)];
    this.#buildPlots = [...(options.buildPlots ?? [])];
    this.#isBuildPlotAvailable =
      options.isBuildPlotAvailable ??
      ((plotId) => this.#buildPlots.includes(plotId));
    this.#publicShowcaseItemIds = options.publicShowcaseItemIds ?? (() => []);
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

  candidates(
    projection: Readonly<TownProjection>,
    residentId: string,
  ): readonly TownIntent[] {
    const parsed = TownProjectionSchema.parse(structuredClone(projection));
    const actor = parsed.residents.find(
      (resident) => resident.residentId === residentId,
    );
    if (actor === undefined || actor.availability !== 'available') return [];

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
      if (definition.enabled !== false && definition.id !== 'showcase-stall') {
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
    const showcaseIds = [
      ...this.#publicShowcaseItemIds(actor.residentId),
    ].slice(0, 3);
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
    return candidates
      .filter((intent) =>
        this.#zones.includes(this.#destinationZone(parsed, intent)),
      )
      .map((intent) => TownIntentSchema.parse(intent));
  }

  validateIntent(
    projection: Readonly<TownProjection>,
    intent: TownIntent,
  ): TownIntent {
    const parsedProjection = TownProjectionSchema.parse(
      structuredClone(projection),
    );
    const parsedIntent = TownIntentSchema.parse(structuredClone(intent));
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
        if (parsedIntent.invitedResidentIds.length + 1 > definition.capacity) {
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
        const publicIds = new Set(
          this.#publicShowcaseItemIds(actor.residentId),
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
    const parsedProjection = TownProjectionSchema.parse(
      structuredClone(projection),
    );
    const parsedIntent = this.validateIntent(parsedProjection, intent);
    const actor = requireResident(parsedProjection, parsedIntent.actorId);
    const create = (
      type: TownEvent['type'],
      payload: unknown,
      participantIds: string[],
      zoneId: TownZoneId,
    ): TownEvent =>
      TownEventSchema.parse({
        id: this.#ports.nextId('town-event'),
        sessionId: parsedProjection.sessionId,
        sequence: parsedProjection.lastEventSequence + 1,
        baseVersion: parsedProjection.version,
        type,
        zoneId,
        participantIds,
        timestamp: this.#ports.now(),
        payload,
      });

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
          return [
            create(
              'fortune.started',
              { fortuneId: this.#ports.nextId('activity') },
              participants,
              definition.zoneId,
            ),
          ];
        }
        return [
          create(
            'resident.moved',
            { residentId: actor.residentId, position: actor.position },
            [actor.residentId],
            definition.zoneId,
          ),
        ];
      }
      case 'build':
        return [
          create(
            'build.started',
            {
              modificationId: this.#ports.nextId('activity'),
              recipeId: parsedIntent.recipeId,
              plotId: parsedIntent.plotId,
            },
            [actor.residentId],
            'build-plots',
          ),
        ];
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
    const parsed = TownProjectionSchema.parse(structuredClone(projection));
    const candidates = this.candidates(parsed, residentId);
    if (candidates.length === 0) return undefined;
    const weights = candidates.map((intent) =>
      townIntentWeight(parsed, intent),
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
