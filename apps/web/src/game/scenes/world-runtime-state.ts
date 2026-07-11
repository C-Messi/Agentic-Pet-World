import type { Emotion, WorldObjectId } from '@cat-house/shared';

import type { AmbientBehaviorSystem } from '../behavior/ambient-behavior';
import type { NavigationSystem } from '../navigation/navigation-system';
import type { GridPoint } from '../world/object-registry';

export class WorldRuntimeState {
  path: GridPoint[] = [];
  movementOwner: string | null = null;
  pendingEmotion: Emotion = 'idle';
  currentEmotion: Emotion = 'idle';
  currentTargetId: WorldObjectId | undefined;
  agentBusy = false;
  ambientSettledUntil = 0;

  reset(navigation: NavigationSystem, ambient: AmbientBehaviorSystem): void {
    navigation.clearReservations();
    ambient.resetCooldown();
    this.path = [];
    this.movementOwner = null;
    this.pendingEmotion = 'idle';
    this.currentEmotion = 'idle';
    this.currentTargetId = undefined;
    this.agentBusy = false;
    this.ambientSettledUntil = 0;
  }
}
