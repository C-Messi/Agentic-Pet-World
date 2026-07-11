import type { WorldSnapshot } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import type { WorldScene } from '../scenes/world-scene';
import { ActionExecutionError } from './action-runner';
import { WorldSceneActionAdapter } from './world-scene-action-adapter';

const snapshot: WorldSnapshot = {
  cat: { position: { x: 1, y: 1 }, emotion: 'idle' },
  objects: [],
};

describe('WorldSceneActionAdapter', () => {
  it('maps all five action methods and ambient state to WorldScene', async () => {
    const scene = {
      hasActionTarget: vi.fn(() => true),
      setAgentBusy: vi.fn(),
      moveToActionTarget: vi.fn(async () => undefined),
      interactWithActionTarget: vi.fn(async () => undefined),
      emoteForAction: vi.fn(async () => undefined),
      waitForAction: vi.fn(async () => undefined),
      speakForAction: vi.fn(async () => undefined),
      getSnapshot: vi.fn(() => snapshot),
    } as unknown as WorldScene;
    const adapter = new WorldSceneActionAdapter(scene);
    const signal = new AbortController().signal;

    expect(adapter.hasTarget('window')).toBe(true);
    adapter.setAmbientSuspended(true);
    await adapter.moveTo('window', signal);
    await adapter.interact('window', 'inspect', signal);
    await adapter.emote('happy', 100, signal);
    await adapter.wait(100, signal);
    await adapter.speak('Hello.', signal);

    expect(scene.setAgentBusy).toHaveBeenCalledWith(true);
    expect(scene.moveToActionTarget).toHaveBeenCalledWith('window', signal);
    expect(scene.interactWithActionTarget).toHaveBeenCalledWith('window', 'inspect', signal);
    expect(scene.emoteForAction).toHaveBeenCalledWith('happy', 100, signal);
    expect(scene.waitForAction).toHaveBeenCalledWith(100, signal);
    expect(scene.speakForAction).toHaveBeenCalledWith('Hello.', signal);
    expect(adapter.getSnapshot()).toBe(snapshot);
  });

  it.each([
    ['moveTo', 'MOVEMENT_FAILED'],
    ['interact', 'INTERACTION_FAILED'],
    ['emote', 'EMOTE_FAILED'],
    ['wait', 'WAIT_FAILED'],
    ['speak', 'SPEAK_FAILED'],
  ] as const)('maps %s scene failures to a stable action error', async (method, errorCode) => {
    const fail = vi.fn(async () => { throw new Error('scene failed'); });
    const scene = {
      moveToActionTarget: fail,
      interactWithActionTarget: fail,
      emoteForAction: fail,
      waitForAction: fail,
      speakForAction: fail,
    } as unknown as WorldScene;
    const adapter = new WorldSceneActionAdapter(scene);
    const signal = new AbortController().signal;

    let error: unknown;
    try {
      await invoke(adapter, method, signal);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ActionExecutionError);
    expect(error).toMatchObject({ code: errorCode, message: 'scene failed' });
  });
});

function invoke(
  adapter: WorldSceneActionAdapter,
  method: 'moveTo' | 'interact' | 'emote' | 'wait' | 'speak',
  signal: AbortSignal,
): Promise<void> {
  switch (method) {
    case 'moveTo':
      return adapter.moveTo('window', signal);
    case 'interact':
      return adapter.interact('window', 'inspect', signal);
    case 'emote':
      return adapter.emote('happy', 100, signal);
    case 'wait':
      return adapter.wait(100, signal);
    case 'speak':
      return adapter.speak('Hello.', signal);
  }
}
