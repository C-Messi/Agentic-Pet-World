import { createHash } from 'node:crypto';

import { WorldSnapshotSchema, type WorldSnapshot } from '@cat-house/shared';

export function canonicalizeWorldSnapshot(snapshot: WorldSnapshot): WorldSnapshot {
  const world = WorldSnapshotSchema.parse(snapshot);
  return {
    cat: {
      position: { x: world.cat.position.x, y: world.cat.position.y },
      emotion: world.cat.emotion,
      ...(world.cat.currentTargetId === undefined
        ? {}
        : { currentTargetId: world.cat.currentTargetId }),
    },
    objects: [...world.objects]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((object) => ({
        id: object.id,
        position: { x: object.position.x, y: object.position.y },
        available: object.available,
        interactions: [...object.interactions].sort(),
      })),
  };
}

export function worldSnapshotHash(snapshot: WorldSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeWorldSnapshot(snapshot)))
    .digest('hex');
}
