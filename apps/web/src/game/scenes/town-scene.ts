import {
  PET_ANIMATION_NAMES,
  TownProjectionSchema,
  type Position,
  type TownEvent,
  type TownProjection,
} from '@cat-house/shared';
import Phaser from 'phaser';

import { gameEvents } from '../events';
import { TOWN_GRID, TownNavigation } from '../town/town-navigation';
import type { TownScenePort } from '../town/town-event-player';
import {
  TOWN_CAMERA_LAYOUT,
  TOWN_ZONE_PRESENTATIONS,
} from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

export { DEFAULT_TOWN_SPAWNS } from './town-scene-layout';

const PET_SCALE = 1.5;
const WORLD_WIDTH = TOWN_CAMERA_LAYOUT.world.width;
const WORLD_HEIGHT = TOWN_CAMERA_LAYOUT.world.height;
const TOWN_BACKGROUND = TOWN_CAMERA_LAYOUT.background;
const PET_SPRITES = [
  'player-cat',
  'orange-cat',
  'gray-cat',
  'blue-cat',
  'cream-cat',
] as const;

export function horizontalFacing(fromX: number, toX: number): 1 | -1 {
  return toX < fromX ? -1 : 1;
}

export function residentMovementPath(
  from: Position,
  to: Position,
  navigation = new TownNavigation(),
): Position[] {
  return navigation.findPath(from, to);
}

export class TownScene extends Phaser.Scene implements TownScenePort {
  static readonly key = 'TownScene';

  readonly state = new TownSceneState();
  readonly #navigation = new TownNavigation();
  readonly #residents = new Map<string, Phaser.GameObjects.Sprite>();
  readonly #residentPositions = new Map<string, Position>();
  readonly #modifications = new Map<string, Phaser.GameObjects.Image>();
  #projection: TownProjection | undefined;
  #bubble: Phaser.GameObjects.Container | undefined;

  constructor() {
    super(TownScene.key);
  }

  init(data?: { snapshot?: TownProjection }): void {
    if (data?.snapshot)
      this.#projection = TownProjectionSchema.parse(data.snapshot);
  }

  preload(): void {
    this.load.image('town-background', '/assets/town/town-background.png');
    this.load.spritesheet('town-atlas', '/assets/town/town-atlas.png', {
      frameWidth: 64,
      frameHeight: 64,
    });
    for (const spriteId of PET_SPRITES) {
      this.load.spritesheet(
        spriteId,
        `/assets/pets/${spriteId}/pet-atlas.png`,
        { frameWidth: 32, frameHeight: 32 },
      );
    }
  }

  create(): void {
    this.cameras.main
      .setBackgroundColor('#73b98b')
      .setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
      .setZoom(TOWN_CAMERA_LAYOUT.zoom);
    this.add
      .image(TOWN_BACKGROUND.x, TOWN_BACKGROUND.y, 'town-background')
      .setOrigin(0)
      .setDepth(0);
    this.#createZoneEnvironment();
    this.#createAnimations();
    if (this.#projection) this.applySnapshot(this.#projection);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.#reset());
  }

  applySnapshot(snapshot: TownProjection): void {
    const parsed = TownProjectionSchema.parse(snapshot);
    this.#projection = parsed;
    this.#navigation.restoreModifications(parsed.modifications);
    for (const sprite of this.#residents.values()) sprite.destroy();
    this.#residents.clear();
    this.#residentPositions.clear();
    for (const resident of parsed.residents)
      this.#spawnResident(
        resident.residentId,
        resident.pet.spriteId,
        resident.position,
      );
    for (const image of this.#modifications.values()) image.destroy();
    this.#modifications.clear();
    for (const modification of parsed.modifications)
      this.#renderModification(
        modification.id,
        modification.atlasFrame,
        modification.occupiedCells[0]!,
      );
    const player =
      parsed.residents.find(({ pet }) => pet.source === 'player-pet')
        ?.residentId ?? parsed.residents[0]!.residentId;
    this.followResident(
      this.#residents.has(this.state.followedResidentId)
        ? this.state.followedResidentId
        : player,
    );
    gameEvents.emit('town-ready', parsed);
  }

  async moveResident(
    residentId: string,
    position: Position,
    signal: AbortSignal,
  ): Promise<void> {
    const sprite = this.#requireResident(residentId);
    const current = this.#residentPositions.get(residentId);
    if (!current)
      throw new Error(`Town resident position not tracked: ${residentId}`);
    const path = residentMovementPath(current, position, this.#navigation);
    if (path.length === 0)
      throw new Error(`Town resident path is not walkable: ${residentId}`);
    let confirmed = current;
    sprite.play(`${residentId}:walk`, true);
    try {
      if (signal.aborted) throw abortError();
      for (const step of path.slice(1)) {
        const target = tileCenter(step);
        sprite.setFlipX(horizontalFacing(sprite.x, target.x) < 0);
        await this.#tweenTo(sprite, target, signal);
        confirmed = step;
        this.#residentPositions.set(residentId, { ...confirmed });
      }
      sprite.play(`${residentId}:idle`, true);
    } catch (error) {
      const point = tileCenter(confirmed);
      sprite.x = point.x;
      sprite.y = point.y;
      sprite.setDepth(point.y + 32);
      sprite.play(`${residentId}:idle`, true);
      throw error;
    }
  }

  async speak(
    residentId: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    this.#requireResident(residentId);
    this.state.showBubble(residentId, text);
    this.#renderBubble();
    await delay(this, 1_300, signal);
    this.state.clearBubble(residentId);
    this.#renderBubble();
  }

  async playActivity(event: TownEvent, signal: AbortSignal): Promise<void> {
    const animation = event.type.startsWith('fortune.')
      ? 'curious'
      : event.type.startsWith('stall.')
        ? 'sit'
        : 'happy';
    if (event.participantIds.length === 2) {
      const first = this.#residents.get(event.participantIds[0]!);
      const second = this.#residents.get(event.participantIds[1]!);
      if (first && second) {
        first.setFlipX(horizontalFacing(first.x, second.x) < 0);
        second.setFlipX(horizontalFacing(second.x, first.x) < 0);
      }
    }
    for (const id of event.participantIds)
      this.#residents.get(id)?.play(`${id}:${animation}`, true);
    await delay(this, 550, signal);
    for (const id of event.participantIds)
      this.#residents.get(id)?.play(`${id}:idle`, true);
  }

  async applyModification(
    event: TownEvent,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw abortError();
    if (event.type !== 'build.completed') return;
    const modification = event.payload.modification;
    this.#navigation.restoreModifications([
      ...(this.#projection?.modifications ?? []),
      modification,
    ]);
    this.#renderModification(
      modification.id,
      modification.atlasFrame,
      modification.occupiedCells[0]!,
    );
  }

  followResident(residentId: string): void {
    this.#requireResident(residentId);
    this.state.follow(residentId);
    this.cameras.main.stopFollow();
    this.cameras.main.centerOn(WORLD_WIDTH / 2, WORLD_HEIGHT / 2);
    gameEvents.emit('town-follow-changed', { residentId });
  }

  #spawnResident(
    residentId: string,
    spriteId: string,
    position: Position,
  ): void {
    const point = tileCenter(position);
    const sprite = this.add
      .sprite(point.x, point.y, spriteId, 0)
      .setScale(PET_SCALE)
      .setDepth(point.y + 32)
      .setInteractive({ useHandCursor: true });
    sprite.on('pointerdown', () => this.followResident(residentId));
    this.#residents.set(residentId, sprite);
    this.#residentPositions.set(residentId, { ...position });
    sprite.play(`${residentId}:idle`);
  }

  #createAnimations(): void {
    for (const resident of this.#projection?.residents ?? []) {
      PET_ANIMATION_NAMES.forEach((name, row) => {
        const key = `${resident.residentId}:${name}`;
        if (this.anims.exists(key)) return;
        this.anims.create({
          key,
          frames: this.anims.generateFrameNumbers(resident.pet.spriteId, {
            start: row * 4,
            end: row * 4 + 3,
          }),
          frameRate: name === 'walk' ? 9 : 5,
          repeat: -1,
        });
      });
    }
  }

  #createZoneEnvironment(): void {
    for (const zone of Object.values(TOWN_ZONE_PRESENTATIONS)) {
      for (const part of zone.parts) {
        const anchor = tileCenter(part.anchor);
        this.add
          .image(
            anchor.x + part.offset.x,
            anchor.y + part.offset.y,
            'town-atlas',
            part.frame,
          )
          .setDepth(part.foreground ? 9_000 : anchor.y + part.depthOffset);
      }

      const point = tileCenter(zone.entrance);
      this.add
        .image(point.x, point.y - 22, 'town-atlas', zone.signFrame)
        .setDepth(point.y - 1);
    }
  }

  #renderModification(id: string, frame: number, cell: Position): void {
    this.#modifications.get(id)?.destroy();
    const point = tileCenter(cell);
    this.#modifications.set(
      id,
      this.add
        .image(point.x, point.y, 'town-atlas', frame)
        .setDepth(point.y + 24),
    );
  }

  #renderBubble(): void {
    this.#bubble?.destroy();
    this.#bubble = undefined;
    const bubble = this.state.bubble;
    if (!bubble) return;
    const owner = this.#residents.get(bubble.ownerId);
    if (!owner) return;
    const text = this.add
      .text(0, 0, bubble.text, {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: '#2d2520',
        backgroundColor: '#fff8df',
        padding: { x: 6, y: 4 },
        wordWrap: { width: 140 },
      })
      .setOrigin(0.5, 1);
    this.#bubble = this.add
      .container(owner.x, owner.y - 30, [text])
      .setDepth(10_000);
  }

  #requireResident(id: string): Phaser.GameObjects.Sprite {
    const resident = this.#residents.get(id);
    if (!resident) throw new Error(`Town resident not rendered: ${id}`);
    return resident;
  }

  #tweenTo(
    sprite: Phaser.GameObjects.Sprite,
    target: Position,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const tween = this.tweens.add({
        targets: sprite,
        x: target.x,
        y: target.y,
        duration: 450,
        onUpdate: () => sprite.setDepth(sprite.y + 32),
        onComplete: () => {
          cleanup();
          resolve();
        },
      });
      const abort = () => {
        tween.stop();
        cleanup();
        reject(abortError());
      };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  #reset(): void {
    this.#residents.clear();
    this.#residentPositions.clear();
    this.#modifications.clear();
    this.#bubble = undefined;
  }
}

function tileCenter({ x, y }: Position): Position {
  return {
    x: Math.min(
      WORLD_WIDTH - 16,
      Math.max(16, TOWN_BACKGROUND.x + x * TOWN_GRID.tileSize + 16),
    ),
    y: Math.min(
      WORLD_HEIGHT - 16,
      Math.max(16, TOWN_BACKGROUND.y + y * TOWN_GRID.tileSize + 16),
    ),
  };
}

function abortError(): DOMException {
  return new DOMException('Town action cancelled', 'AbortError');
}

function delay(
  scene: Phaser.Scene,
  duration: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = scene.time.delayedCall(duration, () => {
      cleanup();
      resolve();
    });
    const abort = () => {
      timer.remove();
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}
