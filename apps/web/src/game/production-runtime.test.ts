import type { TownProjection, TownSnapshotResponse } from '@cat-house/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bridge: {
    createSession: vi.fn(),
    loadSession: vi.fn(),
    sendPlayerMessage: vi.fn(),
    cancel: vi.fn(),
  },
  agentApi: {},
  townApi: {
    snapshot: vi.fn(),
    release: vi.fn(),
    recall: vi.fn(),
    recover: vi.fn(),
    history: vi.fn(),
  },
  sceneStart: vi.fn(),
  sceneStop: vi.fn(),
  sceneIsActive: vi.fn(),
  gameDestroy: vi.fn(),
  applySnapshot: vi.fn(),
  pulseStart: vi.fn(),
  pulseStop: vi.fn(),
}));

vi.mock('./create-game', () => ({
  createGame: () => ({
    scene: {
      start: mocks.sceneStart,
      stop: mocks.sceneStop,
      isActive: mocks.sceneIsActive,
      getScene: () => ({
        applySnapshot: mocks.applySnapshot,
        followResident: vi.fn(),
      }),
    },
    sound: { mute: false },
    destroy: mocks.gameDestroy,
  }),
}));

vi.mock('./agent/agent-bridge', () => ({
  AgentApiClient: class {
    constructor() {
      return mocks.agentApi;
    }
  },
  AgentBridge: class {
    constructor() {
      return mocks.bridge;
    }
  },
  AgentHttpError: class extends Error {
    constructor(readonly status: number) {
      super('Agent HTTP error');
    }
  },
}));

vi.mock('./town/town-api-client', () => ({
  TownApiClient: class {
    constructor() {
      return mocks.townApi;
    }
  },
}));

vi.mock('./town/town-pulse-loop', () => ({
  TownPulseLoop: class {
    private running = false;

    start(getProjection: () => TownProjection) {
      if (this.running) return;
      this.running = true;
      mocks.pulseStart(getProjection);
    }

    stop() {
      this.running = false;
      mocks.pulseStop();
    }
  },
}));

vi.mock('./scenes/world-scene', () => ({
  WorldScene: class {
    static readonly key = 'WorldScene';
  },
}));

vi.mock('./scenes/town-scene', () => ({
  TownScene: class {
    static readonly key = 'TownScene';
  },
}));

vi.mock('./bubble-coordinator', () => ({
  gameBubbles: { showDecision: vi.fn() },
}));

import { createProductionRuntime } from './production-runtime';
import { gameEvents } from './events';

const playerPet: TownProjection['residents'][number]['pet'] = {
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
};

const projection = {
  sessionId: 'session-1',
  version: 0,
  lastEventSequence: 0,
  residents: [
    {
      residentId: 'resident-1',
      pet: playerPet,
      position: { x: 1, y: 1 },
      zoneId: 'plaza',
      availability: 'available',
    },
  ],
  relationships: [],
  modifications: [],
  activities: [],
} satisfies TownProjection;

const homeSnapshot = {
  projection,
  outings: [
    { sessionId: 'session-1', residentId: 'resident-1', status: 'home' },
  ],
  showcaseItems: [],
  experienceCards: [],
} as TownSnapshotResponse;

const townOuting = {
  sessionId: 'session-1',
  residentId: 'resident-1',
  status: 'town' as const,
  startedAt: '2026-07-13T00:00:00.000Z',
  lastConfirmedAt: '2026-07-13T00:00:00.000Z',
};

async function initializedRuntime() {
  const runtime = createProductionRuntime(document.createElement('div'));
  const pending = runtime.initialize();
  gameEvents.emit('world-ready', {} as never);
  await pending;
  return runtime;
}

async function releaseIntoTown(
  runtime: ReturnType<typeof createProductionRuntime>,
) {
  const pending = runtime.releasePet?.();
  await vi.waitFor(() => expect(mocks.sceneStart).toHaveBeenCalled());
  expect(mocks.pulseStart).not.toHaveBeenCalled();
  gameEvents.emit('town-ready', projection);
  await pending;
}

describe('ProductionGameRuntime town pulse lifecycle', () => {
  beforeEach(() => {
    gameEvents.clear();
    vi.clearAllMocks();
    mocks.bridge.createSession.mockResolvedValue({
      session: { id: 'session-1' },
    });
    mocks.townApi.snapshot.mockResolvedValue(homeSnapshot);
    mocks.townApi.release.mockResolvedValue({
      outing: townOuting,
      projection,
    });
    mocks.townApi.recall.mockResolvedValue({
      outing: {
        sessionId: 'session-1',
        residentId: 'resident-1',
        status: 'home',
      },
      projection,
    });
    mocks.townApi.history.mockResolvedValue({
      sessionId: 'session-1',
      events: [],
      experienceCards: [],
    });
    mocks.sceneIsActive.mockReturnValue(true);
  });

  it('starts after town-ready and stops before recall leaves Town Scene', async () => {
    const runtime = await initializedRuntime();

    await releaseIntoTown(runtime);
    expect(mocks.pulseStart).toHaveBeenCalledTimes(1);

    const pendingRecall = runtime.recallPet?.();
    expect(mocks.pulseStop).toHaveBeenCalledTimes(1);
    await pendingRecall;
    expect(mocks.sceneStop).toHaveBeenLastCalledWith('TownScene');
    expect(mocks.sceneStart).toHaveBeenLastCalledWith('WorldScene');
    runtime.destroy();
  });

  it('stops while hidden and restarts only for an active town outing', async () => {
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    const runtime = await initializedRuntime();
    await releaseIntoTown(runtime);

    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.pulseStop).toHaveBeenCalledTimes(1);

    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.pulseStart).toHaveBeenCalledTimes(2);

    mocks.sceneIsActive.mockReturnValue(false);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(mocks.pulseStart).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });

  it('stops on destroy and removes the visibility listener', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    const runtime = await initializedRuntime();
    await releaseIntoTown(runtime);
    runtime.destroy();
    const starts = mocks.pulseStart.mock.calls.length;

    document.dispatchEvent(new Event('visibilitychange'));

    expect(mocks.pulseStop).toHaveBeenCalledTimes(1);
    expect(mocks.pulseStart).toHaveBeenCalledTimes(starts);
  });
});
