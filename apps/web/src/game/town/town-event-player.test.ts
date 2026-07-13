import type { TownEvent, TownProjection } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { TownEventPlayer, type TownScenePort } from './town-event-player';

const projection: TownProjection = {
  sessionId: 'session-1', version: 2, lastEventSequence: 2, relationships: [], modifications: [], activities: [],
  residents: [{
    residentId: 'resident-1', position: { x: 1, y: 1 }, zoneId: 'plaza', availability: 'available',
    pet: { schemaVersion: 'pet-definition.v1', id: 'resident-1', displayName: 'Sunny', source: 'player-pet', species: 'cat', spriteId: 'player-cat', palette: { primary: '#112233', secondary: '#445566', accent: '#778899' }, personality: { curiosity: .5, sociability: .5, playfulness: .5, creativity: .5 }, voice: { style: 'warm', catchphrases: [] }, interests: [], publicBio: 'Town explorer' },
  }],
};
const event = (id: string, sequence: number, type: 'resident.spoke' | 'resident.moved' = 'resident.spoke'): TownEvent => ({
  id, sessionId: 'session-1', sequence, baseVersion: sequence - 1, type,
  participantIds: ['resident-1'], timestamp: '2026-07-13T00:00:00.000Z', zoneId: 'plaza',
  payload: type === 'resident.spoke' ? { residentId: 'resident-1', text: id } : { residentId: 'resident-1', position: { x: sequence, y: 1 } },
} as TownEvent);

function scene(overrides: Partial<TownScenePort> = {}): TownScenePort {
  return {
    applySnapshot: vi.fn(), moveResident: vi.fn().mockResolvedValue(undefined),
    speak: vi.fn().mockResolvedValue(undefined), playActivity: vi.fn().mockResolvedValue(undefined),
    applyModification: vi.fn().mockResolvedValue(undefined), followResident: vi.fn(), ...overrides,
  };
}

describe('TownEventPlayer', () => {
  it('plays events in sequence and suppresses duplicate IDs', async () => {
    const order: string[] = [];
    const port = scene({
      speak: vi.fn(async (_id, text) => { order.push(text); }),
      moveResident: vi.fn(async () => { order.push('moved'); }),
    });
    const player = new TownEventPlayer(port);

    await player.play([event('second', 2), event('first', 1), event('first', 1)], projection);
    await player.play([event('first', 1)], projection);

    expect(order).toEqual(['first', 'second']);
  });

  it('cancels active playback', async () => {
    let signal: AbortSignal | undefined;
    const port = scene({ speak: vi.fn((_id, _text, value) => { signal = value; return new Promise<void>(() => undefined); }) });
    const player = new TownEventPlayer(port);
    const pending = player.play([event('speech', 1)], projection);
    player.cancel();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal?.aborted).toBe(true);
  });

  it('restores the authoritative snapshot and reports playback failure', async () => {
    const port = scene({ speak: vi.fn().mockRejectedValue(new Error('sprite missing')) });
    const failures: string[] = [];
    const player = new TownEventPlayer(port, { onFailure: (_event, error) => failures.push(error.message) });

    await expect(player.play([event('speech', 1)], projection)).rejects.toThrow('sprite missing');
    expect(port.applySnapshot).toHaveBeenCalledWith(projection);
    expect(failures).toEqual(['sprite missing']);
  });
});
