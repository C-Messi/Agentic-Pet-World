import { describe, expect, it } from 'vitest';

import { sharedPackageName } from './index.js';

describe('shared package bootstrap', () => {
  it('exposes the workspace package identity', () => {
    expect(sharedPackageName).toBe('@cat-house/shared');
  });
});
