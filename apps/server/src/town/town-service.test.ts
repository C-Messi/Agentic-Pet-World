import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { openDatabase } from '../storage/database.js';
import { SessionRepository } from '../storage/repositories/index.js';
import { TownService, TownServiceError } from './town-service.js';

describe('TownService', () => {
  it('initializes a persistent town and manages the player outing', () => {
    const database = openDatabase(':memory:');
    const service = new TownService(database, {
      now: () => '2026-07-13T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-1`,
      random: () => 0.25,
    });
    new SessionRepository(database).create({
      id: 'session-1',
      createdAt: '2026-07-13T08:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });

    const snapshot = service.snapshot('session-1');
    expect(snapshot.projection.residents).toHaveLength(5);
    expect(snapshot.projection.version).toBe(0);
    expect(
      service.release({ sessionId: 'session-1', residentId: 'player-cat' })
        .outing.status,
    ).toBe('town');
    expect(
      service.recall({ sessionId: 'session-1', residentId: 'player-cat' })
        .outing.status,
    ).toBe('home');
    database.close();
  });

  it('applies approved intents atomically and rejects stale versions', () => {
    const database = openDatabase(':memory:');
    let id = 0;
    const service = new TownService(database, {
      now: () => '2026-07-13T08:00:00.000Z',
      nextId: (prefix) => `${prefix}-${++id}`,
      random: () => 0.25,
    });
    new SessionRepository(database).create({
      id: 'session-1',
      createdAt: '2026-07-13T08:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    service.snapshot('session-1');

    const advanced = service.advance({
      sessionId: 'session-1',
      baseVersion: 0,
      intents: [{ type: 'visit-zone', actorId: 'player-cat', zoneId: 'plaza' }],
    });
    expect(advanced.events).toHaveLength(1);
    expect(advanced.projection.version).toBe(1);
    expect(() =>
      service.advance({
        sessionId: 'session-1',
        baseVersion: 0,
        intents: [
          { type: 'visit-zone', actorId: 'player-cat', zoneId: 'garden' },
        ],
      }),
    ).toThrowError(TownServiceError);
    database.close();
  });

  it('persists bounded recovery events and returns the same window after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'town-recovery-'));
    const path = join(directory, 'town.sqlite');
    let id = 0;
    let now = '2026-07-13T08:00:00.000Z';
    const ports = {
      now: () => now,
      nextId: (prefix: 'town-event' | 'activity') => `${prefix}-${++id}`,
      random: () => 0.25,
    };
    let database = openDatabase(path);
    new SessionRepository(database).create({
      id: 'session-1',
      createdAt: '2026-07-13T08:00:00.000Z',
      updatedAt: '2026-07-13T08:00:00.000Z',
    });
    let service = new TownService(database, ports);
    service.snapshot('session-1');
    service.release({ sessionId: 'session-1', residentId: 'player-cat' });
    now = '2026-07-13T10:00:00.000Z';

    const request = {
      sessionId: 'session-1',
      residentId: 'player-cat',
      lastConfirmedAt: '2026-07-13T08:00:00.000Z',
      recoveryWindowId: 'recovery-1',
    };
    const first = service.recover(request);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThanOrEqual(5);
    database.close();

    database = openDatabase(path);
    service = new TownService(database, ports);
    expect(service.recover(request)).toEqual(first);
    expect(service.history('session-1').events).toEqual(first.events);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
});
