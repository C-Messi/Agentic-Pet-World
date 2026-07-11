import type { Emotion, WorldObjectId, WorldSnapshot } from '@cat-house/shared';
import Phaser from 'phaser';

import { AmbientBehaviorSystem, type AmbientAction } from '../behavior/ambient-behavior';
import { NavigationSystem } from '../navigation/navigation-system';
import {
  ROOM_GRID,
  ROOM_OBJECTS,
  CAT_SPAWN_TILE,
  createRoomBlockedTiles,
  getWorldObject,
  type GridPoint,
} from '../world/object-registry';

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

  private cat!: Phaser.GameObjects.Sprite;
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
  private path: GridPoint[] = [];
  private movementOwner: string | null = null;
  private pendingEmotion: Emotion = 'idle';
  private currentEmotion: Emotion = 'idle';
  private currentTargetId: WorldObjectId | undefined;
  private agentBusy = false;
  private ambientSettledUntil = 0;

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
        .setDepth(object.spritePosition.y + 64);
    }

    this.createAnimations();
    const start = tileCenter(CAT_SPAWN_TILE);
    this.cat = this.add.sprite(start.x, start.y, 'cat', 0).setScale(DISPLAY_SCALE).setDepth(start.y + 32);
    this.playEmotion('idle');
    this.game.events.emit('world-ready', this.getSnapshot());
  }

  update(_time: number, delta: number): void {
    if (this.path.length > 0) {
      this.advanceMovement(delta);
      return;
    }
    if (this.agentBusy || this.time.now < this.ambientSettledUntil) return;

    const catTile = this.getCatTile();
    const blockedObjectIds = new Set(
      ROOM_OBJECTS.filter(
        ({ walkTarget }) => this.navigation.findPath(catTile, walkTarget, 'ambient').length === 0,
      ).map(({ id }) => id),
    );
    const action = this.ambient.select({
      agentBusy: this.agentBusy,
      blockedObjectIds,
      wanderTiles: WANDER_TILES.filter(
        (tile) => this.navigation.findPath(catTile, tile, 'ambient').length > 0,
      ),
    });
    if (action) this.runAmbientAction(action);
  }

  setAgentBusy(busy: boolean): void {
    this.agentBusy = busy;
    if (busy && this.movementOwner === 'ambient') this.cancelMovement('ambient');
  }

  moveCatTo(targetId: WorldObjectId, owner = 'agent', arrivalEmotion: Emotion = 'idle'): boolean {
    const target = getWorldObject(targetId);
    const started = this.moveCatToTile(target.walkTarget, owner, arrivalEmotion);
    if (started) this.currentTargetId = targetId;
    return started;
  }

  moveCatToTile(target: GridPoint, owner = 'agent', arrivalEmotion: Emotion = 'idle'): boolean {
    if (this.movementOwner && this.movementOwner !== owner) return false;
    this.navigation.release(owner);
    if (!this.navigation.reserve(target, owner)) return false;
    const path = this.navigation.findPath(this.getCatTile(), target, owner);
    if (path.length === 0) {
      this.navigation.release(owner);
      return false;
    }
    this.path = path.slice(1);
    this.movementOwner = owner;
    this.pendingEmotion = arrivalEmotion;
    this.playEmotion(this.path.length > 0 ? 'walk' : 'idle');
    if (this.path.length === 0) this.finishMovement();
    return true;
  }

  playEmotion(emotion: Emotion): void {
    this.currentEmotion = emotion;
    const animationKey = `cat-${emotion}`;
    if (this.anims.exists(animationKey)) this.cat.play(animationKey, true);
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
      emotion: this.currentEmotion,
    };
    if (this.currentTargetId) catState.currentTargetId = this.currentTargetId;
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
      this.currentTargetId = undefined;
      this.moveCatToTile(action.tile, 'ambient', 'idle');
      return;
    }
    const pendingEmotion =
      action.type === 'rest' ? (action.targetId === 'bed' ? 'sleep' : 'sit') : 'curious';
    this.moveCatTo(action.targetId, 'ambient', pendingEmotion);
  }

  private advanceMovement(delta: number): void {
    const nextTile = this.path[0];
    if (!nextTile) {
      this.finishMovement();
      return;
    }
    const target = tileCenter(nextTile);
    const distance = Phaser.Math.Distance.Between(this.cat.x, this.cat.y, target.x, target.y);
    const step = (96 * delta) / 1_000;
    if (distance <= step) {
      this.cat.setPosition(target.x, target.y);
      this.path.shift();
      if (this.path.length === 0) this.finishMovement();
    } else {
      const angle = Phaser.Math.Angle.Between(this.cat.x, this.cat.y, target.x, target.y);
      this.cat.x += Math.cos(angle) * step;
      this.cat.y += Math.sin(angle) * step;
      this.cat.setFlipX(Math.cos(angle) < 0);
    }
    this.cat.setDepth(this.cat.y + 32);
  }

  private finishMovement(): void {
    if (this.movementOwner) this.navigation.release(this.movementOwner);
    const wasAmbient = this.movementOwner === 'ambient';
    this.path = [];
    this.movementOwner = null;
    this.playEmotion(this.pendingEmotion);
    if (wasAmbient) this.ambientSettledUntil = this.time.now + 2_500;
    this.game.events.emit('world-snapshot', this.getSnapshot());
  }

  private cancelMovement(owner: string): void {
    this.navigation.release(owner);
    this.path = [];
    this.movementOwner = null;
    this.currentTargetId = undefined;
    this.playEmotion('idle');
  }

  private getCatTile(): GridPoint {
    if (!this.cat) return CAT_SPAWN_TILE;
    return {
      x: Math.floor(this.cat.x / DISPLAY_TILE_SIZE),
      y: Math.floor(this.cat.y / DISPLAY_TILE_SIZE),
    };
  }
}
