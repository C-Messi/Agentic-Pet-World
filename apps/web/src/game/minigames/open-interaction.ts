import type { WorldObjectId } from '@cat-house/shared';

import type { MiniGameSceneController } from './registry';

export interface MiniGameInteractionLauncher {
  openByTriggerObject(
    triggerObjectId: WorldObjectId,
    controller: MiniGameSceneController,
    returnSceneKey: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function openMiniGameInteraction(
  launcher: MiniGameInteractionLauncher,
  triggerObjectId: WorldObjectId,
  controller: MiniGameSceneController,
  returnSceneKey: string,
  signal?: AbortSignal,
): Promise<void> {
  return launcher.openByTriggerObject(triggerObjectId, controller, returnSceneKey, signal);
}
