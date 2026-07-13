import type { TownEvent, TownProjection } from '@cat-house/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const phaser = vi.hoisted(() => {
  type Sprite = {
    x: number;
    y: number;
    destroy: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    setDepth: ReturnType<typeof vi.fn>;
    setFlipX: ReturnType<typeof vi.fn>;
    setInteractive: ReturnType<typeof vi.fn>;
    setScale: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  type TweenConfig = {
    targets: Sprite;
    x: number;
    y: number;
    onUpdate: () => void;
    onComplete: () => void;
  };

  const sprites: Sprite[] = [];
  const tweens: TweenConfig[] = [];
  const chainable = () => {
    const object = {
      destroy: vi.fn(),
      setDepth: vi.fn(),
      setOrigin: vi.fn(),
    };
    object.setDepth.mockReturnValue(object);
    object.setOrigin.mockReturnValue(object);
    return object;
  };
  const makeSprite = (x: number, y: number): Sprite => {
    const sprite = {
      x,
      y,
      destroy: vi.fn(),
      play: vi.fn(),
      setDepth: vi.fn(),
      setFlipX: vi.fn(),
      setInteractive: vi.fn(),
      setScale: vi.fn(),
      on: vi.fn(),
    } as Sprite;
    sprite.setDepth.mockReturnValue(sprite);
    sprite.setFlipX.mockReturnValue(sprite);
    sprite.setInteractive.mockReturnValue(sprite);
    sprite.setScale.mockReturnValue(sprite);
    sprites.push(sprite);
    return sprite;
  };

  class Scene {
    cameras = {
      main: {
        centerOn: vi.fn(),
        stopFollow: vi.fn(),
      },
    };
    add = {
      container: vi.fn(chainable),
      image: vi.fn(chainable),
      sprite: vi.fn((x: number, y: number) => makeSprite(x, y)),
      text: vi.fn(chainable),
    };
    anims = {
      create: vi.fn(),
      exists: vi.fn(() => false),
      generateFrameNumbers: vi.fn(() => []),
    };
    events = { once: vi.fn() };
    time = {
      delayedCall: vi.fn((_duration: number, callback: () => void) => {
        queueMicrotask(callback);
        return { remove: vi.fn() };
      }),
    };
    tweens = {
      add: vi.fn((config: TweenConfig) => {
        tweens.push(config);
        return { stop: vi.fn() };
      }),
    };
  }

  return {
    Scene,
    sprites,
    tweens,
    reset: () => {
      sprites.length = 0;
      tweens.length = 0;
    },
  };
});

vi.mock('phaser', () => ({
  default: {
    Scene: phaser.Scene,
    Scenes: { Events: { SHUTDOWN: 'shutdown' } },
  },
}));

import { TOWN_GRID, TOWN_ZONES, TownNavigation } from '../town/town-navigation';
import {
  horizontalFacing,
  residentMovementPath,
  TownScene,
} from './town-scene';
import {
  DEFAULT_TOWN_SPAWNS,
  TOWN_CAMERA_LAYOUT,
  TOWN_ZONE_PRESENTATIONS,
} from './town-scene-layout';
import { TownSceneState } from './town-scene-state';

const EXPECTED_ZONE_FRAMES = {
  'fortune-pavilion': [28, 29, 30, 31],
  garden: [32, 33, 34],
  market: [35, 36, 37],
  'arcade-house': [38, 39, 40, 41],
  'build-plots': [42, 43, 44],
  gate: [45, 46, 47],
  plaza: [61, 62],
} as const;

const EXPECTED_SIGN_FRAMES = {
  gate: 17,
  plaza: 23,
  'fortune-pavilion': 18,
  market: 19,
  garden: 20,
  'build-plots': 21,
  'arcade-house': 22,
} as const;

const projection: TownProjection = {
  sessionId: 'session-1',
  version: 1,
  lastEventSequence: 1,
  residents: [
    {
      residentId: 'player-cat',
      position: { x: 10, y: 9 },
      zoneId: 'gate',
      availability: 'available',
      pet: pet('player-cat', 'player-pet'),
    },
    {
      residentId: 'resident-huihui',
      position: { x: 4, y: 3 },
      zoneId: 'fortune-pavilion',
      availability: 'available',
      pet: pet('resident-huihui', 'resident'),
    },
  ],
  relationships: [],
  modifications: [],
  activities: [],
};

beforeEach(() => {
  phaser.reset();
  vi.clearAllMocks();
});

function assertTownPresentationIsReadonly(): void {
  // @ts-expect-error Town presentation part collections are immutable metadata.
  TOWN_ZONE_PRESENTATIONS.gate.parts = [];
  // @ts-expect-error Town presentation part collections expose no mutators.
  TOWN_ZONE_PRESENTATIONS.gate.parts.push(
    TOWN_ZONE_PRESENTATIONS.gate.parts[0]!,
  );
}
void assertTownPresentationIsReadonly;

describe('TownScene state', () => {
  it('faces toward the horizontal destination', () => {
    expect(horizontalFacing(10, 20)).toBe(1);
    expect(horizontalFacing(20, 10)).toBe(-1);
    expect(horizontalFacing(10, 10)).toBe(1);
  });

  it('uses deterministic town navigation for resident movement', () => {
    const from = { x: 10, y: 9 };
    const to = { x: 4, y: 3 };

    expect(residentMovementPath(from, to)).toEqual(
      new TownNavigation().findPath(from, to),
    );
  });

  it('moves a resident through every walkable grid step', async () => {
    const scene = new TownScene();
    scene.applySnapshot(projection);
    const path = residentMovementPath({ x: 10, y: 9 }, { x: 4, y: 3 });

    const moving = scene.moveResident(
      'player-cat',
      { x: 4, y: 3 },
      new AbortController().signal,
    );

    for (const step of path.slice(1)) {
      expect(phaser.tweens).toHaveLength(1);
      const tween = phaser.tweens.shift()!;
      expect({ x: tween.x, y: tween.y }).toEqual(tilePoint(step));
      tween.targets.x = tween.x;
      tween.targets.y = tween.y;
      tween.onUpdate();
      tween.onComplete();
      await Promise.resolve();
    }
    await moving;

    expect(phaser.sprites[0]?.setFlipX).toHaveBeenCalledTimes(path.length - 1);
  });

  it('rejects resident movement when no walkable path exists', async () => {
    const scene = new TownScene();
    scene.applySnapshot(projection);

    const moving = scene.moveResident(
      'player-cat',
      { x: -1, y: -1 },
      new AbortController().signal,
    );
    const unexpectedTween = phaser.tweens.shift();
    if (unexpectedTween) unexpectedTween.onComplete();

    await expect(moving).rejects.toThrow();
    expect(phaser.tweens).toHaveLength(0);
  });

  it('faces two activity participants toward each other', async () => {
    const scene = new TownScene();
    scene.applySnapshot(projection);

    await scene.playActivity(
      {
        type: 'activity.started',
        participantIds: ['player-cat', 'resident-huihui'],
      } as TownEvent,
      new AbortController().signal,
    );

    expect(phaser.sprites[0]?.setFlipX).toHaveBeenCalledWith(true);
    expect(phaser.sprites[1]?.setFlipX).toHaveBeenCalledWith(false);
  });

  it('provides five stable resident spawn positions', () => {
    expect(DEFAULT_TOWN_SPAWNS).toEqual({
      'player-cat': { x: 10, y: 9 },
      'resident-mikan': { x: 10, y: 6 },
      'resident-huihui': { x: 4, y: 3 },
      'resident-lanlan': { x: 15, y: 4 },
      'resident-doubao': { x: 15, y: 7 },
    });
    expect(Object.keys(DEFAULT_TOWN_SPAWNS)).toHaveLength(5);
    expect(
      new Set(Object.values(DEFAULT_TOWN_SPAWNS).map(({ x, y }) => `${x}:${y}`))
        .size,
    ).toBe(5);
  });

  it('keeps every default resident spawn walkable', () => {
    const navigation = new TownNavigation();
    for (const position of Object.values(DEFAULT_TOWN_SPAWNS)) {
      expect(navigation.isBlocked(position)).toBe(false);
    }
  });

  it('provides ordered layered parts for every shared town zone', () => {
    const byId = new Map(TOWN_ZONES.map((zone) => [zone.id, zone]));
    const navigation = new TownNavigation();
    const presentations = Object.values(TOWN_ZONE_PRESENTATIONS);

    expect(Object.keys(TOWN_ZONE_PRESENTATIONS).sort()).toEqual(
      TOWN_ZONES.map(({ id }) => id).sort(),
    );

    for (const presentation of presentations) {
      const zone = byId.get(presentation.zoneId);
      expect(zone).toBeDefined();
      if (!zone) continue;
      expect(presentation.entrance).toEqual(zone.entrance);
      expect(presentation.signFrame).toBe(
        EXPECTED_SIGN_FRAMES[presentation.zoneId],
      );
      expect(presentation.parts.length).toBeGreaterThanOrEqual(2);
      expect(presentation.parts.map(({ frame }) => frame)).toEqual(
        EXPECTED_ZONE_FRAMES[presentation.zoneId],
      );

      for (const part of presentation.parts) {
        expect(Number.isInteger(part.frame)).toBe(true);
        expect(part.frame).toBeGreaterThanOrEqual(0);
        expect(isInsideZone(part.anchor, zone.bounds)).toBe(true);
        expect(Number.isInteger(part.anchor.x)).toBe(true);
        expect(Number.isInteger(part.anchor.y)).toBe(true);
        expect(Number.isInteger(part.offset.x)).toBe(true);
        expect(Number.isInteger(part.offset.y)).toBe(true);
        expect(Number.isInteger(part.depthOffset)).toBe(true);
        expect(typeof part.foreground).toBe('boolean');
        for (const cell of part.collisionCells) {
          expect(isInsideZone(cell, zone.bounds)).toBe(true);
          expect(Number.isInteger(cell.x)).toBe(true);
          expect(Number.isInteger(cell.y)).toBe(true);
          expect(navigation.isBlocked(cell)).toBe(true);
        }
      }
    }
  });

  it('deep-freezes layered presentation metadata', () => {
    expect(Object.isFrozen(TOWN_ZONE_PRESENTATIONS)).toBe(true);

    for (const presentation of Object.values(TOWN_ZONE_PRESENTATIONS)) {
      expect(Object.isFrozen(presentation)).toBe(true);
      expect(Object.isFrozen(presentation.entrance)).toBe(true);
      expect(Object.isFrozen(presentation.parts)).toBe(true);

      for (const part of presentation.parts) {
        expect(Object.isFrozen(part)).toBe(true);
        expect(Object.isFrozen(part.anchor)).toBe(true);
        expect(Object.isFrozen(part.offset)).toBe(true);
        expect(Object.isFrozen(part.collisionCells)).toBe(true);
        for (const cell of part.collisionCells) {
          expect(Object.isFrozen(cell)).toBe(true);
        }
      }
    }
  });

  it('fills the camera width while keeping the complete town visible', () => {
    const visibleWidth =
      TOWN_CAMERA_LAYOUT.viewport.width / TOWN_CAMERA_LAYOUT.zoom;
    const visibleHeight =
      TOWN_CAMERA_LAYOUT.viewport.height / TOWN_CAMERA_LAYOUT.zoom;
    const visibleLeft = (TOWN_CAMERA_LAYOUT.world.width - visibleWidth) / 2;
    const visibleTop = (TOWN_CAMERA_LAYOUT.world.height - visibleHeight) / 2;

    expect(visibleWidth).toBe(TOWN_CAMERA_LAYOUT.background.width);
    expect(visibleLeft).toBe(TOWN_CAMERA_LAYOUT.background.x);
    expect(TOWN_CAMERA_LAYOUT.background.y).toBeGreaterThanOrEqual(visibleTop);
    expect(visibleHeight).toBeGreaterThanOrEqual(
      TOWN_CAMERA_LAYOUT.background.height,
    );
    expect(
      TOWN_CAMERA_LAYOUT.background.y + TOWN_CAMERA_LAYOUT.background.height,
    ).toBeLessThanOrEqual(visibleTop + visibleHeight);
  });

  it('switches camera follow and keeps bubbles owned by one resident', () => {
    const state = new TownSceneState();
    expect(state.followedResidentId).toBe('player-cat');

    state.follow('resident-mikan');
    state.showBubble('resident-mikan', '来抽签吧');
    expect(state.followedResidentId).toBe('resident-mikan');
    expect(state.bubble).toEqual({
      ownerId: 'resident-mikan',
      text: '来抽签吧',
    });

    state.showBubble('resident-huihui', '等等我');
    expect(state.bubble?.ownerId).toBe('resident-huihui');
  });
});

function isInsideZone(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    point.x >= bounds.x &&
    point.y >= bounds.y &&
    point.x < bounds.x + bounds.width &&
    point.y < bounds.y + bounds.height
  );
}

function pet(
  id: string,
  source: 'player-pet' | 'resident',
): TownProjection['residents'][number]['pet'] {
  return {
    schemaVersion: 'pet-definition.v1',
    id,
    displayName: id,
    source,
    species: 'cat',
    spriteId: source === 'player-pet' ? 'player-cat' : 'gray-cat',
    palette: {
      primary: '#112233',
      secondary: '#445566',
      accent: '#778899',
    },
    personality: {
      curiosity: 0.5,
      sociability: 0.5,
      playfulness: 0.5,
      creativity: 0.5,
    },
    voice: { style: 'warm', catchphrases: [] },
    interests: [],
    publicBio: `${id} explores the town.`,
  };
}

function tilePoint({ x, y }: { x: number; y: number }): {
  x: number;
  y: number;
} {
  return {
    x: TOWN_CAMERA_LAYOUT.background.x + x * TOWN_GRID.tileSize + 16,
    y: TOWN_CAMERA_LAYOUT.background.y + y * TOWN_GRID.tileSize + 16,
  };
}
