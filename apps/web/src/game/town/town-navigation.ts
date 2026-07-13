import type { Position, TownZoneId } from '@cat-house/shared';

export type TownZone = {
  id: TownZoneId;
  bounds: { x: number; y: number; width: number; height: number };
  entrance: Position;
};

export const TOWN_GRID = { width: 20, height: 11, tileSize: 32 } as const;

export const TOWN_ZONES: readonly TownZone[] = [
  { id: 'gate', bounds: { x: 0, y: 7, width: 4, height: 4 }, entrance: { x: 2, y: 9 } },
  { id: 'plaza', bounds: { x: 7, y: 4, width: 6, height: 4 }, entrance: { x: 10, y: 6 } },
  { id: 'fortune-pavilion', bounds: { x: 1, y: 1, width: 5, height: 4 }, entrance: { x: 4, y: 4 } },
  { id: 'market', bounds: { x: 14, y: 1, width: 6, height: 5 }, entrance: { x: 15, y: 5 } },
  { id: 'garden', bounds: { x: 1, y: 5, width: 6, height: 3 }, entrance: { x: 5, y: 7 } },
  { id: 'build-plots', bounds: { x: 8, y: 7, width: 5, height: 4 }, entrance: { x: 10, y: 8 } },
  { id: 'arcade-house', bounds: { x: 14, y: 6, width: 5, height: 4 }, entrance: { x: 15, y: 8 } },
];

type Occupancy = { occupiedCells: readonly Position[]; collision: boolean };

const key = ({ x, y }: Position) => `${x}:${y}`;

export class TownNavigation {
  readonly #blocked = new Set<string>();

  restoreModifications(modifications: readonly Occupancy[]): void {
    this.#blocked.clear();
    for (const modification of modifications) {
      if (!modification.collision) continue;
      for (const cell of modification.occupiedCells) this.#blocked.add(key(cell));
    }
  }

  isBlocked(position: Position): boolean {
    return position.x < 0 || position.y < 0 || position.x >= TOWN_GRID.width || position.y >= TOWN_GRID.height || this.#blocked.has(key(position));
  }

  findPath(start: Position, target: Position): Position[] {
    if (this.isBlocked(start) || this.isBlocked(target)) return [];
    const queue: Position[] = [start];
    const parents = new Map<string, Position | undefined>([[key(start), undefined]]);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index]!;
      if (key(current) === key(target)) return reconstruct(current, parents);
      for (const next of neighbors(current)) {
        if (this.isBlocked(next) || parents.has(key(next))) continue;
        parents.set(key(next), current);
        queue.push(next);
      }
    }
    return [];
  }
}

function neighbors({ x, y }: Position): Position[] {
  return [{ x: x + 1, y }, { x: x - 1, y }, { x, y: y + 1 }, { x, y: y - 1 }];
}

function reconstruct(target: Position, parents: ReadonlyMap<string, Position | undefined>): Position[] {
  const result: Position[] = [];
  let current: Position | undefined = target;
  while (current !== undefined) {
    result.push(current);
    current = parents.get(key(current));
  }
  return result.reverse();
}
