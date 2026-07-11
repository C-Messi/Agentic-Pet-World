import type { WorldObjectId } from '@cat-house/shared';

import type { MiniGameSceneController } from './registry';

export interface MiniGameInteractionLauncher {
  hasTriggerObject(triggerObjectId: WorldObjectId): boolean;
  openByTriggerObject(
    triggerObjectId: WorldObjectId,
    controller: MiniGameSceneController,
    returnSceneKey: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export function openMiniGameInteraction(
  launcher: MiniGameInteractionLauncher,
  triggerObjectId: WorldObjectId,
  controller: MiniGameSceneController,
  returnSceneKey: string,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!launcher.hasTriggerObject(triggerObjectId)) return Promise.resolve(false);
  return launcher.openByTriggerObject(triggerObjectId, controller, returnSceneKey, signal);
}
