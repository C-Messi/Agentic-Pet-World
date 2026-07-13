import type { TownEvent, TownProjection } from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import { TownPlaybackCoordinator } from './town-playback-coordinator';

describe('TownPlaybackCoordinator', () => {
  it('delivers applied event results after successful playback', async () => {
    const play = vi.fn(async () => undefined);
    const deliver = vi.fn(async () => undefined);
    const coordinator = new TownPlaybackCoordinator(
      { play },
      { deliverEventResults: deliver },
    );
    const events = [{ id: 'event-1' }, { id: 'event-2' }] as TownEvent[];

    const controller = new AbortController();
    await coordinator.playAndConfirm(
      'session-1',
      events,
      { version: 4 } as TownProjection,
      controller.signal,
    );

    expect(play).toHaveBeenCalledWith(
      events,
      expect.objectContaining({ version: 4 }),
      controller.signal,
    );
    expect(deliver).toHaveBeenCalledWith({
      sessionId: 'session-1',
      baseVersion: 4,
      results: [
        { eventId: 'event-1', status: 'applied' },
        { eventId: 'event-2', status: 'applied' },
      ],
    });
  });

  it('delivers failed event results and rethrows playback errors', async () => {
    const play = vi.fn(async () => {
      throw new Error('sprite missing');
    });
    const deliver = vi.fn(async () => undefined);
    const coordinator = new TownPlaybackCoordinator(
      { play },
      { deliverEventResults: deliver },
    );
    const events = [{ id: 'event-1' }] as TownEvent[];

    await expect(
      coordinator.playAndConfirm('session-1', events, {
        version: 2,
      } as TownProjection),
    ).rejects.toThrow('sprite missing');
    expect(deliver).toHaveBeenCalledWith({
      sessionId: 'session-1',
      baseVersion: 2,
      results: [
        { eventId: 'event-1', status: 'failed', message: 'sprite missing' },
      ],
    });
  });

  it('does not acknowledge intentionally aborted playback as failed', async () => {
    const play = vi.fn(async () => {
      throw new DOMException('Playback cancelled', 'AbortError');
    });
    const deliver = vi.fn(async () => undefined);
    const coordinator = new TownPlaybackCoordinator(
      { play },
      { deliverEventResults: deliver },
    );
    const events = [{ id: 'event-1' }] as TownEvent[];

    await expect(
      coordinator.playAndConfirm(
        'session-1',
        events,
        { version: 2 } as TownProjection,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(deliver).not.toHaveBeenCalled();
  });
});
