import { TownProjectionSchema, type TownProjection } from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import { reduceTownEvent } from './event-reducer.js';
import {
  BUILD_PLOTS,
  BUILD_RECIPES,
  createBuildCompletedEvent,
  createBuildStartedEvent,
  requireBuildRecipe,
  validateBuildPlacement,
} from './build-recipes.js';

const pet = (id: string, source: 'player-pet' | 'resident') => ({
  schemaVersion: 'pet-definition.v1' as const, id, displayName: id, source,
  species: 'cat', spriteId: id,
  palette: { primary: '#112233' as const, secondary: '#445566' as const, accent: '#778899' as const },
  personality: { curiosity: .5, sociability: .5, playfulness: .5, creativity: .5 },
  voice: { style: 'Plain', catchphrases: [] }, interests: [], publicBio: 'Public cat.',
});

function projection(modifications: TownProjection['modifications'] = []): TownProjection {
  return TownProjectionSchema.parse({
    sessionId: 'session-1', version: 0, lastEventSequence: 0,
    residents: [
      { residentId: 'owner', pet: pet('owner-pet', 'player-pet'), position: { x: 1, y: 1 }, zoneId: 'build-plots', availability: 'available' },
      { residentId: 'helper', pet: pet('helper-pet', 'resident'), position: { x: 2, y: 1 }, zoneId: 'build-plots', availability: 'available' },
    ], relationships: [], modifications, activities: [],
  });
}

describe('safe build recipes', () => {
  it('publishes exactly five frozen, bounded recipes', () => {
    expect(BUILD_RECIPES.map(({ id }) => id)).toEqual(['stone-path', 'flower-patch', 'street-lamp', 'showcase-stall', 'wish-corner']);
    for (const recipe of BUILD_RECIPES) {
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(recipe.buildDurationMs).toBeGreaterThanOrEqual(1_000);
      expect(recipe.buildDurationMs).toBeLessThanOrEqual(600_000);
      expect(recipe.participantCapacity).toBeGreaterThanOrEqual(1);
      expect(recipe.participantCapacity).toBeLessThanOrEqual(4);
    }
    expect(() => requireBuildRecipe('unknown')).toThrow(/Unknown build recipe/);
  });

  it.each(BUILD_RECIPES)('plans valid placement for $id without mutating input', (recipe) => {
    const input = projection();
    const before = structuredClone(input);
    const plot = BUILD_PLOTS.find(({ id }) => recipe.allowedPlotIds.includes(id))!;
    const plan = validateBuildPlacement({ projection: input, recipeId: recipe.id, plotId: plot.id, originCell: plot.origin, participantIds: ['owner'] });
    expect(plan.modification).toEqual({ id: plan.modificationId, recipeId: recipe.id, plotId: plot.id, occupiedCells: recipe.occupiedCells.map(c => ({ x: c.x + plot.origin.x, y: c.y + plot.origin.y })), atlasFrame: recipe.atlasFrame, collision: recipe.collision });
    expect(input).toEqual(before);
    expect(Object.isFrozen(plan)).toBe(true);
  });

  it('rejects unknown plots, bounds, overlap, duplicate/over-capacity participants and cap', () => {
    const base = { projection: projection(), recipeId: 'showcase-stall', plotId: 'market-east', originCell: { x: 18, y: 7 }, participantIds: ['owner'] };
    expect(() => validateBuildPlacement({ ...base, plotId: 'bad' })).toThrow(/Unknown build plot/);
    expect(() => validateBuildPlacement({ ...base, originCell: { x: 99, y: 99 } })).toThrow(/bounds/);
    expect(() => validateBuildPlacement({ ...base, participantIds: ['owner', 'owner'] })).toThrow(/unique/);
    expect(() => validateBuildPlacement({ ...base, participantIds: ['owner', 'helper'] })).toThrow(/capacity/);
    const first = validateBuildPlacement(base);
    expect(() => validateBuildPlacement({ ...base, projection: projection([structuredClone(first.modification) as TownProjection['modifications'][number]]) })).toThrow(/overlap/);
    const many = Array.from({ length: 128 }, (_, i) => ({ ...first.modification, id: `mod-${i}`, plotId: `plot-${i}`, occupiedCells: [{ x: -900 + i, y: -900 }] }));
    expect(() => validateBuildPlacement({ ...base, projection: projection(many) })).toThrow(/128/);
  });

  it('rejects direct and indirect critical-route blocking', () => {
    const base = { projection: projection(), recipeId: 'stone-path', plotId: 'gate-corridor', participantIds: ['owner'] };
    expect(() => validateBuildPlacement({ ...base, originCell: { x: 1, y: 5 } })).toThrow(/critical route/);
    expect(() => validateBuildPlacement({ ...base, originCell: { x: 2, y: 4 } })).toThrow(/critical route/);
  });

  it('creates deterministic exact events that reduce sequentially and reject duplicate completion', () => {
    const plan = validateBuildPlacement({ projection: projection(), recipeId: 'flower-patch', plotId: 'garden-west', originCell: { x: 4, y: 11 }, participantIds: ['owner', 'helper'], modificationId: 'build-1' });
    const started = createBuildStartedEvent(plan, { id: 'event-1', sessionId: 'session-1', sequence: 1, baseVersion: 0, timestamp: '2026-07-13T08:00:00.000Z' });
    const afterStart = reduceTownEvent(projection(), started);
    const completed = createBuildCompletedEvent(plan, { id: 'event-2', sessionId: 'session-1', sequence: 2, baseVersion: 1, timestamp: '2026-07-13T08:01:00.000Z' });
    expect(completed.payload).toEqual({ modification: plan.modification });
    const afterComplete = reduceTownEvent(afterStart, completed);
    expect(afterComplete.modifications).toEqual([plan.modification]);
    expect(() => reduceTownEvent({ ...afterStart, modifications: [structuredClone(plan.modification) as TownProjection['modifications'][number]] }, completed)).toThrow(/already exists/);
  });
});
