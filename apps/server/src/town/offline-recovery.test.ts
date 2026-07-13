import {
  TownEventSchema,
  TownProjectionSchema,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  OfflineRecoveryConflictError,
  OfflineRecoveryService,
  type OfflineRecoveryResult,
} from './offline-recovery.js';

function pet(id: string, source: 'player-pet' | 'resident') {
  return {
    schemaVersion: 'pet-definition.v1' as const,
    id: `${id}-pet`,
    displayName: id,
    source,
    species: 'cat',
    spriteId: id,
    palette: {
      primary: '#112233' as const,
      secondary: '#445566' as const,
      accent: '#778899' as const,
    },
    personality: {
      curiosity: 0.5,
      sociability: 0.5,
      playfulness: 0.5,
      creativity: 0.5,
    },
    voice: { style: 'Plain', catchphrases: [] },
    interests: [],
    publicBio: 'A town cat.',
  };
}
function projection(): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1',
    version: 2,
    lastEventSequence: 4,
    residents: [
      {
        residentId: 'player',
        pet: pet('player', 'player-pet'),
        position: { x: 0, y: 0 },
        zoneId: 'plaza',
        availability: 'available',
      },
      {
        residentId: 'friend',
        pet: pet('friend', 'resident'),
        position: { x: 1, y: 0 },
        zoneId: 'plaza',
        availability: 'available',
      },
    ],
    relationships: [],
    modifications: [],
    activities: [],
  });
}
function harness(
  intents: TownIntent[] = [
    { type: 'visit-zone', actorId: 'player', zoneId: 'garden' },
  ],
) {
  let calls = 0;
  let stored: OfflineRecoveryResult | undefined;
  let claimedBasis: unknown;
  let claimed = false;
  const simulation = {
    candidates: () => intents,
    select: () => intents[calls % intents.length],
    createEvents: (state: Readonly<TownProjection>, intent: TownIntent) => {
      calls++;
      if (intent.type === 'build')
        return [
          TownEventSchema.parse({
            id: `event-${calls}`,
            sessionId: state.sessionId,
            sequence: state.lastEventSequence + 1,
            baseVersion: state.version,
            type: 'build.completed',
            zoneId: 'build-plots',
            participantIds: ['player'],
            timestamp: `2026-07-13T00:0${calls}:00.000Z`,
            payload: {
              modification: {
                id: `mod-${calls}`,
                recipeId: 'lamp',
                plotId: `plot-${calls}`,
                occupiedCells: [{ x: calls, y: 0 }],
                atlasFrame: 1,
                collision: false,
              },
            },
          }),
        ];
      return [
        TownEventSchema.parse({
          id: `event-${calls}`,
          sessionId: state.sessionId,
          sequence: state.lastEventSequence + 1,
          baseVersion: state.version,
          type: 'resident.moved',
          zoneId: intent.type === 'visit-zone' ? intent.zoneId : 'garden',
          participantIds: ['player'],
          timestamp: `2026-07-13T00:0${calls}:00.000Z`,
          payload: { residentId: 'player', position: { x: calls, y: 0 } },
        }),
      ];
    },
  };
  const store = {
    claimRecoveryWindow: (
      _sessionId: string,
      _windowId: string,
      basis: unknown,
    ) => {
      claimedBasis = basis;
      if (claimed) return { claimed: false };
      claimed = true;
      return { claimed: true };
    },
    loadRecoveryResult: () => stored,
    saveRecoveryResult: (
      _s: string,
      _w: string,
      value: OfflineRecoveryResult,
    ) => {
      stored = value;
    },
  };
  return {
    service: new OfflineRecoveryService(simulation, store),
    get calls() {
      return calls;
    },
    get stored() {
      return stored;
    },
    get claimedBasis() {
      return claimedBasis;
    },
  };
}
function input(minutes: number) {
  return {
    sessionId: 'session-1',
    recoveryWindowId: 'window-1',
    lastConfirmedAt: '2026-07-13T00:00:00.000Z',
    resumedAt: new Date(
      Date.parse('2026-07-13T00:00:00.000Z') + minutes * 60_000,
    ).toISOString(),
    projection: projection(),
  };
}

describe('OfflineRecoveryService', () => {
  it('uses the five-minute threshold and thirty-minute slot budget', () => {
    expect(harness().service.recover(input(4)).events).toHaveLength(0);
    expect(harness().service.recover(input(30)).events).toHaveLength(1);
    expect(harness().service.recover(input(400)).events).toHaveLength(5);
  });
  it('keeps a contiguous chronological chain and does not mutate frozen input', () => {
    const value = input(90);
    Object.freeze(value.projection);
    Object.freeze(value);
    const result = harness().service.recover(value);
    expect(
      result.events.map((event) => [event.baseVersion, event.sequence]),
    ).toEqual([
      [2, 5],
      [3, 6],
      [4, 7],
    ]);
    expect(result.events.map((event) => event.timestamp)).toEqual(
      [...result.events.map((event) => event.timestamp)].sort(),
    );
    expect(result.finalProjection.version).toBe(5);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('allows at most one build/world modification', () => {
    const h = harness([
      { type: 'build', actorId: 'player', recipeId: 'lamp', plotId: 'plot-1' },
    ]);
    const result = h.service.recover(input(400));
    expect(
      result.events.filter((event) => event.type === 'build.completed').length,
    ).toBeLessThanOrEqual(1);
    expect(result.finalProjection.modifications.length).toBeLessThanOrEqual(1);
  });
  it('never selects an open stall backed by private data', () => {
    const h = harness([
      {
        type: 'open-stall',
        actorId: 'player',
        stallId: 'stall-1',
        showcaseItemIds: ['private-item'],
      },
    ]);
    expect(h.service.recover(input(60)).events).toEqual([]);
    expect(h.calls).toBe(0);
  });
  it('treats an invalid selected intent as a bounded failed attempt', () => {
    const valid: TownIntent = {
      type: 'visit-zone',
      actorId: 'player',
      zoneId: 'garden',
    };
    const invalid: TownIntent = {
      type: 'open-stall',
      actorId: 'player',
      stallId: 'stall-1',
      showcaseItemIds: ['private-item'],
    };
    let generated = 0;
    const service = new OfflineRecoveryService(
      {
        candidates: () => [valid, invalid],
        select: () => invalid,
        createEvents: () => {
          generated++;
          return [];
        },
      },
      {
        claimRecoveryWindow: () => ({ claimed: true }),
        loadRecoveryResult: () => undefined,
        saveRecoveryResult: () => undefined,
      },
    );
    expect(service.recover(input(30)).events).toEqual([]);
    expect(generated).toBe(0);
  });
  it('rejects generated events outside the recovery time window', () => {
    const valid: TownIntent = {
      type: 'visit-zone',
      actorId: 'player',
      zoneId: 'garden',
    };
    const service = new OfflineRecoveryService(
      {
        candidates: () => [valid],
        select: () => valid,
        createEvents: (state) => [
          TownEventSchema.parse({
            id: 'late-event',
            sessionId: state.sessionId,
            sequence: state.lastEventSequence + 1,
            baseVersion: state.version,
            type: 'resident.moved',
            zoneId: 'garden',
            participantIds: ['player'],
            timestamp: '2026-07-13T01:00:00.000Z',
            payload: { residentId: 'player', position: { x: 1, y: 0 } },
          }),
        ],
      },
      {
        claimRecoveryWindow: () => ({ claimed: true }),
        loadRecoveryResult: () => undefined,
        saveRecoveryResult: () => undefined,
      },
    );
    expect(service.recover(input(30)).events).toEqual([]);
  });
  it('returns a persisted duplicate without a second simulation and surfaces claim conflict', () => {
    const h = harness();
    const first = h.service.recover(input(30));
    const calls = h.calls;
    expect(h.service.recover(input(30))).toEqual(first);
    expect(h.calls).toBe(calls);
    const conflictStore = {
      claimRecoveryWindow: () => {
        throw new Error('Town outing recovery conflict');
      },
      loadRecoveryResult: () => undefined,
      saveRecoveryResult: () => undefined,
    };
    expect(() =>
      new OfflineRecoveryService(
        {
          candidates: () => [],
          select: () => undefined,
          createEvents: () => [],
        },
        conflictStore,
      ).recover(input(30)),
    ).toThrow(OfflineRecoveryConflictError);
  });
  it('validates before claiming', () => {
    const h = harness();
    expect(() =>
      h.service.recover({ ...input(30), resumedAt: 'bad' }),
    ).toThrow();
    expect(h.claimedBasis).toBeUndefined();
  });
});
