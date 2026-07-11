import { describe, expect, it } from 'vitest';

import { bottomDepthFromCenter, bottomDepthFromTopLeft } from './render-depth';

describe('display bottom depth', () => {
  it('normalizes furniture depth after nearest-neighbor display scaling', () => {
    expect(bottomDepthFromTopLeft(48 * 2, 64 * 2)).toBe(224);
  });

  it('moves the cat behind or in front exactly at a furniture bottom edge', () => {
    const furnitureDepth = bottomDepthFromTopLeft(48 * 2, 64 * 2);

    expect(bottomDepthFromCenter(191, 64)).toBeLessThan(furnitureDepth);
    expect(bottomDepthFromCenter(192, 64)).toBe(furnitureDepth);
    expect(bottomDepthFromCenter(193, 64)).toBeGreaterThan(furnitureDepth);
  });
});
