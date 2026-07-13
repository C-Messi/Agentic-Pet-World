import { describe, expect, it, vi } from 'vitest';

import { TownApiClient } from './town-api-client';

const projection = {
  sessionId: 'session-1',
  version: 0,
  lastEventSequence: 0,
  relationships: [],
  modifications: [],
  activities: [],
  residents: [
    {
      residentId: 'resident-1',
      position: { x: 1, y: 1 },
      zoneId: 'plaza',
      availability: 'available',
      pet: {
        schemaVersion: 'pet-definition.v1',
        id: 'resident-1',
        displayName: 'Sunny',
        source: 'player-pet',
        species: 'cat',
        spriteId: 'player-cat',
        palette: {
          primary: '#112233',
          secondary: '#445566',
          accent: '#778899',
        },
        personality: {
          curiosity: 0.5,
          sociability: 0.5,
          playfulness: 0.5,
          creativity: 0.5,
        },
        voice: { style: 'warm', catchphrases: [] },
        interests: [],
        publicBio: 'Town explorer',
      },
    },
  ],
} as const;

describe('TownApiClient', () => {
  it('strictly parses town responses', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ sessionId: 'session-1', items: [], extra: true }),
          { status: 200 },
        ),
    );
    const client = new TownApiClient({ fetcher });

    await expect(client.listShowcase('session-1')).rejects.toThrow();
  });

  it('passes abort signals to requests', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessionId: 'session-1', items: [] }), {
          status: 200,
        }),
    );
    const client = new TownApiClient({ fetcher });
    const controller = new AbortController();

    await client.listShowcase('session-1', controller.signal);

    expect(fetcher).toHaveBeenCalledWith(
      '/api/sessions/session-1/town/showcase',
      { signal: controller.signal },
    );
  });

  it('posts strict pulse bodies and forwards the abort signal', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'stale',
            projection,
            events: [],
            degraded: false,
            degradedResidentIds: [],
          }),
          { status: 200 },
        ),
    );
    const client = new TownApiClient({ fetcher });
    const controller = new AbortController();

    await client.pulse(
      { sessionId: 'session-1', baseVersion: 0, pulseId: 'pulse-1' },
      controller.signal,
    );

    expect(fetcher).toHaveBeenCalledWith('/api/sessions/session-1/town/pulse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseVersion: 0, pulseId: 'pulse-1' }),
      signal: controller.signal,
    });
  });

  it('strictly parses pulse responses', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: 'stale',
            projection,
            events: [],
            degraded: false,
            degradedResidentIds: [],
            extra: true,
          }),
          { status: 200 },
        ),
    );
    const client = new TownApiClient({ fetcher });

    await expect(
      client.pulse({
        sessionId: 'session-1',
        baseVersion: 0,
        pulseId: 'pulse-1',
      }),
    ).rejects.toThrow();
  });

  it('retries event result delivery after a transient failure', async () => {
    const accepted = { projection: undefined, acceptedEventIds: [] };
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(accepted), { status: 200 }),
      );
    const client = new TownApiClient({ fetcher, resultRetryCount: 1 });

    await expect(
      client.deliverEventResults({
        sessionId: 'session-1',
        baseVersion: 0,
        results: [{ eventId: 'event-1', status: 'applied' }],
      }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
