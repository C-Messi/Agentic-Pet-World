import {
  createMiniGameInitialState,
  validateMiniGameManifest,
  type MiniGameJsonValue,
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

type RegisteredManifest = MiniGameManifest<MiniGameJsonValue, MiniGameSceneType>;

export class MiniGameRegistry {
  private readonly manifests = new Map<string, RegisteredManifest>();
  private readonly triggerIds = new Map<WorldObjectId, string>();
  private readonly loadedScenes = new Map<string, MiniGameSceneType>();
  private readonly pendingSceneLoads = new Map<string, Promise<MiniGameSceneType>>();
  private readonly addedScenes = new WeakMap<object, Set<string>>();

  constructor(fallback: RegisteredManifest, private readonly fallbackId: string) {
    this.registerManifest(fallback, false);
    if (fallback.id !== fallbackId) {
      throw new Error(`Fallback manifest ID must be ${fallbackId}`);
    }
  }

  register<TState extends MiniGameJsonValue>(
    manifest: MiniGameManifest<TState, MiniGameSceneType>,
  ): void {
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
    const requestedManifest = this.manifests.get(id) ?? this.requireFallback();
    let manifest = requestedManifest;
    let Scene: MiniGameSceneType;
    try {
      Scene = await this.loadScene(requestedManifest);
    } catch (error) {
      if (requestedManifest.id === this.fallbackId) throw error;
      manifest = this.requireFallback();
      Scene = await this.loadScene(manifest);
    }
    throwIfAborted(signal);
    const state = createMiniGameInitialState(manifest);

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

  private registerManifest<TState extends MiniGameJsonValue>(
    manifest: MiniGameManifest<TState, MiniGameSceneType>,
    indexTrigger: boolean,
  ): void {
    validateMiniGameManifest(manifest);
    if (this.manifests.has(manifest.id)) {
      throw new Error(`Duplicate mini-game ID: ${manifest.id}`);
    }
    const existingTriggerOwner = indexTrigger
      ? this.triggerIds.get(manifest.triggerObjectId)
      : undefined;
    if (existingTriggerOwner) {
      throw new Error(
        `Duplicate mini-game trigger object ${manifest.triggerObjectId}: owned by ${existingTriggerOwner}`,
      );
    }
    this.manifests.set(manifest.id, manifest as RegisteredManifest);
    if (indexTrigger) this.triggerIds.set(manifest.triggerObjectId, manifest.id);
  }

  private loadScene(manifest: RegisteredManifest): Promise<MiniGameSceneType> {
    const loaded = this.loadedScenes.get(manifest.id);
    if (loaded) return Promise.resolve(loaded);
    let pending = this.pendingSceneLoads.get(manifest.id);
    if (!pending) {
      pending = manifest.loadScene().then((Scene) => {
        if (typeof Scene !== 'function') {
          throw new Error(`Mini-game ${manifest.id} scene loader did not return a scene class`);
        }
        this.loadedScenes.set(manifest.id, Scene);
        this.pendingSceneLoads.delete(manifest.id);
        return Scene;
      }).catch((error: unknown) => {
        this.pendingSceneLoads.delete(manifest.id);
        throw error;
      });
      this.pendingSceneLoads.set(manifest.id, pending);
    }
    return pending;
  }

  private requireFallback(): RegisteredManifest {
    const fallback = this.manifests.get(this.fallbackId);
    if (!fallback) throw new Error(`Missing mini-game fallback: ${this.fallbackId}`);
    return fallback;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Mini-game open cancelled', 'AbortError');
}
