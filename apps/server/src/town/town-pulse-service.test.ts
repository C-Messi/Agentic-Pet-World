import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TownEventSchema,
  TownProjectionSchema,
  type TownProjection,
} from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
} from '../agent/provider.js';
import { FakeProvider } from '../agent/fake-provider.js';
import { openDatabase } from '../storage/database.js';
import {
  SessionRepository,
  TownEventRepository,
  TownProjectionRepository,
  TownPulseRepository,
} from '../storage/repositories/index.js';
import { AutonomyEventBuilder } from './autonomy-event-builder.js';
import { ResidentAgent } from './resident-agent.js';
import { createAuthoredPetDefinitions } from './residents.js';
import { TownSimulationService } from './simulation-service.js';
import { TownEventCommitter } from './town-event-committer.js';
import { TownPulseService } from './town-pulse-service.js';

const NOW = '2026-07-13T10:00:00.000Z';

describe('TownPulseService', () => {
  it('joins same-process duplicate work and replays the completed pulse', async () => {
    const releases: Array<() => void> = [];
    const provider = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() =>
            resolve(JSON.stringify({ kind: 'rest', speech: 'Rest.' })),
          );
        }),
    );
    const fixture = createFixture({ provider: { complete: provider } });
    const request = pulseRequest('pulse-replay');

    const first = fixture.service.pulse(request, new AbortController().signal);
    const duplicate = fixture.service.pulse(
      request,
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(2));
    for (const release of releases) release();

    const [firstResult, duplicateResult] = await Promise.all([
      first,
      duplicate,
    ]);
    expect(duplicateResult).toEqual(firstResult);
    expect(
      await fixture.service.pulse(request, new AbortController().signal),
    ).toEqual(firstResult);
    expect(provider).toHaveBeenCalledTimes(2);
    fixture.close();
  });

  it('keeps provider concurrency at two and never re-enters one resident', async () => {
    let active = 0;
    let maximumActive = 0;
    const activeResidents = new Set<string>();
    const provider: ProviderAdapter = {
      complete: async (request) => {
        const residentId = correlationResident(request.correlationId);
        expect(activeResidents.has(residentId)).toBe(false);
        activeResidents.add(residentId);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 15));
        active -= 1;
        activeResidents.delete(residentId);
        return JSON.stringify({ kind: 'rest', speech: 'Rest.' });
      },
    };
    const fixture = createFixture({ provider });

    await Promise.all([
      fixture.service.pulse(
        pulseRequest('pulse-a'),
        new AbortController().signal,
      ),
      fixture.service.pulse(
        pulseRequest('pulse-b'),
        new AbortController().signal,
      ),
    ]);

    expect(maximumActive).toBe(2);
    fixture.close();
  });

  it('marks only the resident whose provider result degraded', async () => {
    const provider: ProviderAdapter = {
      complete: async (request) =>
        correlationResident(request.correlationId) === 'player-cat'
          ? '{invalid-json'
          : JSON.stringify({ kind: 'rest', speech: 'Rest.' }),
    };
    const fixture = createFixture({ provider });

    const result = await fixture.service.pulse(
      pulseRequest('pulse-degraded'),
      new AbortController().signal,
    );

    expect(result.degraded).toBe(true);
    expect(result.degradedResidentIds).toEqual(['player-cat']);
    fixture.close();
  });

  it('completes and replays stale requests before calling a resident agent', async () => {
    const provider = vi.fn(async () =>
      JSON.stringify({ kind: 'rest', speech: 'Rest.' }),
    );
    const fixture = createFixture({ provider: { complete: provider } });
    advanceProjection(fixture.database);

    const first = await fixture.service.pulse(
      pulseRequest('pulse-stale'),
      new AbortController().signal,
    );
    const replay = await fixture.service.pulse(
      pulseRequest('pulse-stale'),
      new AbortController().signal,
    );

    expect(first).toMatchObject({
      status: 'stale',
      events: [],
      degraded: false,
      degradedResidentIds: [],
      projection: { version: 1 },
    });
    expect(replay).toEqual(first);
    expect(provider).not.toHaveBeenCalled();
    fixture.close();
  });

  it('aborts without committing events or completing the pulse', async () => {
    const fixture = createFixture({
      provider: { complete: () => new Promise(() => undefined) },
    });
    const controller = new AbortController();
    const pending = fixture.service.pulse(
      pulseRequest('pulse-abort'),
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(
      new TownEventRepository(fixture.database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    expect(
      fixture.database
        .prepare('SELECT status FROM town_agent_pulses WHERE pulse_id = ?')
        .get('pulse-abort'),
    ).toEqual({ status: 'pending' });
    fixture.close();
  });

  it('completes a later pulse when prior encounters occupy the current zone', async () => {
    const fixture = createFixture({ provider: new FakeProvider() });
    const signal = new AbortController().signal;
    const first = await fixture.service.pulse(
      pulseRequest('pulse-first'),
      signal,
    );

    const second = await fixture.service.pulse(
      {
        sessionId: 'session-1',
        baseVersion: first.projection.version,
        pulseId: 'pulse-second',
      },
      signal,
    );

    expect(second.status).toBe('advanced');
    expect(
      second.events
        .filter(({ type }) => type === 'resident.moved')
        .map((event) =>
          event.type === 'resident.moved' ? event.payload.residentId : '',
        ),
    ).toEqual(expect.arrayContaining(['resident-huihui', 'resident-lanlan']));
    expect(
      fixture.database
        .prepare('SELECT status FROM town_agent_pulses WHERE pulse_id = ?')
        .get('pulse-second'),
    ).toEqual({ status: 'complete' });
    fixture.close();
  });

  it('completes a pulse when an earlier prepared action occupies its encounter pair', async () => {
    const fixture = createFixture({
      provider: {
        complete: async (request) => {
          if (!decisionRequest(request)) {
            return JSON.stringify({
              speech: 'Hello.',
              animation: 'happy',
              followUpRequested: false,
            });
          }
          const residentId = correlationResident(request.correlationId);
          const targetResidentId =
            residentId === 'player-cat' ? 'resident-huihui' : 'resident-lanlan';
          return JSON.stringify({
            kind: 'candidate',
            candidateIndex: socializeCandidateIndex(request, targetResidentId),
            speech: 'Let us meet.',
          });
        },
      },
    });

    const result = await fixture.service.pulse(
      pulseRequest('pulse-dynamic-conflict'),
      new AbortController().signal,
    );

    expect(result.status).toBe('advanced');
    expect(result.degradedResidentIds).toEqual(['resident-mikan']);
    expect(
      result.events
        .filter(({ type }) => type === 'resident.moved')
        .map((event) =>
          event.type === 'resident.moved' ? event.payload.residentId : '',
        ),
    ).toEqual(['player-cat', 'resident-huihui']);
    expect(
      fixture.database
        .prepare('SELECT status FROM town_agent_pulses WHERE pulse_id = ?')
        .get('pulse-dynamic-conflict'),
    ).toEqual({ status: 'complete' });
    fixture.close();
  });

  it('polls external in-flight work until the completed result is visible', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'town-pulse-poll-'));
    const path = join(directory, 'town.sqlite');
    const releases: Array<() => void> = [];
    const first = createFixture({
      path,
      provider: {
        complete: () =>
          new Promise<string>((resolve) => {
            releases.push(() =>
              resolve(JSON.stringify({ kind: 'rest', speech: 'Rest.' })),
            );
          }),
      },
    });
    const second = createFixture({ path, initialize: false });
    const request = pulseRequest('pulse-external');

    const owner = first.service.pulse(request, new AbortController().signal);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const waiter = second.service.pulse(request, new AbortController().signal);
    for (const release of releases) release();

    expect(await waiter).toEqual(await owner);
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('reclaims an expired external lease', async () => {
    const fixture = createFixture();
    new TownPulseRepository(fixture.database).claim({
      sessionId: 'session-1',
      pulseId: 'pulse-expired',
      baseVersion: 0,
      leaseToken: 'abandoned-lease',
      now: '2026-07-13T09:59:50.000Z',
      leaseExpiresAt: '2026-07-13T09:59:59.000Z',
    });

    const result = await fixture.service.pulse(
      pulseRequest('pulse-expired'),
      new AbortController().signal,
    );

    expect(result.status).toBe('advanced');
    expect(result.degraded).toBe(true);
    fixture.close();
  });

  it('rolls back events, projection, and cached completion together', async () => {
    const fixture = createFixture({
      provider: {
        complete: async (request) =>
          decisionRequest(request)
            ? JSON.stringify({
                kind: 'candidate',
                candidateIndex: visitCandidateIndex(request),
                speech: 'A short walk.',
              })
            : JSON.stringify({
                speech: 'Hello.',
                animation: 'happy',
                followUpRequested: false,
              }),
      },
    });
    fixture.database.exec(`
      CREATE TRIGGER reject_pulse_completion
      BEFORE UPDATE ON town_agent_pulses
      WHEN NEW.status = 'complete'
      BEGIN
        SELECT RAISE(ABORT, 'completion rejected');
      END
    `);

    await expect(
      fixture.service.pulse(
        pulseRequest('pulse-rollback'),
        new AbortController().signal,
      ),
    ).rejects.toThrow('completion rejected');
    expect(
      new TownEventRepository(fixture.database).listAfter('session-1', 0, 24),
    ).toEqual([]);
    expect(
      new TownProjectionRepository(fixture.database).load('session-1'),
    ).toMatchObject({ version: 0, lastEventSequence: 0 });
    expect(
      fixture.database
        .prepare('SELECT status FROM town_agent_pulses WHERE pulse_id = ?')
        .get('pulse-rollback'),
    ).toEqual({ status: 'pending' });
    fixture.close();
  });
});

function createFixture(
  options: {
    provider?: ProviderAdapter;
    path?: string;
    initialize?: boolean;
  } = {},
) {
  const database = openDatabase(options.path ?? ':memory:');
  if (options.initialize !== false) {
    new SessionRepository(database).create({
      id: 'session-1',
      createdAt: NOW,
      updatedAt: NOW,
    });
    new TownProjectionRepository(database).save(
      'session-1',
      -1,
      initialProjection(),
    );
  }
  let id = 0;
  const ports = {
    now: () => NOW,
    random: () => 0.25,
    nextId: (prefix: 'town-event' | 'activity') => `${prefix}-${++id}`,
  };
  const simulation = new TownSimulationService(ports);
  const service = new TownPulseService(database, {
    residentAgent: new ResidentAgent(options.provider),
    simulation,
    eventBuilder: new AutonomyEventBuilder(ports),
    committer: new TownEventCommitter(database, initialProjection),
    createInitialProjection: initialProjection,
    now: ports.now,
    llmTimeoutMs: 1_000,
  });
  return { database, service, close: () => database.close() };
}

function initialProjection(sessionId = 'session-1'): TownProjection {
  return TownProjectionSchema.parse({
    sessionId,
    version: 0,
    lastEventSequence: 0,
    residents: createAuthoredPetDefinitions().map((pet, index) => ({
      residentId: pet.id,
      pet,
      position: { x: 2 + index * 2, y: 4 },
      zoneId: 'gate',
      availability: 'available',
    })),
    relationships: [],
    modifications: [],
    activities: [],
  });
}

function pulseRequest(pulseId: string) {
  return { sessionId: 'session-1', baseVersion: 0, pulseId };
}

function advanceProjection(database: ReturnType<typeof openDatabase>): void {
  new TownEventCommitter(database, initialProjection).apply(
    'session-1',
    0,
    (projection) => [
      TownEventSchema.parse({
        id: 'advance-event',
        sessionId: 'session-1',
        sequence: projection.lastEventSequence + 1,
        baseVersion: projection.version,
        type: 'resident.moved',
        zoneId: 'plaza',
        participantIds: ['player-cat'],
        timestamp: NOW,
        payload: { residentId: 'player-cat', position: { x: 1, y: 1 } },
      }),
    ],
  );
}

function correlationResident(correlationId: string): string {
  const residentId = createAuthoredPetDefinitions()
    .map(({ id }) => id)
    .find((id) => correlationId.includes(id));
  if (residentId === undefined)
    throw new Error(`Unknown correlation: ${correlationId}`);
  return residentId;
}

function decisionRequest(request: ProviderCompletionRequest): boolean {
  return request.trustedInstructions.some((value) =>
    value.includes('resident-decision.v1'),
  );
}

function visitCandidateIndex(request: ProviderCompletionRequest): number {
  const state = request.trustedInstructions.find((value) =>
    value.startsWith('[Authoritative Public Town State]'),
  );
  const parsed = JSON.parse(state!.split('\n', 2)[1]!) as {
    allowedCandidates: Array<{ type: string }>;
  };
  return parsed.allowedCandidates.findIndex(
    ({ type }) => type === 'visit-zone',
  );
}

function socializeCandidateIndex(
  request: ProviderCompletionRequest,
  targetResidentId: string,
): number {
  const state = request.trustedInstructions.find((value) =>
    value.startsWith('[Authoritative Public Town State]'),
  );
  const parsed = JSON.parse(state!.split('\n', 2)[1]!) as {
    allowedCandidates: Array<{
      type: string;
      targetResidentId?: string;
    }>;
  };
  return parsed.allowedCandidates.findIndex(
    (candidate) =>
      candidate.type === 'socialize' &&
      candidate.targetResidentId === targetResidentId,
  );
}
