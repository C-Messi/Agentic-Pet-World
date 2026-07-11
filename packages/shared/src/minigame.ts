import { z } from 'zod';

import { IdentifierSchema, WorldObjectIdSchema, type WorldObjectId } from './protocol.js';

const MAX_AGENT_TOOLS = 8;

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

export interface MiniGameValidator<T> {
  parse(input: unknown): T;
}

export interface MiniGameAgentTool<TState, TInput = never> extends MiniGameAgentToolMetadata {
  inputSchema: MiniGameValidator<TInput>;
  execute(input: TInput, state: Readonly<TState>): TState | Promise<TState>;
}

export interface MiniGameManifest<TState = unknown, TScene = unknown> {
  id: string;
  title: string;
  triggerObjectId: WorldObjectId;
  stateSchemaId: string;
  stateSchema: MiniGameValidator<TState>;
  createInitialState(): TState;
  loadScene(): Promise<TScene>;
  agentTools?: readonly MiniGameAgentTool<TState>[];
}

export function getMiniGameManifestMetadata<TState, TScene>(
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

export function validateMiniGameManifest<TState, TScene>(
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
    manifest.stateSchema.parse(manifest.createInitialState());
  } catch (error) {
    throw new Error(`Invalid mini-game initial state: ${errorMessage(error)}`);
  }
  return manifest;
}

export async function executeMiniGameAgentTool<TState, TScene>(
  manifest: MiniGameManifest<TState, TScene>,
  toolId: string,
  input: unknown,
  state: unknown,
): Promise<TState> {
  validateMiniGameManifest(manifest);
  const tool = manifest.agentTools?.find(({ id }) => id === toolId);
  if (!tool) throw new Error(`Unknown mini-game agent tool: ${toolId}`);
  const currentState = manifest.stateSchema.parse(state);
  const parsedInput = tool.inputSchema.parse(input);
  const nextState = await tool.execute(parsedInput, currentState);
  return manifest.stateSchema.parse(nextState);
}

function requireFunction(value: unknown, name: string): asserts value is (...args: never[]) => unknown {
  if (typeof value !== 'function') throw new Error(`Mini-game ${name} must be a function`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
