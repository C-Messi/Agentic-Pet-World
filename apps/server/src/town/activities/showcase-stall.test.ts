import { TownEventSchema } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';
import { TownActivityRegistry, type EmittedActivityResult } from '../activity-registry.js';
import { FORTUNE_ACTIVITY_DEFINITION } from './fortune.js';
import { buildShowcasePromotion, createShowcaseStallDefinition, type ShowcaseState } from './showcase-stall.js';

const pet = { schemaVersion: 'pet-definition.v1' as const, id: 'pet-owner', displayName: 'Mimi', source: 'player-pet' as const, species: 'cat', spriteId: 'mimi', palette: { primary: '#112233' as const, secondary: '#445566' as const, accent: '#778899' as const }, personality: { curiosity: .5, sociability: .5, playfulness: .5, creativity: .5 }, voice: { style: 'Warm', catchphrases: [] }, interests: ['art'], publicBio: 'Makes <b>tiny</b> things https://bad.test' };
const item = { id: 'item-1', sessionId: 'session-1', kind: 'work' as const, title: 'Paper <star>', content: 'Folded with care https://bad.test', presetIconId: 'star', isPublic: true as const };
const context = (emittedResults: EmittedActivityResult[] = []) => ({ sessionId: 'session-1', activityInstanceId: 'stall-1', baseVersion: 0, lastEventSequence: 0, participantIds: ['owner'], zoneId: 'market' as const, now: '2026-07-13T08:00:00.000Z', emittedResults, nextEventId: (() => { let n = emittedResults.length; return () => `event-${++n}`; })() });
const transition = (registry: TownActivityRegistry, state: Readonly<ShowcaseState>, tool: object) => registry.transition('showcase-stall', state, tool, context()) as Readonly<ShowcaseState>;

describe('showcase stall', () => {
  it('strictly accepts only authorized public same-session bounded items', () => {
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [{ ...item, isPublic: false }] })).toThrow();
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'other', items: [item] })).toThrow(/session/);
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: Array.from({ length: 13 }, (_, i) => ({ ...item, id: `item-${i}` })) })).toThrow();
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [{ ...item, price: 2 }] })).toThrow();
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [{ ...item, presetIconId: 'unknown' }] })).toThrow();
    expect(() => createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [item], conversation: 'private' } as unknown)).toThrow();
  });

  it('builds a deterministic sanitized bounded promotion', () => {
    const line = buildShowcasePromotion(pet, [item], 'cozy');
    expect(line).toBe(buildShowcasePromotion(pet, [item], 'cozy'));
    expect(line.length).toBeGreaterThan(0); expect(line.length).toBeLessThanOrEqual(80);
    expect(line).not.toMatch(/[<>]|https?:/);
  });

  it('runs setting-up -> open -> closing with strict tools and visitor summaries', () => {
    const registry = new TownActivityRegistry().register(createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [item], availableResidentIds: ['visitor'] }));
    let state = registry.createInitialState('showcase-stall', context()) as Readonly<ShowcaseState>;
    expect(state.phase).toBe('closed');
    state = transition(registry, state, { type: 'setup', theme: 'cozy', signStyle: 'chalkboard', showcaseItemIds: ['item-1'], openDurationMs: 60_000 });
    expect(state.phase).toBe('setting-up');
    state = transition(registry, state, { type: 'open' });
    expect(state.phase).toBe('open');
    state = transition(registry, state, { type: 'greet', visitorResidentId: 'visitor', interactionId: 'visit-1' });
    expect(state.summary.visitorCount).toBe(1);
    expect(() => registry.transition('showcase-stall', state, { type: 'view', visitorResidentId: 'owner', interactionId: 'bad' }, context())).toThrow();
    expect(() => registry.transition('showcase-stall', state, { type: 'ask', visitorResidentId: 'unknown', interactionId: 'bad' }, context())).toThrow();
    state = transition(registry, state, { type: 'close' });
    expect(state.phase).toBe('closing');
    expect(() => registry.transition('showcase-stall', state, { type: 'open' }, context())).toThrow();
  });

  it('validates result events against exact representable state facts and phase', () => {
    const definition = createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [item], availableResidentIds: ['visitor'] });
    const registry = new TownActivityRegistry().register(definition);
    const closed = registry.createInitialState('showcase-stall', context()) as Readonly<ShowcaseState>;
    const settingUp = transition(registry, closed, { type: 'setup', theme: 'cozy', signStyle: 'chalkboard', showcaseItemIds: ['item-1'], openDurationMs: 60_000 });
    const open = transition(registry, settingUp, { type: 'open' });
    const visit = transition(registry, open, { type: 'greet', visitorResidentId: 'visitor', interactionId: 'visit-1' });
    const event = (type: 'stall.opened' | 'stall.visited' | 'stall.closed', payload: object, participants = ['owner']) => TownEventSchema.parse({ id: `event-${type}`, sessionId: 'session-1', sequence: 1, baseVersion: 0, type, zoneId: 'market', participantIds: participants, timestamp: '2026-07-13T08:00:00.000Z', payload });
    const opened = event('stall.opened', { stallId: 'stall-1', showcaseItemIds: ['item-1'] });
    expect(definition.validateResultEvent(opened, open, context())).toBe(true);
    expect(definition.validateResultEvent(opened, closed, context())).toBe(false);
    expect(definition.validateResultEvent(event('stall.opened', { stallId: 'stall-1', showcaseItemIds: ['other'] }), open, context())).toBe(false);
    expect(definition.validateResultEvent(event('stall.visited', { stallId: 'stall-1', visitorResidentId: 'visitor' }, ['owner', 'visitor']), visit, context())).toBe(true);
    expect(definition.validateResultEvent(event('stall.visited', { stallId: 'stall-1', visitorResidentId: 'other' }, ['owner', 'other']), visit, context())).toBe(false);
    const closing = transition(registry, visit, { type: 'close' });
    expect(definition.validateResultEvent(event('stall.closed', { stallId: 'stall-1' }), closing, context())).toBe(true);
    expect(definition.validateResultEvent(event('stall.closed', { stallId: 'wrong' }), closing, context())).toBe(false);
    // Theme, sign and promotion remain strict state facts; current protocol intentionally does not emit them.
    expect(open).toMatchObject({ theme: 'cozy', signStyle: 'chalkboard', promotionLine: expect.any(String) });
  });

  it('emits owner open, repeated external visits with distinct fact keys, and close idempotently', () => {
    const definition = createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [item], availableResidentIds: ['visitor'] });
    const registry = new TownActivityRegistry().register(definition);
    let state = registry.createInitialState('showcase-stall', context()) as Readonly<ShowcaseState>;
    state = transition(registry, state, { type: 'setup', theme: 'cozy', signStyle: 'chalkboard', showcaseItemIds: ['item-1'], openDurationMs: 60_000 });
    state = transition(registry, state, { type: 'open' });
    const opened = registry.resultEvents('showcase-stall', state, context());
    expect(opened[0]).toMatchObject({ type: 'stall.opened', participantIds: ['owner'], payload: { stallId: 'stall-1', showcaseItemIds: ['item-1'] } });
    state = transition(registry, state, { type: 'greet', visitorResidentId: 'visitor', interactionId: 'visit-1' });
    state = transition(registry, state, { type: 'view', visitorResidentId: 'visitor', interactionId: 'visit-2' });
    const cursor = [{ activityInstanceId: 'stall-1', eventType: 'stall.opened' as const, factKey: 'stall-opened', eventId: 'old-open' }];
    const visits = registry.resultEvents('showcase-stall', state, context(cursor));
    expect(visits.map(e => e.type)).toEqual(['stall.visited', 'stall.visited']);
    expect(visits.every(e => e.participantIds.includes('visitor'))).toBe(true);
    const emitted = [...cursor, ...visits.map((e, i) => ({ activityInstanceId: 'stall-1', eventType: e.type, factKey: `stall-visited-visitor-visit-${i + 1}`, eventId: e.id }))];
    expect(registry.resultEvents('showcase-stall', state, context(emitted))).toEqual([]);
    state = transition(registry, state, { type: 'close' });
    expect(registry.resultEvents('showcase-stall', state, context(emitted)).at(-1)?.type).toBe('stall.closed');
  });

  it('registers independently from fortune in a distinct zone', () => {
    const registry = new TownActivityRegistry().register(FORTUNE_ACTIVITY_DEFINITION).register(createShowcaseStallDefinition({ pet, sessionId: 'session-1', items: [item] }));
    expect(registry.list().map(x => x.id)).toEqual(['fortune-draw', 'showcase-stall']);
  });
});
