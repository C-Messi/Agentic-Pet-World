import {
  IdentifierSchema,
  TownEventSchema,
  TownProjectionSchema,
  TownWorldModificationSchema,
  type TownEvent,
  type TownProjection,
  type TownWorldModification,
} from '@cat-house/shared';
import { z } from 'zod';

type DeepReadonly<T> = T extends (...args: never[]) => unknown ? T : T extends readonly (infer U)[] ? readonly DeepReadonly<U>[] : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
const CellSchema = z.object({ x: z.number().int().min(0).max(23), y: z.number().int().min(0).max(17) }).strict();
type Cell = z.infer<typeof CellSchema>;

const RecipeSchema = z.object({
  id: IdentifierSchema,
  allowedPlotIds: z.array(IdentifierSchema).min(1),
  occupiedCells: z.array(z.object({ x: z.number().int().min(0).max(7), y: z.number().int().min(0).max(7) }).strict()).min(1).max(64),
  buildDurationMs: z.number().int().min(1_000).max(600_000),
  participantCapacity: z.number().int().min(1).max(4),
  atlasFrame: z.number().int().nonnegative(), collision: z.boolean(),
}).strict();
export type BuildRecipe = DeepReadonly<z.infer<typeof RecipeSchema>>;

const PlotSchema = z.object({ id: IdentifierSchema, origin: CellSchema, bounds: z.object({ x: z.number().int().min(0).max(23), y: z.number().int().min(0).max(17), width: z.number().int().positive().max(12), height: z.number().int().positive().max(12) }).strict() }).strict();
export const TOWN_GRID = deepFreeze({ width: 24, height: 18 });
export const TOWN_GATE_CELL = deepFreeze({ x: 1, y: 4 });
export const ACTIVITY_ENTRANCES = deepFreeze({ plaza: { x: 6, y: 4 }, 'fortune-pavilion': { x: 10, y: 3 }, market: { x: 18, y: 6 }, garden: { x: 6, y: 12 }, 'build-plots': { x: 1, y: 5 }, 'arcade-house': { x: 18, y: 13 } });
export const BUILD_PLOTS = deepFreeze([
  { id: 'plaza-north', origin: { x: 7, y: 6 }, bounds: { x: 7, y: 6, width: 5, height: 3 } },
  { id: 'garden-west', origin: { x: 4, y: 11 }, bounds: { x: 4, y: 11, width: 6, height: 4 } },
  { id: 'market-east', origin: { x: 18, y: 7 }, bounds: { x: 18, y: 7, width: 4, height: 4 } },
  { id: 'gate-corridor', origin: { x: 1, y: 4 }, bounds: { x: 1, y: 4, width: 2, height: 2 } },
] satisfies z.input<typeof PlotSchema>[]).map(plot => deepFreeze(PlotSchema.parse(plot)));
export const PERMANENT_BLOCKED_CELLS = deepFreeze([
  ...Array.from({ length: 18 }, (_, y) => ({ x: 0, y })),
  ...Array.from({ length: 18 }, (_, y) => ({ x: 23, y })),
  ...Array.from({ length: 24 }, (_, x) => ({ x, y: 0 })),
  ...Array.from({ length: 24 }, (_, x) => ({ x, y: 17 })),
  ...Array.from({ length: 17 }, (_, y) => y === 4 ? null : ({ x: 3, y })).filter((x): x is Cell => x !== null),
]);

const rawRecipes = [
  { id: 'stone-path', allowedPlotIds: ['plaza-north', 'garden-west', 'gate-corridor'], occupiedCells: [{ x: 0, y: 0 }], buildDurationMs: 1_000, participantCapacity: 4, atlasFrame: 1, collision: true },
  { id: 'flower-patch', allowedPlotIds: ['garden-west', 'plaza-north'], occupiedCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }], buildDurationMs: 5_000, participantCapacity: 2, atlasFrame: 2, collision: false },
  { id: 'street-lamp', allowedPlotIds: ['plaza-north', 'market-east'], occupiedCells: [{ x: 0, y: 0 }], buildDurationMs: 3_000, participantCapacity: 1, atlasFrame: 3, collision: true },
  { id: 'showcase-stall', allowedPlotIds: ['market-east'], occupiedCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }], buildDurationMs: 10_000, participantCapacity: 1, atlasFrame: 4, collision: true },
  { id: 'wish-corner', allowedPlotIds: ['garden-west'], occupiedCells: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], buildDurationMs: 8_000, participantCapacity: 3, atlasFrame: 5, collision: true },
] as const;
export const BUILD_RECIPES: readonly BuildRecipe[] = deepFreeze(rawRecipes.map(x => RecipeSchema.parse(x)));

export interface PlannedBuild { readonly modificationId: string; readonly recipe: BuildRecipe; readonly plotId: string; readonly originCell: Cell; readonly participantIds: readonly string[]; readonly modification: DeepReadonly<TownWorldModification>; }

export function requireBuildRecipe(id: string): BuildRecipe {
  IdentifierSchema.parse(id);
  const recipe = BUILD_RECIPES.find(x => x.id === id);
  if (!recipe) throw new TypeError(`Unknown build recipe: ${id}`);
  return recipe;
}

export function validateBuildPlacement(source: { projection: Readonly<TownProjection>; recipeId: string; plotId: string; originCell: Cell; participantIds: readonly string[]; modificationId?: string }): PlannedBuild {
  const projection = TownProjectionSchema.parse(structuredClone(source.projection));
  if (projection.modifications.length >= 128) throw new TypeError('Town modification cap of 128 reached');
  const recipe = requireBuildRecipe(source.recipeId);
  const plot = BUILD_PLOTS.find(x => x.id === source.plotId);
  if (!plot) throw new TypeError(`Unknown build plot: ${source.plotId}`);
  if (!recipe.allowedPlotIds.includes(plot.id)) throw new TypeError('Recipe is not allowed on selected plot');
  const originResult = CellSchema.safeParse(structuredClone(source.originCell));
  if (!originResult.success) throw new TypeError('Build placement is outside town or plot bounds');
  const origin = originResult.data;
  const participantsResult = z.array(IdentifierSchema).min(1).safeParse(structuredClone(source.participantIds));
  if (!participantsResult.success) throw new TypeError('Build participants are invalid');
  const participants = participantsResult.data;
  if (new Set(participants).size !== participants.length) throw new TypeError('Build participants must be unique');
  if (participants.length > recipe.participantCapacity) throw new TypeError('Build participant capacity exceeded');
  for (const id of participants) if (!projection.residents.some(r => r.residentId === id)) throw new TypeError(`Unknown participant: ${id}`);
  const cells = recipe.occupiedCells.map(c => ({ x: origin.x + c.x, y: origin.y + c.y }));
  if (cells.some(c => c.x < plot.bounds.x || c.y < plot.bounds.y || c.x >= plot.bounds.x + plot.bounds.width || c.y >= plot.bounds.y + plot.bounds.height || c.x >= TOWN_GRID.width || c.y >= TOWN_GRID.height)) throw new TypeError('Build placement is outside plot bounds');
  const occupied = new Set(projection.modifications.flatMap(m => m.occupiedCells.map(c => `${c.x}:${c.y}`)));
  if (cells.some(c => occupied.has(`${c.x}:${c.y}`))) throw new TypeError('Build placement overlaps an existing modification');
  const permanent = new Set(PERMANENT_BLOCKED_CELLS.map(c => `${c.x}:${c.y}`));
  if (cells.some(c => permanent.has(`${c.x}:${c.y}`))) throw new TypeError('Build placement overlaps a permanent blocker');
  const overlay = [
    ...projection.modifications.filter(m => m.collision).flatMap(m => m.occupiedCells.map(c => ({ x: c.x, y: c.y }))),
    ...(recipe.collision ? cells : []),
  ];
  if (!routesRemainReachable(overlay)) throw new TypeError('Build placement blocks a critical route');
  const modificationId = IdentifierSchema.parse(source.modificationId ?? `${recipe.id}-${plot.id}-${origin.x}-${origin.y}`);
  const modification = TownWorldModificationSchema.parse({ id: modificationId, recipeId: recipe.id, plotId: plot.id, occupiedCells: cells, atlasFrame: recipe.atlasFrame, collision: recipe.collision });
  return deepFreeze({ modificationId, recipe, plotId: plot.id, originCell: origin, participantIds: participants, modification });
}

type EventContext = { id: string; sessionId: string; sequence: number; baseVersion: number; timestamp: string };
export function createBuildStartedEvent(plan: PlannedBuild, context: EventContext): TownEvent { return event(plan, context, 'build.started'); }
export function createBuildCompletedEvent(plan: PlannedBuild, context: EventContext): TownEvent { return event(plan, context, 'build.completed'); }
function event(plan: PlannedBuild, context: EventContext, type: 'build.started' | 'build.completed'): TownEvent {
  return deepFreeze(TownEventSchema.parse({ ...context, type, zoneId: 'build-plots', participantIds: plan.participantIds, payload: type === 'build.started' ? { modificationId: plan.modificationId, recipeId: plan.recipe.id, plotId: plan.plotId } : { modification: plan.modification } }));
}

function routesRemainReachable(extra: readonly Cell[]): boolean {
  const blocked = new Set([...PERMANENT_BLOCKED_CELLS, ...extra].map(c => `${c.x}:${c.y}`));
  if (blocked.has(`${TOWN_GATE_CELL.x}:${TOWN_GATE_CELL.y}`)) return false;
  const seen = new Set([`${TOWN_GATE_CELL.x}:${TOWN_GATE_CELL.y}`]);
  const queue = [TOWN_GATE_CELL];
  while (queue.length) { const c = queue.shift()!; for (const n of [{ x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 }]) { const k = `${n.x}:${n.y}`; if (n.x >= 0 && n.y >= 0 && n.x < TOWN_GRID.width && n.y < TOWN_GRID.height && !blocked.has(k) && !seen.has(k)) { seen.add(k); queue.push(n); } } }
  return Object.values(ACTIVITY_ENTRANCES).every(c => seen.has(`${c.x}:${c.y}`));
}

function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); } return value; }
