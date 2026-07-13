import {
  IdentifierSchema,
  TownEventSchema,
  TownEventTypeSchema,
  TownZoneIdSchema,
  type TownEvent,
  type TownEventType,
  type TownZoneId,
} from '@cat-house/shared';
import { z } from 'zod';

export interface TownActivityTool {
  type: string;
}

export interface ActivityContext {
  sessionId: string;
  activityInstanceId: string;
  baseVersion: number;
  lastEventSequence: number;
  participantIds: readonly string[];
  zoneId: TownZoneId;
  now: string;
  emittedEventTypes: readonly TownEventType[];
  nextEventId(): string;
}

export interface TownActivityDefinition<
  TState,
  TTool extends TownActivityTool,
> {
  id: string;
  zoneId: TownZoneId;
  capacity: number;
  stateSchema: z.ZodType<TState>;
  toolSchema: z.ZodType<TTool>;
  createInitialState(context: ActivityContext): TState;
  transition(
    state: Readonly<TState>,
    tool: TTool,
    context: ActivityContext,
  ): TState;
  resultEvents(
    state: Readonly<TState>,
    context: ActivityContext,
  ): readonly TownEvent[];
}

export interface TownActivityMetadata {
  readonly id: string;
  readonly zoneId: TownZoneId;
  readonly capacity: number;
}

export type ActivityRegistryErrorCode =
  | 'invalid-definition'
  | 'duplicate-activity'
  | 'duplicate-zone'
  | 'unknown-activity'
  | 'invalid-context'
  | 'invalid-tool'
  | 'invalid-transition'
  | 'invalid-result-event';

export class ActivityRegistryError extends Error {
  constructor(
    public readonly code: ActivityRegistryErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ActivityRegistryError';
  }
}

type AnyDefinition = TownActivityDefinition<unknown, TownActivityTool>;

const DefinitionMetadataSchema = z
  .object({
    id: IdentifierSchema,
    zoneId: TownZoneIdSchema,
    capacity: z.number().int().min(1).max(4),
  })
  .strict();

const ContextSchema = z
  .object({
    sessionId: IdentifierSchema,
    activityInstanceId: IdentifierSchema,
    baseVersion: z.number().int().nonnegative(),
    lastEventSequence: z.number().int().nonnegative(),
    participantIds: z.array(IdentifierSchema).min(1).max(4),
    zoneId: TownZoneIdSchema,
    now: z.string().datetime({ offset: true }),
    emittedEventTypes: z
      .array(TownEventTypeSchema)
      .max(TownEventTypeSchema.options.length),
    nextEventId: z.custom<() => string>((value) => typeof value === 'function'),
  })
  .strict();

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function registryError(
  code: ActivityRegistryErrorCode,
  message: string,
  cause?: unknown,
): ActivityRegistryError {
  return new ActivityRegistryError(code, message, { cause });
}

function parseContext(
  value: unknown,
  definition: AnyDefinition,
): ActivityContext {
  let result: ReturnType<typeof ContextSchema.safeParse>;
  try {
    result = ContextSchema.safeParse(value);
  } catch (error) {
    throw registryError('invalid-context', 'Invalid activity context', error);
  }
  if (!result.success) {
    throw registryError(
      'invalid-context',
      'Invalid activity context',
      result.error,
    );
  }
  const parsed = result.data;
  if (new Set(parsed.participantIds).size !== parsed.participantIds.length) {
    throw registryError(
      'invalid-context',
      'Activity participants must be unique',
    );
  }
  if (
    new Set(parsed.emittedEventTypes).size !== parsed.emittedEventTypes.length
  ) {
    throw registryError(
      'invalid-context',
      'Emitted activity event types must be unique',
    );
  }
  if (parsed.participantIds.length > definition.capacity) {
    throw registryError('invalid-context', 'Activity capacity exceeded');
  }
  if (parsed.zoneId !== definition.zoneId) {
    throw registryError(
      'invalid-context',
      'Activity context zone does not match definition',
    );
  }
  const sourceNextEventId = parsed.nextEventId;
  const context = {
    ...parsed,
    participantIds: [...parsed.participantIds],
    emittedEventTypes: [...parsed.emittedEventTypes],
    nextEventId: Object.freeze(() => sourceNextEventId()),
  };
  return deepFreeze(context) as ActivityContext;
}

function parseState(
  definition: AnyDefinition,
  state: unknown,
): Readonly<unknown> {
  const result = definition.stateSchema.safeParse(structuredClone(state));
  if (!result.success) {
    throw registryError(
      'invalid-transition',
      'Invalid activity state',
      result.error,
    );
  }
  return deepFreeze(result.data);
}

function referencedActivityId(event: TownEvent): string | undefined {
  switch (event.type) {
    case 'activity.started':
      return event.payload.activity.id;
    case 'residents.played':
      return event.payload.activityInstanceId;
    case 'fortune.started':
      return event.payload.activityInstanceId;
    case 'fortune.revealed':
    case 'fortune.interpreted':
      return event.payload.activityInstanceId;
    case 'build.started':
      return event.payload.modificationId;
    case 'build.completed':
      return event.payload.modification.id;
    case 'stall.opened':
    case 'stall.closed':
      return event.payload.stallId;
    default:
      return undefined;
  }
}

function sameValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export class TownActivityRegistry {
  readonly #definitions = new Map<string, AnyDefinition>();
  readonly #metadata = new Map<string, TownActivityMetadata>();
  readonly #zoneOwners = new Map<TownZoneId, string>();

  register<TState, TTool extends TownActivityTool>(
    source: TownActivityDefinition<TState, TTool>,
  ): this {
    const metadataResult = DefinitionMetadataSchema.safeParse({
      id: source.id,
      zoneId: source.zoneId,
      capacity: source.capacity,
    });
    if (
      !metadataResult.success ||
      typeof source.stateSchema?.safeParse !== 'function' ||
      typeof source.toolSchema?.safeParse !== 'function' ||
      typeof source.createInitialState !== 'function' ||
      typeof source.transition !== 'function' ||
      typeof source.resultEvents !== 'function'
    ) {
      throw registryError(
        'invalid-definition',
        'Invalid activity definition',
        metadataResult.success ? undefined : metadataResult.error,
      );
    }
    const metadata = deepFreeze(metadataResult.data) as TownActivityMetadata;
    if (this.#definitions.has(metadata.id)) {
      throw registryError(
        'duplicate-activity',
        `Duplicate activity ID: ${metadata.id}`,
      );
    }
    const zoneOwner = this.#zoneOwners.get(metadata.zoneId);
    if (zoneOwner !== undefined) {
      throw registryError(
        'duplicate-zone',
        `Zone ${metadata.zoneId} is already owned by ${zoneOwner}`,
      );
    }

    const definition = Object.freeze({
      ...metadata,
      stateSchema: source.stateSchema,
      toolSchema: source.toolSchema,
      createInitialState: source.createInitialState,
      transition: source.transition,
      resultEvents: source.resultEvents,
    }) as unknown as AnyDefinition;
    this.#definitions.set(metadata.id, definition);
    this.#metadata.set(metadata.id, metadata);
    this.#zoneOwners.set(metadata.zoneId, metadata.id);
    return this;
  }

  get(id: string): TownActivityMetadata | undefined {
    return this.#metadata.get(id);
  }

  require(id: string): TownActivityMetadata {
    const metadata = this.get(id);
    if (metadata === undefined) {
      throw registryError('unknown-activity', `Unknown activity: ${id}`);
    }
    return metadata;
  }

  list(): readonly TownActivityMetadata[] {
    return Object.freeze([...this.#metadata.values()]);
  }

  createInitialState(id: string, context: ActivityContext): Readonly<unknown> {
    const definition = this.#requireDefinition(id);
    const parsedContext = parseContext(context, definition);
    try {
      return parseState(
        definition,
        definition.createInitialState(parsedContext),
      );
    } catch (error) {
      if (error instanceof ActivityRegistryError) throw error;
      throw registryError(
        'invalid-transition',
        'Activity initialization failed',
        error,
      );
    }
  }

  transition(
    id: string,
    state: unknown,
    tool: unknown,
    context: ActivityContext,
  ): Readonly<unknown> {
    const definition = this.#requireDefinition(id);
    const parsedContext = parseContext(context, definition);
    const parsedState = parseState(definition, state);
    const toolResult = definition.toolSchema.safeParse(structuredClone(tool));
    if (!toolResult.success) {
      throw registryError(
        'invalid-tool',
        'Invalid activity tool',
        toolResult.error,
      );
    }
    try {
      return parseState(
        definition,
        definition.transition(
          parsedState,
          deepFreeze(toolResult.data),
          parsedContext,
        ),
      );
    } catch (error) {
      if (error instanceof ActivityRegistryError) throw error;
      throw registryError(
        'invalid-transition',
        'Activity transition failed',
        error,
      );
    }
  }

  resultEvents(
    id: string,
    state: unknown,
    context: ActivityContext,
  ): readonly TownEvent[] {
    const definition = this.#requireDefinition(id);
    const parsedContext = parseContext(context, definition);
    const parsedState = parseState(definition, state);
    try {
      const sourceEvents = definition.resultEvents(parsedState, parsedContext);
      if (!Array.isArray(sourceEvents)) {
        throw new TypeError('Activity result events must be an array');
      }
      const events = sourceEvents.map((event) =>
        TownEventSchema.parse(structuredClone(event)),
      );
      const ids = new Set<string>();
      for (const [index, event] of events.entries()) {
        const expectedSequence = parsedContext.lastEventSequence + index + 1;
        const expectedBaseVersion = parsedContext.baseVersion + index;
        const referencedId = referencedActivityId(event);
        if (
          event.sessionId !== parsedContext.sessionId ||
          event.zoneId !== parsedContext.zoneId ||
          !sameValues(event.participantIds, parsedContext.participantIds) ||
          event.timestamp !== parsedContext.now ||
          event.sequence !== expectedSequence ||
          event.baseVersion !== expectedBaseVersion ||
          (referencedId !== undefined &&
            referencedId !== parsedContext.activityInstanceId) ||
          ids.has(event.id)
        ) {
          throw new TypeError('Result event does not match activity context');
        }
        ids.add(event.id);
      }
      return deepFreeze(events) as readonly TownEvent[];
    } catch (error) {
      if (
        error instanceof ActivityRegistryError &&
        error.code === 'invalid-result-event'
      ) {
        throw error;
      }
      throw registryError(
        'invalid-result-event',
        'Invalid activity result event',
        error,
      );
    }
  }

  #requireDefinition(id: string): AnyDefinition {
    const definition = this.#definitions.get(id);
    if (definition === undefined) {
      throw registryError('unknown-activity', `Unknown activity: ${id}`);
    }
    return definition;
  }
}
