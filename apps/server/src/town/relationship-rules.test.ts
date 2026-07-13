import { describe, expect, it } from 'vitest';

import { autonomousPlayRelationshipChange } from './relationship-rules.js';

describe('autonomousPlayRelationshipChange', () => {
  it.each([
    [-1, -0.95, 0.05],
    [0, 0.05, 0.05],
    [0.4, 0.45, 0.05],
    [0.98, 1, 0.02],
    [1, 1, 0],
  ])(
    'advances accepted play affinity %s to %s with delta %s',
    (currentAffinity, affinity, delta) => {
      expect(autonomousPlayRelationshipChange(currentAffinity)).toEqual({
        affinity,
        delta,
      });
    },
  );

  it('rounds floating-point inputs to a stable bounded result', () => {
    expect(autonomousPlayRelationshipChange(0.1 + 0.2)).toEqual({
      affinity: 0.35,
      delta: 0.05,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1.01, 1.01])(
    'rejects an out-of-domain current affinity: %s',
    (currentAffinity) => {
      expect(() => autonomousPlayRelationshipChange(currentAffinity)).toThrow(
        /affinity/i,
      );
    },
  );
});
