import {
  validateMiniGameManifest,
  type MiniGameManifest,
  type WorldObjectId,
} from '@cat-house/shared';
import type Phaser from 'phaser';

export type MiniGameSceneType = new () => Phaser.Scene;

export interface MiniGameLaunchData {
  id: string;
  title: string;
  state: unknown;
  returnSceneKey: string;
}

export interface MiniGameSceneController {
  add(key: string, scene: MiniGameSceneType, autoStart?: boolean): unknown;
  sleep(key: string): unknown;
  launch(key: string, data: MiniGameLaunchData): unknown;
}

type RegisteredManifest = MiniGameManifest<unknown, MiniGameSceneType>;

export class MiniGameRegistry {
  private readonly manifests = new Map<string, RegisteredManifest>();
  private readonly triggerIds = new Map<WorldObjectId, string>();
  private readonly sceneLoaders = new Map<string, Promise<MiniGameSceneType>>();
  private readonly addedScenes = new WeakMap<object, Set<string>>();

  constructor(fallback: RegisteredManifest, private readonly fallbackId: string) {
    this.registerManifest(fallback, false);
    if (fallback.id !== fallbackId) {
      throw new Error(`Fallback manifest ID must be ${fallbackId}`);
    }
  }

  register<TState>(manifest: MiniGameManifest<TState, MiniGameSceneType>): void {
    this.registerManifest(manifest, true);
  }

  get(id: string): RegisteredManifest | undefined {
    return this.manifests.get(id);
  }

  findByTriggerObject(triggerObjectId: WorldObjectId): RegisteredManifest | undefined {
    const id = this.triggerIds.get(triggerObjectId);
    return id ? this.manifests.get(id) : undefined;
  }

  hasTriggerObject(triggerObjectId: WorldObjectId): boolean {
    return this.triggerIds.has(triggerObjectId);
  }

  async openByTriggerObject(
    triggerObjectId: WorldObjectId,
    controller: MiniGameSceneController,
    returnSceneKey: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const manifest = this.findByTriggerObject(triggerObjectId);
    if (!manifest) return false;
    await this.open(manifest.id, controller, returnSceneKey, signal);
    return true;
  }

  async open(
    id: string,
    controller: MiniGameSceneController,
    returnSceneKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const manifest = this.manifests.get(id) ?? this.requireFallback();
    const state = parseInitialState(manifest);
    const Scene = await this.loadScene(manifest);
    throwIfAborted(signal);

    let added = this.addedScenes.get(controller);
    if (!added) {
      added = new Set();
      this.addedScenes.set(controller, added);
    }
    if (!added.has(manifest.id)) {
      controller.add(manifest.id, Scene, false);
      added.add(manifest.id);
    }
    controller.sleep(returnSceneKey);
    controller.launch(manifest.id, {
      id: manifest.id,
      title: manifest.title,
      state,
      returnSceneKey,
    });
  }

  private registerManifest<TState>(
    manifest: MiniGameManifest<TState, MiniGameSceneType>,
    indexTrigger: boolean,
  ): void {
    validateMiniGameManifest(manifest);
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Duplicate mini-game ID: ${manifest.id}`);
    }
    this.manifests.set(manifest.id, manifest as RegisteredManifest);
    if (indexTrigger) this.triggerIds.set(manifest.triggerObjectId, manifest.id);
  }

  private loadScene(manifest: RegisteredManifest): Promise<MiniGameSceneType> {
    let pending = this.sceneLoaders.get(manifest.id);
    if (!pending) {
      pending = manifest.loadScene().then((Scene) => {
        if (typeof Scene !== 'function') {
          throw new Error(`Mini-game ${manifest.id} scene loader did not return a scene class`);
        }
        return Scene;
      });
      this.sceneLoaders.set(manifest.id, pending);
    }
    return pending;
  }

  private requireFallback(): RegisteredManifest {
    const fallback = this.manifests.get(this.fallbackId);
    if (!fallback) throw new Error(`Missing mini-game fallback: ${this.fallbackId}`);
    return fallback;
  }
}

function parseInitialState(manifest: RegisteredManifest): unknown {
  try {
    return manifest.stateSchema.parse(manifest.createInitialState());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid mini-game initial state for ${manifest.id}: ${message}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Mini-game open cancelled', 'AbortError');
}
