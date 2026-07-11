import { z } from 'zod';

import type { MiniGameManifest } from '@cat-house/shared';

import { MiniGameRegistry, type MiniGameSceneType } from './registry';

const emptyStateSchema = z.object({}).strict();

const fallbackManifest: MiniGameManifest<Record<string, never>, MiniGameSceneType> = {
  id: 'minigame-unavailable',
  title: 'Game Unavailable',
  triggerObjectId: 'arcade',
  stateSchemaId: 'empty-state-v1',
  stateSchema: emptyStateSchema,
  createInitialState: () => ({}),
  loadScene: async () => (await import('./coming-soon-scene')).ComingSoonScene,
};

export const arcadeComingSoonManifest: MiniGameManifest<
  Record<string, never>,
  MiniGameSceneType
> = {
  id: 'arcade-coming-soon',
  title: 'Arcade',
  triggerObjectId: 'arcade',
  stateSchemaId: 'empty-state-v1',
  stateSchema: emptyStateSchema,
  createInitialState: () => ({}),
  loadScene: async () => (await import('./coming-soon-scene')).ComingSoonScene,
};

export const miniGameRegistry = new MiniGameRegistry(
  fallbackManifest,
  fallbackManifest.id,
);
miniGameRegistry.register(arcadeComingSoonManifest);
