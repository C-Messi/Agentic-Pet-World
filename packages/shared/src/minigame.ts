import { z } from 'zod';

import { IdentifierSchema, WorldObjectIdSchema, type WorldObjectId } from './protocol.js';

const MAX_AGENT_TOOLS = 8;

export type MiniGameJsonValue =
  | null
  | boolean
  | number
  | string
  | MiniGameJsonValue[]
  | { [key: string]: MiniGameJsonValue };

export const MiniGameAgentToolMetadataSchema = z
  .object({
    id: IdentifierSchema.max(64),
    description: z.string().trim().min(1).max(240),
    inputSchemaId: IdentifierSchema,
  })
  .strict();
export type MiniGameAgentToolMetadata = z.infer<typeof MiniGameAgentToolMetadataSchema>;

export const MiniGameManifestMetadataSchema = z
  .object({
    id: IdentifierSchema.max(64),
    title: z.string().trim().min(1).max(80),
    triggerObjectId: WorldObjectIdSchema,
    stateSchemaId: IdentifierSchema,
    agentTools: z.array(MiniGameAgentToolMetadataSchema).max(MAX_AGENT_TOOLS).optional(),
  })
  .strict();
export type MiniGameManifestMetadata = z.infer<typeof MiniGameManifestMetadataSchema>;

export interface MiniGameValidator<T extends MiniGameJsonValue> {
  parse(input: unknown): T;
}

export interface MiniGameAgentTool<
  TState extends MiniGameJsonValue,
  TInput extends MiniGameJsonValue = MiniGameJsonValue,
> extends MiniGameAgentToolMetadata {
  inputSchema: MiniGameValidator<TInput>;
  execute(input: TInput, state: Readonly<TState>): TState | Promise<TState>;
}

export interface MiniGameManifest<
  TState extends MiniGameJsonValue = MiniGameJsonValue,
  TScene = unknown,
> {
  id: string;
  title: string;
  triggerObjectId: WorldObjectId;
  stateSchemaId: string;
  stateSchema: MiniGameValidator<TState>;
  createInitialState(): TState;
  loadScene(): Promise<TScene>;
  agentTools?: readonly MiniGameAgentTool<TState>[];
}

export function getMiniGameManifestMetadata<TState extends MiniGameJsonValue, TScene>(
  manifest: MiniGameManifest<TState, TScene>,
): MiniGameManifestMetadata {
  const metadata: MiniGameManifestMetadata = {
    id: manifest.id,
    title: manifest.title,
    triggerObjectId: manifest.triggerObjectId,
    stateSchemaId: manifest.stateSchemaId,
  };
  if (manifest.agentTools) {
    metadata.agentTools = manifest.agentTools.map(({ id, description, inputSchemaId }) => ({
      id,
      description,
      inputSchemaId,
    }));
  }
  return MiniGameManifestMetadataSchema.parse(metadata);
}

export function validateMiniGameManifest<TState extends MiniGameJsonValue, TScene>(
  manifest: MiniGameManifest<TState, TScene>,
): MiniGameManifest<TState, TScene> {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Mini-game manifest must be an object');
  }
  getMiniGameManifestMetadata(manifest);
  requireFunction(manifest.stateSchema?.parse, 'stateSchema.parse');
  requireFunction(manifest.createInitialState, 'createInitialState');
  requireFunction(manifest.loadScene, 'loadScene');

  const tools = manifest.agentTools ?? [];
  if (tools.length > MAX_AGENT_TOOLS) {
    throw new Error(`Mini-game agent tools cannot exceed ${MAX_AGENT_TOOLS}`);
  }
  const toolIds = new Set<string>();
  for (const tool of tools) {
    MiniGameAgentToolMetadataSchema.parse({
      id: tool.id,
      description: tool.description,
      inputSchemaId: tool.inputSchemaId,
    });
    requireFunction(tool.inputSchema?.parse, `agentTools.${tool.id}.inputSchema.parse`);
    requireFunction(tool.execute, `agentTools.${tool.id}.execute`);
    if (toolIds.has(tool.id)) throw new Error(`Duplicate mini-game agent tool ID: ${tool.id}`);
    toolIds.add(tool.id);
  }

  try {
    createMiniGameInitialState(manifest);
  } catch (error) {
    throw new Error(`Invalid mini-game initial state: ${errorMessage(error)}`);
  }
  return manifest;
}

export function createMiniGameInitialState<TState extends MiniGameJsonValue, TScene>(
  manifest: MiniGameManifest<TState, TScene>,
): TState {
  return cloneMiniGameJsonValue<TState>(
    manifest.stateSchema.parse(manifest.createInitialState()),
    'Mini-game initial state',
  );
}

export async function executeMiniGameAgentTool<TState extends MiniGameJsonValue, TScene>(
  manifest: MiniGameManifest<TState, TScene>,
  toolId: string,
  input: unknown,
  state: unknown,
): Promise<TState> {
  validateMiniGameManifest(manifest);
  const tool = manifest.agentTools?.find(({ id }) => id === toolId);
  if (!tool) throw new Error(`Unknown mini-game agent tool: ${toolId}`);
  const currentState = cloneAndFreezeMiniGameJsonValue<TState>(
    manifest.stateSchema.parse(state),
    'Mini-game state',
  );
  const parsedInput = cloneAndFreezeMiniGameJsonValue(
    tool.inputSchema.parse(input),
    'Mini-game agent tool input',
  );
  const nextState = await tool.execute(parsedInput, currentState);
  return cloneMiniGameJsonValue<TState>(
    manifest.stateSchema.parse(nextState),
    'Mini-game agent tool output state',
  );
}

export function cloneMiniGameJsonValue<T extends MiniGameJsonValue>(
  value: unknown,
  label = 'Mini-game value',
): T {
  return cloneJsonValue(value, label, new WeakSet()) as T;
}

function cloneAndFreezeMiniGameJsonValue<T extends MiniGameJsonValue>(
  value: unknown,
  label: string,
): T {
  return deepFreeze(cloneMiniGameJsonValue<T>(value, label));
}

function cloneJsonValue(
  value: unknown,
  label: string,
  activeObjects: WeakSet<object>,
): MiniGameJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new Error(`${label} must contain only finite numbers`);
  }
  if (typeof value !== 'object') {
    throw new Error(`${label} must be JSON-compatible data`);
  }
  if (activeObjects.has(value)) throw new Error(`${label} must not contain cycles`);
  activeObjects.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => cloneJsonValue(item, label, activeObjects));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON-compatible objects`);
    }
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      throw new Error(`${label} must not contain symbol keys`);
    }
    const output = Object.create(null) as { [key: string]: MiniGameJsonValue };
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(output, key, {
        value: cloneJsonValue(item, label, activeObjects),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return output;
  } finally {
    activeObjects.delete(value);
  }
}

function deepFreeze<T extends MiniGameJsonValue>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value)) {
      deepFreeze(Reflect.get(value, key) as MiniGameJsonValue);
    }
    Object.freeze(value);
  }
  return value;
}

function requireFunction(value: unknown, name: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== 'function') throw new Error(`Mini-game ${name} must be a function`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
