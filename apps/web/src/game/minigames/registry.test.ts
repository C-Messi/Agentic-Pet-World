import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import type { MiniGameManifest } from '@cat-house/shared';

import {
  MiniGameRegistry,
  type MiniGameSceneController,
  type MiniGameSceneType,
} from './registry';
import { arcadeComingSoonManifest, miniGameRegistry } from './manifests';

class TestScene {}
class FallbackScene {}

function manifest(
  id: string,
  triggerObjectId: 'arcade' | 'window' = 'arcade',
  loadScene = vi.fn(async () => TestScene as MiniGameSceneType),
): MiniGameManifest<{ opened: boolean }, MiniGameSceneType> {
  return {
    id,
    title: 'Test Game',
    triggerObjectId,
    stateSchemaId: `${id}-state-v1`,
    stateSchema: z.object({ opened: z.boolean() }).strict(),
    createInitialState: () => ({ opened: false }),
    loadScene,
  };
}

function controller() {
  const calls: string[] = [];
  const value: MiniGameSceneController = {
    add: (key) => { calls.push(`add:${key}`); },
    sleep: (key) => { calls.push(`sleep:${key}`); },
    launch: (key, data) => { calls.push(`launch:${key}:${data.returnSceneKey}`); },
  };
  return { calls, value };
}

describe('MiniGameRegistry', () => {
  it('registers the arcade placeholder through the manifest registry', () => {
    expect(miniGameRegistry.findByTriggerObject('arcade')).toBe(arcadeComingSoonManifest);
    expect(arcadeComingSoonManifest.id).toBe('arcade-coming-soon');
  });

  it('registers valid manifests, rejects duplicate IDs, and finds games by trigger object', () => {
    const registry = new MiniGameRegistry(manifest('fallback'), 'fallback');
    const arcade = manifest('arcade-coming-soon');

    registry.register(arcade);

    expect(registry.get('arcade-coming-soon')).toBe(arcade);
    expect(registry.findByTriggerObject('arcade')).toBe(arcade);
    expect(() => registry.register(manifest('arcade-coming-soon', 'window'))).toThrow(
      /duplicate mini-game id/i,
    );
  });

  it('rejects duplicate trigger-object ownership without replacing the first manifest', () => {
    const registry = new MiniGameRegistry(manifest('fallback'), 'fallback');
    const first = manifest('first-game', 'arcade');
    registry.register(first);

    expect(() => registry.register(manifest('second-game', 'arcade'))).toThrow(
      /duplicate mini-game trigger object.*arcade/i,
    );
    expect(registry.findByTriggerObject('arcade')).toBe(first);
    expect(registry.get('second-game')).toBeUndefined();
  });

  it('does not load a scene until opening and caches the loader result', async () => {
    const fallback = manifest('fallback');
    const loader = vi.fn(async () => TestScene as MiniGameSceneType);
    const registry = new MiniGameRegistry(fallback, 'fallback');
    registry.register(manifest('arcade-coming-soon', 'arcade', loader));
    const firstController = controller();

    expect(loader).not.toHaveBeenCalled();
    await registry.openByTriggerObject('arcade', firstController.value, 'WorldScene');
    await registry.openByTriggerObject('arcade', firstController.value, 'WorldScene');

    expect(loader).toHaveBeenCalledTimes(1);
    expect(firstController.calls).toEqual([
      'add:arcade-coming-soon',
      'sleep:WorldScene',
      'launch:arcade-coming-soon:WorldScene',
      'sleep:WorldScene',
      'launch:arcade-coming-soon:WorldScene',
    ]);
  });

  it('falls back after a loader rejection and retries the registered game later', async () => {
    const fallbackLoader = vi.fn(async () => FallbackScene as MiniGameSceneType);
    const loader = vi
      .fn<() => Promise<MiniGameSceneType>>()
      .mockRejectedValueOnce(new Error('chunk unavailable'))
      .mockResolvedValueOnce(TestScene as MiniGameSceneType);
    const registry = new MiniGameRegistry(
      manifest('fallback', 'window', fallbackLoader),
      'fallback',
    );
    registry.register(manifest('arcade-game', 'arcade', loader));
    const sceneController = controller();

    await expect(
      registry.openByTriggerObject('arcade', sceneController.value, 'WorldScene'),
    ).resolves.toBe(true);
    await expect(
      registry.openByTriggerObject('arcade', sceneController.value, 'WorldScene'),
    ).resolves.toBe(true);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(fallbackLoader).toHaveBeenCalledTimes(1);
    expect(sceneController.calls.filter((call) => call.startsWith('launch:'))).toEqual([
      'launch:fallback:WorldScene',
      'launch:arcade-game:WorldScene',
    ]);
  });

  it('opens the safe fallback for an explicit unknown game ID', async () => {
    const fallbackLoader = vi.fn(async () => FallbackScene as MiniGameSceneType);
    const registry = new MiniGameRegistry(manifest('fallback', 'window', fallbackLoader), 'fallback');
    const sceneController = controller();

    await registry.open('missing-game', sceneController.value, 'WorldScene');

    expect(fallbackLoader).toHaveBeenCalledTimes(1);
    expect(sceneController.calls).toContain('launch:fallback:WorldScene');
  });

  it('declines an unregistered trigger without loading or launching the fallback', async () => {
    const fallbackLoader = vi.fn(async () => FallbackScene as MiniGameSceneType);
    const registry = new MiniGameRegistry(manifest('fallback', 'arcade', fallbackLoader), 'fallback');
    const sceneController = controller();

    await expect(
      registry.openByTriggerObject('window', sceneController.value, 'WorldScene'),
    ).resolves.toBe(false);

    expect(fallbackLoader).not.toHaveBeenCalled();
    expect(sceneController.calls).toEqual([]);
  });

  it('validates factory state before launching and honors cancellation', async () => {
    const registry = new MiniGameRegistry(manifest('fallback'), 'fallback');
    const sceneController = controller();

    expect(() =>
      registry.register({
        ...manifest('broken'),
        createInitialState: () => ({ opened: 'no' }) as unknown as { opened: boolean },
      }),
    ).toThrow(/initial state/i);
    expect(sceneController.calls).toEqual([]);

    const abort = new AbortController();
    abort.abort();
    await expect(
      registry.open('fallback', sceneController.value, 'WorldScene', abort.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sceneController.calls).toEqual([]);
  });
});
