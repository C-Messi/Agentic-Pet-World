import type { Emotion, Interaction, WorldObjectId, WorldSnapshot } from '@cat-house/shared';

import type { WorldScene } from '../scenes/world-scene';
import { ActionExecutionError, type ActionWorldPort } from './action-runner';

export class WorldSceneActionAdapter implements ActionWorldPort {
  constructor(private readonly scene: WorldScene) {}

  hasTarget(targetId: WorldObjectId): boolean {
    return this.scene.hasActionTarget(targetId);
  }

  setAmbientSuspended(suspended: boolean): void {
    this.scene.setAgentBusy(suspended);
  }

  async moveTo(targetId: WorldObjectId, signal: AbortSignal): Promise<void> {
    try {
      await this.scene.moveToActionTarget(targetId, signal);
    } catch (error) {
      throw asActionError(error, 'MOVEMENT_FAILED');
    }
  }

  async interact(
    targetId: WorldObjectId,
    interaction: Interaction,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.scene.interactWithActionTarget(targetId, interaction, signal);
    } catch (error) {
      throw asActionError(error, 'INTERACTION_FAILED');
    }
  }

  async emote(emotion: Emotion, durationMs: number, signal: AbortSignal): Promise<void> {
    try {
      await this.scene.emoteForAction(emotion, durationMs, signal);
    } catch (error) {
      throw asActionError(error, 'EMOTE_FAILED');
    }
  }

  async wait(durationMs: number, signal: AbortSignal): Promise<void> {
    try {
      await this.scene.waitForAction(durationMs, signal);
    } catch (error) {
      throw asActionError(error, 'WAIT_FAILED');
    }
  }

  async speak(text: string, signal: AbortSignal): Promise<void> {
    try {
      await this.scene.speakForAction(text, signal);
    } catch (error) {
      throw asActionError(error, 'SPEAK_FAILED');
    }
  }

  getSnapshot(): WorldSnapshot {
    return this.scene.getSnapshot();
  }
}

function asActionError(error: unknown, code: string): Error {
  if (isAbortError(error)) return error;
  return new ActionExecutionError(
    code,
    error instanceof Error && error.message ? error.message : 'World action failed',
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
