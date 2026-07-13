import { describe, expect, it, vi } from 'vitest';

import { TownApiClient } from './town-api-client';

describe('TownApiClient', () => {
  it('strictly parses town responses', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sessionId: 'session-1', items: [], extra: true }), { status: 200 }));
    const client = new TownApiClient({ fetcher });

    await expect(client.listShowcase('session-1')).rejects.toThrow();
  });

  it('passes abort signals to requests', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sessionId: 'session-1', items: [] }), { status: 200 }));
    const client = new TownApiClient({ fetcher });
    const controller = new AbortController();

    await client.listShowcase('session-1', controller.signal);

    expect(fetcher).toHaveBeenCalledWith('/api/sessions/session-1/town/showcase', { signal: controller.signal });
  });

  it('retries event result delivery after a transient failure', async () => {
    const accepted = { projection: undefined, acceptedEventIds: [] };
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(JSON.stringify(accepted), { status: 200 }));
    const client = new TownApiClient({ fetcher, resultRetryCount: 1 });

    await expect(client.deliverEventResults({
      sessionId: 'session-1',
      baseVersion: 0,
      results: [{ eventId: 'event-1', status: 'applied' }],
    })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
