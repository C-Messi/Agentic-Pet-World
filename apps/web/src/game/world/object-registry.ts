import type { Interaction, WorldObjectId } from '@cat-house/shared';

export interface GridPoint {
  x: number;
  y: number;
}

export interface RoomObjectDefinition {
  id: WorldObjectId;
  frame: number;
  spritePosition: GridPoint;
  walkTarget: GridPoint;
  interactionPoint: GridPoint;
  interactions: readonly Interaction[];
  occupiedTiles: readonly GridPoint[];
}

const rectangleTiles = (x: number, y: number, width: number, height: number): GridPoint[] =>
  Array.from({ length: width * height }, (_, index) => ({
    x: x + (index % width),
    y: y + Math.floor(index / width),
  }));

export const ROOM_GRID = { width: 24, height: 16, tileSize: 16 } as const;

export const ROOM_OBJECTS: readonly RoomObjectDefinition[] = [
  {
    id: 'bed',
    frame: 0,
    spritePosition: { x: 16, y: 48 },
    walkTarget: { x: 6, y: 5 },
    interactionPoint: { x: 104, y: 88 },
    interactions: ['inspect', 'rest'],
    occupiedTiles: rectangleTiles(1, 3, 5, 4),
  },
  {
    id: 'sofa',
    frame: 1,
    spritePosition: { x: 128, y: 32 },
    walkTarget: { x: 10, y: 6 },
    interactionPoint: { x: 168, y: 104 },
    interactions: ['inspect', 'rest'],
    occupiedTiles: rectangleTiles(8, 2, 4, 4),
  },
  {
    id: 'window',
    frame: 2,
    spritePosition: { x: 272, y: 0 },
    walkTarget: { x: 19, y: 4 },
    interactionPoint: { x: 312, y: 64 },
    interactions: ['inspect', 'open'],
    occupiedTiles: rectangleTiles(17, 1, 4, 2),
  },
  {
    id: 'food-bowl',
    frame: 3,
    spritePosition: { x: 304, y: 192 },
    walkTarget: { x: 18, y: 13 },
    interactionPoint: { x: 296, y: 216 },
    interactions: ['inspect', 'eat'],
    occupiedTiles: rectangleTiles(19, 13, 3, 2),
  },
  {
    id: 'bookshelf',
    frame: 4,
    spritePosition: { x: 304, y: 48 },
    walkTarget: { x: 18, y: 6 },
    interactionPoint: { x: 296, y: 104 },
    interactions: ['inspect'],
    occupiedTiles: rectangleTiles(19, 3, 4, 4),
  },
  {
    id: 'toy-basket',
    frame: 5,
    spritePosition: { x: 32, y: 176 },
    walkTarget: { x: 6, y: 13 },
    interactionPoint: { x: 104, y: 216 },
    interactions: ['inspect', 'play'],
    occupiedTiles: rectangleTiles(2, 12, 4, 3),
  },
  {
    id: 'arcade',
    frame: 6,
    spritePosition: { x: 304, y: 128 },
    walkTarget: { x: 18, y: 10 },
    interactionPoint: { x: 296, y: 168 },
    interactions: ['inspect', 'play', 'open'],
    occupiedTiles: rectangleTiles(19, 8, 4, 4),
  },
] as const;

const objectById = new Map(ROOM_OBJECTS.map((object) => [object.id, object]));

export function getWorldObject(id: WorldObjectId): RoomObjectDefinition {
  const object = objectById.get(id);
  if (!object) throw new Error(`Unknown room object: ${id}`);
  return object;
}

export function createRoomBlockedTiles(): GridPoint[] {
  const border: GridPoint[] = [];
  for (let x = 0; x < ROOM_GRID.width; x += 1) {
    border.push({ x, y: 0 }, { x, y: ROOM_GRID.height - 1 });
  }
  for (let y = 1; y < ROOM_GRID.height - 1; y += 1) {
    border.push({ x: 0, y }, { x: ROOM_GRID.width - 1, y });
  }
  return [...border, ...ROOM_OBJECTS.flatMap(({ occupiedTiles }) => occupiedTiles)];
}
