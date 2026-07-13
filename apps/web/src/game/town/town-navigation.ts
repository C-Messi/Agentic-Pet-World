import {
  TOWN_GRID,
  TOWN_STATIC_BLOCKED_CELLS,
  TOWN_ZONE_LAYOUT,
  TOWN_ZONE_ORDER,
  type Position,
  type TownZoneLayout,
  type TownZoneId,
} from '@cat-house/shared';

export type TownZone = TownZoneLayout & { readonly id: TownZoneId };

export { TOWN_GRID };

export const TOWN_ZONES: readonly TownZone[] = Object.freeze(
  TOWN_ZONE_ORDER.map((id) =>
    Object.freeze({
      id,
      bounds: TOWN_ZONE_LAYOUT[id].bounds,
      entrance: TOWN_ZONE_LAYOUT[id].entrance,
    }),
  ),
);

type Occupancy = { occupiedCells: readonly Position[]; collision: boolean };

const key = ({ x, y }: Position) => `${x}:${y}`;

export class TownNavigation {
  readonly #staticBlocked = new Set(
    TOWN_STATIC_BLOCKED_CELLS.map((position) => key(position)),
  );
  readonly #dynamicBlocked = new Set<string>();

  restoreModifications(modifications: readonly Occupancy[]): void {
    this.#dynamicBlocked.clear();
    for (const modification of modifications) {
      if (!modification.collision) continue;
      for (const cell of modification.occupiedCells) {
        this.#dynamicBlocked.add(key(cell));
      }
    }
  }

  isBlocked(position: Position): boolean {
    return (
      position.x < 0 ||
      position.y < 0 ||
      position.x >= TOWN_GRID.width ||
      position.y >= TOWN_GRID.height ||
      this.#staticBlocked.has(key(position)) ||
      this.#dynamicBlocked.has(key(position))
    );
  }

  findPath(start: Position, target: Position): Position[] {
    if (this.isBlocked(start) || this.isBlocked(target)) return [];
    const queue: Position[] = [start];
    const parents = new Map<string, Position | undefined>([
      [key(start), undefined],
    ]);
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
  return [
    { x: x + 1, y },
    { x: x - 1, y },
    { x, y: y + 1 },
    { x, y: y - 1 },
  ];
}

function reconstruct(
  target: Position,
  parents: ReadonlyMap<string, Position | undefined>,
): Position[] {
  const result: Position[] = [];
  let current: Position | undefined = target;
  while (current !== undefined) {
    result.push(current);
    current = parents.get(key(current));
  }
  return result.reverse();
}
