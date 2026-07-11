import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  openMiniGameInteraction,
  type MiniGameInteractionLauncher,
} from './open-interaction';
import type { MiniGameSceneController } from './registry';

describe('open mini-game interaction', () => {
  it('keeps concrete mini-game scene and manifest IDs out of WorldScene', () => {
    const source = readFileSync('src/game/scenes/world-scene.ts', 'utf8');

    expect(source).toContain('openMiniGameInteraction');
    expect(source).not.toContain('arcade-coming-soon');
    expect(source).not.toContain('ComingSoonScene');
  });

  it('delegates by trigger object without mutating world or session state', async () => {
    const launcher: MiniGameInteractionLauncher = {
      hasTriggerObject: vi.fn(() => true),
      openByTriggerObject: vi.fn(async () => true),
    };
    const worldSnapshot = Object.freeze({ cat: Object.freeze({ emotion: 'idle' }) });
    const session = Object.freeze({ id: 'session-1' });
    const before = JSON.stringify({ worldSnapshot, session });
    const controller = {} as MiniGameSceneController;
    const signal = new AbortController().signal;

    await expect(openMiniGameInteraction(
      launcher,
      'arcade',
      controller,
      'WorldScene',
      signal,
    )).resolves.toBe(true);

    expect(launcher.openByTriggerObject).toHaveBeenCalledWith(
      'arcade',
      controller,
      'WorldScene',
      signal,
    );
    expect(JSON.stringify({ worldSnapshot, session })).toBe(before);
  });

  it('leaves window open on the ordinary world interaction path', async () => {
    const launcher: MiniGameInteractionLauncher = {
      hasTriggerObject: vi.fn(() => false),
      openByTriggerObject: vi.fn(async () => true),
    };
    const controller = {} as MiniGameSceneController;

    await expect(
      openMiniGameInteraction(launcher, 'window', controller, 'WorldScene'),
    ).resolves.toBe(false);

    expect(launcher.hasTriggerObject).toHaveBeenCalledWith('window');
    expect(launcher.openByTriggerObject).not.toHaveBeenCalled();
  });
});
