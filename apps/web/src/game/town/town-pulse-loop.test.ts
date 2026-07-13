import type {
  TownEvent,
  TownProjection,
  TownPulseRequest,
  TownPulseResponse,
} from '@cat-house/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TownPulseLoop } from './town-pulse-loop';

const event = { id: 'event-1' } as TownEvent;

function projection(version: number): TownProjection {
  return { sessionId: 'session-1', version } as TownProjection;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('TownPulseLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never overlaps pulses and waits for playback before publishing and scheduling', async () => {
    const pulseResult = deferred<TownPulseResponse>();
    const playback = deferred<void>();
    const pulse = vi.fn((...args: [TownPulseRequest, AbortSignal]) => {
      void args;
      return pulseResult.promise;
    });
    const playAndConfirm = vi.fn(() => playback.promise);
    const publish = vi.fn();
    const loop = new TownPulseLoop({ pulse }, { playAndConfirm }, publish);

    loop.start(() => projection(0));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pulse).toHaveBeenCalledTimes(1);
    expect(pulse.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'session-1',
      baseVersion: 0,
      pulseId: expect.stringMatching(/^pulse-1-/),
    });

    await vi.advanceTimersByTimeAsync(40_000);
    expect(pulse).toHaveBeenCalledTimes(1);
    pulseResult.resolve({
      status: 'advanced',
      projection: projection(1),
      events: [event],
      degraded: false,
      degradedResidentIds: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(playAndConfirm).toHaveBeenCalledWith(
      'session-1',
      [event],
      projection(1),
      expect.any(AbortSignal),
    );
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40_000);
    expect(pulse).toHaveBeenCalledTimes(1);
    playback.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledWith(projection(1));
    await vi.advanceTimersByTimeAsync(3_999);
    expect(pulse).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pulse).toHaveBeenCalledTimes(2);
  });

  it('publishes an authoritative stale projection and continues after errors', async () => {
    const pulse = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce({
        status: 'stale',
        projection: projection(3),
        events: [],
        degraded: false,
        degradedResidentIds: [],
      } satisfies TownPulseResponse);
    const playAndConfirm = vi.fn(async () => undefined);
    const publish = vi.fn();
    const loop = new TownPulseLoop({ pulse }, { playAndConfirm }, publish);

    loop.start(() => projection(2));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(publish).toHaveBeenCalledWith(projection(3));
    expect(playAndConfirm).not.toHaveBeenCalled();
  });

  it('aborts active work and ignores late results after stop', async () => {
    const result = deferred<TownPulseResponse>();
    let signal: AbortSignal | undefined;
    const pulse = vi.fn((_request, value: AbortSignal) => {
      signal = value;
      return result.promise;
    });
    const publish = vi.fn();
    const loop = new TownPulseLoop(
      { pulse },
      { playAndConfirm: vi.fn(async () => undefined) },
      publish,
    );

    loop.start(() => projection(0));
    await vi.advanceTimersByTimeAsync(4_000);
    loop.stop();

    expect(signal?.aborted).toBe(true);
    result.resolve({
      status: 'stale',
      projection: projection(1),
      events: [],
      degraded: false,
      degradedResidentIds: [],
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(publish).not.toHaveBeenCalled();
    expect(pulse).toHaveBeenCalledTimes(1);
  });
});
