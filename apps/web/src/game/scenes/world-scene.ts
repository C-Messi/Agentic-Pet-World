import type { Emotion, Interaction, WorldObjectId, WorldSnapshot } from '@cat-house/shared';
import Phaser from 'phaser';

import { AmbientBehaviorSystem, type AmbientAction } from '../behavior/ambient-behavior';
import { evaluateAmbientBehavior } from '../behavior/ambient-evaluation';
import { gameEvents } from '../events';
import { NavigationSystem } from '../navigation/navigation-system';
import { bottomDepthFromCenter, bottomDepthFromTopLeft } from '../render/render-depth';
import {
  ROOM_GRID,
  ROOM_OBJECTS,
  CAT_SPAWN_TILE,
  createRoomBlockedTiles,
  getWorldObject,
  type GridPoint,
} from '../world/object-registry';
import { WorldRuntimeState } from './world-runtime-state';

const DISPLAY_SCALE = 2;
const DISPLAY_TILE_SIZE = ROOM_GRID.tileSize * DISPLAY_SCALE;
const WANDER_TILES: readonly GridPoint[] = [
  { x: 8, y: 8 },
  { x: 12, y: 9 },
  { x: 15, y: 12 },
  { x: 9, y: 13 },
];

const animationStates: readonly Emotion[] = [
  'idle',
  'walk',
  'sit',
  'sleep',
  'happy',
  'curious',
  'confused',
];

const tileCenter = ({ x, y }: GridPoint) => ({
  x: x * DISPLAY_TILE_SIZE + DISPLAY_TILE_SIZE / 2,
  y: y * DISPLAY_TILE_SIZE + DISPLAY_TILE_SIZE / 2,
});

export class WorldScene extends Phaser.Scene {
  static readonly key = 'WorldScene';

  private cat: Phaser.GameObjects.Sprite | undefined;
  private readonly navigation = new NavigationSystem({
    width: ROOM_GRID.width,
    height: ROOM_GRID.height,
    blocked: createRoomBlockedTiles(),
  });
  private readonly ambient = new AmbientBehaviorSystem({
    random: Math.random,
    now: () => this.time.now,
    cooldownMs: 7_000,
  });
  private readonly runtime = new WorldRuntimeState();
  private movementCompletion:
    | { resolve: () => void; reject: (error: Error) => void; removeAbortListener: () => void }
    | undefined;

  constructor() {
    super(WorldScene.key);
  }

  preload(): void {
    this.load.image('room-background', '/assets/room/room-background.png');
    this.load.spritesheet('room-furniture', '/assets/room/furniture-atlas.png', {
      frameWidth: 64,
      frameHeight: 64,
    });
    this.load.spritesheet('cat', '/assets/cat/cat-atlas.png', {
      frameWidth: 32,
      frameHeight: 32,
    });
  }

  create(): void {
    this.resetSceneState();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.handleShutdown, this);
    this.cameras.main.setBackgroundColor('#3a3029');
    this.add.image(0, 0, 'room-background').setOrigin(0).setScale(DISPLAY_SCALE).setDepth(0);

    for (const object of ROOM_OBJECTS) {
      if (object.renderFromAtlas === false) continue;
      this.add
        .image(
          object.spritePosition.x * DISPLAY_SCALE,
          object.spritePosition.y * DISPLAY_SCALE,
          'room-furniture',
          object.frame,
        )
        .setOrigin(0)
        .setScale(DISPLAY_SCALE)
        .setDepth(
          bottomDepthFromTopLeft(
            object.spritePosition.y * DISPLAY_SCALE,
            64 * DISPLAY_SCALE,
          ),
        );
    }

    this.createAnimations();
    const start = tileCenter(CAT_SPAWN_TILE);
    this.cat = this.add
      .sprite(start.x, start.y, 'cat', 0)
      .setScale(DISPLAY_SCALE)
      .setDepth(bottomDepthFromCenter(start.y, 32 * DISPLAY_SCALE));
    this.playEmotion('idle');
    gameEvents.emit('world-ready', this.getSnapshot());
  }

  update(_time: number, delta: number): void {
    if (this.runtime.path.length > 0) {
      this.advanceMovement(delta);
      return;
    }
    if (this.runtime.agentBusy || this.time.now < this.runtime.ambientSettledUntil) return;

    const action = evaluateAmbientBehavior(
      this.ambient,
      this.runtime.agentBusy,
      () => {
        const catTile = this.getCatTile();
        return {
          agentBusy: this.runtime.agentBusy,
          blockedObjectIds: new Set(
            ROOM_OBJECTS.filter(
              ({ walkTarget }) =>
                this.navigation.findPath(catTile, walkTarget, 'ambient').length === 0,
            ).map(({ id }) => id),
          ),
          wanderTiles: WANDER_TILES.filter(
            (tile) => this.navigation.findPath(catTile, tile, 'ambient').length > 0,
          ),
        };
      },
    );
    if (action) this.runAmbientAction(action);
  }

  setAgentBusy(busy: boolean): void {
    this.runtime.agentBusy = busy;
    if (busy && this.runtime.movementOwner === 'ambient') this.cancelMovement('ambient');
  }

  hasActionTarget(targetId: WorldObjectId): boolean {
    return ROOM_OBJECTS.some(({ id }) => id === targetId);
  }

  async moveToActionTarget(targetId: WorldObjectId, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.hasActionTarget(targetId)) throw new Error(`Unknown target: ${targetId}`);
    if (!this.moveCatTo(targetId, 'agent', 'idle')) {
      throw new Error(`Unable to reach target: ${targetId}`);
    }
    if (this.runtime.movementOwner !== 'agent') return;

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        this.cancelMovement('agent');
        reject(abortError());
        return;
      }
      const abort = () => {
        this.cancelMovement('agent');
        reject(abortError());
      };
      signal.addEventListener('abort', abort, { once: true });
      this.movementCompletion = {
        resolve,
        reject,
        removeAbortListener: () => signal.removeEventListener('abort', abort),
      };
    });
  }

  async interactWithActionTarget(
    targetId: WorldObjectId,
    interaction: Interaction,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const target = getWorldObject(targetId);
    if (this.runtime.currentTargetId !== targetId) {
      throw new Error(`Cat is not at target: ${targetId}`);
    }
    if (!target.interactions.includes(interaction)) {
      throw new Error(`${targetId} does not support ${interaction}`);
    }
    const emotion: Emotion =
      interaction === 'rest'
        ? targetId === 'bed'
          ? 'sleep'
          : 'sit'
        : interaction === 'eat' || interaction === 'play'
          ? 'happy'
          : 'curious';
    this.playEmotion(emotion);
    gameEvents.emit('world-snapshot', this.getSnapshot());
  }

  async emoteForAction(
    emotion: Emotion,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    this.playEmotion(emotion);
    await abortableDelay(durationMs, signal);
    this.playEmotion('idle');
    gameEvents.emit('world-snapshot', this.getSnapshot());
  }

  waitForAction(durationMs: number, signal: AbortSignal): Promise<void> {
    return abortableDelay(durationMs, signal);
  }

  async speakForAction(text: string, signal: AbortSignal): Promise<void> {
    gameEvents.emit('bubble-changed', { kind: 'speech', text });
    try {
      await abortableDelay(Math.min(2_500, Math.max(600, text.length * 35)), signal);
    } finally {
      gameEvents.emit('bubble-changed', { kind: 'speech' });
    }
  }

  moveCatTo(targetId: WorldObjectId, owner = 'agent', arrivalEmotion: Emotion = 'idle'): boolean {
    const target = getWorldObject(targetId);
    const started = this.moveCatToTile(target.walkTarget, owner, arrivalEmotion);
    if (started) this.runtime.currentTargetId = targetId;
    return started;
  }

  moveCatToTile(target: GridPoint, owner = 'agent', arrivalEmotion: Emotion = 'idle'): boolean {
    if (this.runtime.movementOwner && this.runtime.movementOwner !== owner) return false;
    this.navigation.release(owner);
    if (!this.navigation.reserve(target, owner)) return false;
    const path = this.navigation.findPath(this.getCatTile(), target, owner);
    if (path.length === 0) {
      this.navigation.release(owner);
      return false;
    }
    this.runtime.path = path.slice(1);
    this.runtime.movementOwner = owner;
    this.runtime.pendingEmotion = arrivalEmotion;
    this.playEmotion(this.runtime.path.length > 0 ? 'walk' : 'idle');
    if (this.runtime.path.length === 0) this.finishMovement();
    return true;
  }

  playEmotion(emotion: Emotion): void {
    this.runtime.currentEmotion = emotion;
    const animationKey = `cat-${emotion}`;
    if (this.cat && this.anims.exists(animationKey)) this.cat.play(animationKey, true);
  }

  getSnapshot(): WorldSnapshot {
    const cat = this.cat;
    const catState: WorldSnapshot['cat'] = {
      position: cat
        ? { x: cat.x / DISPLAY_SCALE, y: cat.y / DISPLAY_SCALE }
        : {
            x: CAT_SPAWN_TILE.x * ROOM_GRID.tileSize + ROOM_GRID.tileSize / 2,
            y: CAT_SPAWN_TILE.y * ROOM_GRID.tileSize + ROOM_GRID.tileSize / 2,
          },
      emotion: this.runtime.currentEmotion,
    };
    if (this.runtime.currentTargetId) catState.currentTargetId = this.runtime.currentTargetId;
    return {
      cat: catState,
      objects: ROOM_OBJECTS.map((object) => ({
        id: object.id,
        position: object.interactionPoint,
        available: true,
        interactions: [...object.interactions],
      })),
    };
  }

  getStateSnapshot(): WorldSnapshot {
    return this.getSnapshot();
  }

  private createAnimations(): void {
    animationStates.forEach((state, row) => {
      const key = `cat-${state}`;
      if (this.anims.exists(key)) return;
      this.anims.create({
        key,
        frames: this.anims.generateFrameNumbers('cat', { start: row * 4, end: row * 4 + 3 }),
        frameRate: state === 'walk' ? 9 : 5,
        repeat: -1,
      });
    });
  }

  private runAmbientAction(action: AmbientAction): void {
    if (action.type === 'wander') {
      this.runtime.currentTargetId = undefined;
      this.moveCatToTile(action.tile, 'ambient', 'idle');
      return;
    }
    const pendingEmotion =
      action.type === 'rest' ? (action.targetId === 'bed' ? 'sleep' : 'sit') : 'curious';
    this.moveCatTo(action.targetId, 'ambient', pendingEmotion);
  }

  private advanceMovement(delta: number): void {
    const cat = this.cat;
    if (!cat) return;
    const nextTile = this.runtime.path[0];
    if (!nextTile) {
      this.finishMovement();
      return;
    }
    const target = tileCenter(nextTile);
    const distance = Phaser.Math.Distance.Between(cat.x, cat.y, target.x, target.y);
    const step = (96 * delta) / 1_000;
    if (distance <= step) {
      cat.setPosition(target.x, target.y);
      this.runtime.path.shift();
      if (this.runtime.path.length === 0) this.finishMovement();
    } else {
      const angle = Phaser.Math.Angle.Between(cat.x, cat.y, target.x, target.y);
      cat.x += Math.cos(angle) * step;
      cat.y += Math.sin(angle) * step;
      cat.setFlipX(Math.cos(angle) < 0);
    }
    cat.setDepth(bottomDepthFromCenter(cat.y, cat.displayHeight));
  }

  private finishMovement(): void {
    if (this.runtime.movementOwner) this.navigation.release(this.runtime.movementOwner);
    const wasAmbient = this.runtime.movementOwner === 'ambient';
    this.runtime.path = [];
    this.runtime.movementOwner = null;
    this.playEmotion(this.runtime.pendingEmotion);
    if (wasAmbient) this.runtime.ambientSettledUntil = this.time.now + 2_500;
    this.resolveMovementCompletion();
    gameEvents.emit('world-snapshot', this.getSnapshot());
  }

  private cancelMovement(owner: string): void {
    this.navigation.release(owner);
    this.runtime.path = [];
    this.runtime.movementOwner = null;
    this.runtime.currentTargetId = undefined;
    this.playEmotion('idle');
    if (owner === 'agent') this.rejectMovementCompletion(abortError());
  }

  private getCatTile(): GridPoint {
    if (!this.cat) return CAT_SPAWN_TILE;
    return {
      x: Math.floor(this.cat.x / DISPLAY_TILE_SIZE),
      y: Math.floor(this.cat.y / DISPLAY_TILE_SIZE),
    };
  }

  private resetSceneState(): void {
    this.rejectMovementCompletion(new Error('World scene reset'));
    this.cat?.stop();
    this.runtime.reset(this.navigation, this.ambient);
  }

  private handleShutdown(): void {
    this.resetSceneState();
    this.cat = undefined;
  }

  private resolveMovementCompletion(): void {
    const completion = this.movementCompletion;
    this.movementCompletion = undefined;
    completion?.removeAbortListener();
    completion?.resolve();
  }

  private rejectMovementCompletion(error: Error): void {
    const completion = this.movementCompletion;
    this.movementCompletion = undefined;
    completion?.removeAbortListener();
    completion?.reject(error);
  }
}

function abortableDelay(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, durationMs);
    const abort = () => {
      clearTimeout(timeoutId);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function abortError(): DOMException {
  return new DOMException('World action cancelled', 'AbortError');
}
