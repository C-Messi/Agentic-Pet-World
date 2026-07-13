import type { TownEvent, TownProjection } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { TownPlaybackCoordinator } from './town-playback-coordinator';

describe('TownPlaybackCoordinator', () => {
  it('delivers applied event results after successful playback', async () => {
    const play = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const coordinator = new TownPlaybackCoordinator({ play }, { deliverEventResults: deliver });
    const events = [{ id: 'event-1' }, { id: 'event-2' }] as TownEvent[];

    await coordinator.playAndConfirm('session-1', events, { version: 4 } as TownProjection);

    expect(play).toHaveBeenCalledWith(events, expect.objectContaining({ version: 4 }));
    expect(deliver).toHaveBeenCalledWith({ sessionId: 'session-1', baseVersion: 4, results: [
      { eventId: 'event-1', status: 'applied' },
      { eventId: 'event-2', status: 'applied' },
    ] });
  });

  it('delivers failed event results and rethrows playback errors', async () => {
    const play = vi.fn(async () => { throw new Error('sprite missing'); });
    const deliver = vi.fn(async () => undefined);
    const coordinator = new TownPlaybackCoordinator({ play }, { deliverEventResults: deliver });
    const events = [{ id: 'event-1' }] as TownEvent[];

    await expect(coordinator.playAndConfirm('session-1', events, { version: 2 } as TownProjection)).rejects.toThrow('sprite missing');
    expect(deliver).toHaveBeenCalledWith({ sessionId: 'session-1', baseVersion: 2, results: [{ eventId: 'event-1', status: 'failed', message: 'sprite missing' }] });
  });
});
