import { describe, expect, it, vi } from 'vitest';

import { returnToWorld, type ReturnSceneController } from './scene-lifecycle';

describe('ComingSoonScene lifecycle', () => {
  it('returns to the sleeping world without mutating session or world snapshots', () => {
    const worldSnapshot = Object.freeze({ cat: Object.freeze({ emotion: 'idle' }) });
    const session = Object.freeze({ id: 'session-1' });
    const before = JSON.stringify({ worldSnapshot, session });
    const controller: ReturnSceneController = {
      stop: vi.fn(),
      wake: vi.fn(),
    };

    returnToWorld(controller, 'WorldScene', 'arcade-coming-soon');

    expect(controller.stop).toHaveBeenCalledWith('arcade-coming-soon');
    expect(controller.wake).toHaveBeenCalledWith('WorldScene');
    expect(JSON.stringify({ worldSnapshot, session })).toBe(before);
  });
});
