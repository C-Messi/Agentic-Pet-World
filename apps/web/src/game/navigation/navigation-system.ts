import type { GridPoint } from '../world/object-registry';

export interface NavigationGrid {
  width: number;
  height: number;
  blocked?: readonly GridPoint[];
}

const keyOf = ({ x, y }: GridPoint) => `${x},${y}`;
const distance = (a: GridPoint, b: GridPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export class NavigationSystem {
  readonly width: number;
  readonly height: number;
  private readonly blocked: Set<string>;
  private readonly reservations = new Map<string, string>();

  constructor(grid: NavigationGrid) {
    this.width = grid.width;
    this.height = grid.height;
    this.blocked = new Set((grid.blocked ?? []).map(keyOf));
  }

  reserve(tile: GridPoint, owner: string): boolean {
    if (!this.inBounds(tile) || this.blocked.has(keyOf(tile))) return false;
    const currentOwner = this.reservations.get(keyOf(tile));
    if (currentOwner && currentOwner !== owner) return false;
    this.reservations.set(keyOf(tile), owner);
    return true;
  }

  release(owner: string): void {
    for (const [tile, reservationOwner] of this.reservations) {
      if (reservationOwner === owner) this.reservations.delete(tile);
    }
  }

  isWalkable(tile: GridPoint, owner?: string): boolean {
    if (!this.inBounds(tile) || this.blocked.has(keyOf(tile))) return false;
    const reservationOwner = this.reservations.get(keyOf(tile));
    return !reservationOwner || reservationOwner === owner;
  }

  findPath(start: GridPoint, goal: GridPoint, owner?: string): GridPoint[] {
    if (!this.isWalkable(start, owner) || !this.isWalkable(goal, owner)) return [];
    const startKey = keyOf(start);
    const goalKey = keyOf(goal);
    const open = new Map<string, { point: GridPoint; score: number }>([
      [startKey, { point: start, score: distance(start, goal) }],
    ]);
    const cameFrom = new Map<string, string>();
    const points = new Map<string, GridPoint>([[startKey, start]]);
    const cost = new Map<string, number>([[startKey, 0]]);

    while (open.size > 0) {
      const currentEntry = [...open.entries()].sort(
        ([keyA, a], [keyB, b]) => a.score - b.score || keyA.localeCompare(keyB),
      )[0];
      if (!currentEntry) break;
      const [currentKey, { point: current }] = currentEntry;
      open.delete(currentKey);

      if (currentKey === goalKey) return this.reconstruct(cameFrom, points, goalKey);

      const neighbors = [
        { x: current.x, y: current.y - 1 },
        { x: current.x - 1, y: current.y },
        { x: current.x + 1, y: current.y },
        { x: current.x, y: current.y + 1 },
      ];
      for (const neighbor of neighbors) {
        if (!this.isWalkable(neighbor, owner)) continue;
        const neighborKey = keyOf(neighbor);
        const nextCost = (cost.get(currentKey) ?? Number.POSITIVE_INFINITY) + 1;
        if (nextCost >= (cost.get(neighborKey) ?? Number.POSITIVE_INFINITY)) continue;
        cameFrom.set(neighborKey, currentKey);
        points.set(neighborKey, neighbor);
        cost.set(neighborKey, nextCost);
        open.set(neighborKey, { point: neighbor, score: nextCost + distance(neighbor, goal) });
      }
    }
    return [];
  }

  private inBounds({ x, y }: GridPoint): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private reconstruct(
    cameFrom: ReadonlyMap<string, string>,
    points: ReadonlyMap<string, GridPoint>,
    goalKey: string,
  ): GridPoint[] {
    const path: GridPoint[] = [];
    let currentKey: string | undefined = goalKey;
    while (currentKey) {
      const point = points.get(currentKey);
      if (!point) break;
      path.push(point);
      currentKey = cameFrom.get(currentKey);
    }
    return path.reverse();
  }
}
