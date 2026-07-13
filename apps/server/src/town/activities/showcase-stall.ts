import { IdentifierSchema, PetDefinitionSchema, PublicShowcaseItemSchema, TownEventSchema, type PublicShowcaseItem } from '@cat-house/shared';
import { z } from 'zod';
import type { ReadonlyPetDefinition } from '../pet-catalog.js';
import type { ActivityContext, TownActivityDefinition } from '../activity-registry.js';

export const ShowcaseThemeSchema = z.enum(['cozy', 'playful', 'gallery']);
export const ShowcaseSignStyleSchema = z.enum(['chalkboard', 'banner', 'minimal']);
export const ShowcaseIconSchema = z.enum(['star', 'heart', 'sparkle']);
const InteractionSchema = z.object({ id: IdentifierSchema, visitorResidentId: IdentifierSchema, kind: z.enum(['greet', 'view', 'ask', 'compliment', 'respond']) }).strict();
const SummarySchema = z.object({ visitorCount: z.number().int().nonnegative().max(100), interactionCount: z.number().int().nonnegative().max(200) }).strict();
const Base = { version: z.literal('showcase-state.v1'), operatorResidentId: IdentifierSchema, stallId: IdentifierSchema, theme: ShowcaseThemeSchema.optional(), signStyle: ShowcaseSignStyleSchema.optional(), showcaseItemIds: z.array(IdentifierSchema).max(3), openDurationMs: z.number().int().min(1_000).max(600_000).optional(), promotionLine: z.string().min(1).max(80).optional(), interactions: z.array(InteractionSchema).max(100), summary: SummarySchema };
export const ShowcaseStateSchema = z.discriminatedUnion('phase', [
  z.object({ ...Base, phase: z.literal('closed') }).strict(),
  z.object({ ...Base, phase: z.literal('setting-up') }).strict(),
  z.object({ ...Base, phase: z.literal('open'), theme: ShowcaseThemeSchema, signStyle: ShowcaseSignStyleSchema, showcaseItemIds: z.array(IdentifierSchema).min(1).max(3), openDurationMs: z.number().int().min(1_000).max(600_000), promotionLine: z.string().min(1).max(80) }).strict(),
  z.object({ ...Base, phase: z.literal('closing'), theme: ShowcaseThemeSchema, signStyle: ShowcaseSignStyleSchema, showcaseItemIds: z.array(IdentifierSchema).min(1).max(3), openDurationMs: z.number().int().min(1_000).max(600_000), promotionLine: z.string().min(1).max(80) }).strict(),
]);
export type ShowcaseState = z.infer<typeof ShowcaseStateSchema>;
export const ShowcaseToolSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setup'), theme: ShowcaseThemeSchema, signStyle: ShowcaseSignStyleSchema, showcaseItemIds: z.array(IdentifierSchema).min(1).max(3), openDurationMs: z.number().int().min(1_000).max(600_000) }).strict(),
  z.object({ type: z.literal('open') }).strict(),
  ...(['greet', 'view', 'ask', 'compliment', 'respond'] as const).map(type => z.object({ type: z.literal(type), visitorResidentId: IdentifierSchema, interactionId: IdentifierSchema }).strict()),
  z.object({ type: z.literal('close') }).strict(),
]);
export type ShowcaseTool = z.infer<typeof ShowcaseToolSchema>;

export class ShowcaseActivityError extends Error { constructor(readonly code: 'illegal-transition' | 'invalid-participant' | 'invalid-item' | 'invalid-result-event', message: string) { super(message); this.name = 'ShowcaseActivityError'; } }
const FactorySchema = z.object({ pet: PetDefinitionSchema, sessionId: IdentifierSchema, items: z.array(PublicShowcaseItemSchema).max(12), availableResidentIds: z.array(IdentifierSchema).max(16).optional() }).strict();

export function buildShowcasePromotion(petSource: ReadonlyPetDefinition, itemSources: readonly PublicShowcaseItem[], themeSource: z.infer<typeof ShowcaseThemeSchema>): string {
  const pet = PetDefinitionSchema.parse(structuredClone(petSource)); const items = z.array(PublicShowcaseItemSchema).min(1).max(3).parse(structuredClone(itemSources)); const theme = ShowcaseThemeSchema.parse(themeSource);
  const clean = (s: string) => s.replace(/https?:\/\/\S+/gi, '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  const text = `${theme}: ${clean(pet.publicBio)} ${clean(pet.interests.join(' '))} - ${items.map(i => `${clean(i.title)} ${clean(i.content)}`).join('; ')}`;
  return text.slice(0, 80).trim();
}

export function createShowcaseStallDefinition(source: unknown): TownActivityDefinition<ShowcaseState, ShowcaseTool> {
  const parsed = FactorySchema.parse(structuredClone(source));
  if (parsed.items.some(i => i.sessionId !== parsed.sessionId)) throw new ShowcaseActivityError('invalid-item', 'Showcase item session mismatch');
  for (const item of parsed.items) ShowcaseIconSchema.parse(item.presetIconId);
  const items = new Map(parsed.items.map(i => [i.id, deepFreeze(i)])); const available = new Set(parsed.availableResidentIds ?? []);
  const assertContext = (state: ShowcaseState, context: ActivityContext) => { if (context.participantIds.length !== 1 || context.participantIds[0] !== state.operatorResidentId || context.activityInstanceId !== state.stallId) throw new ShowcaseActivityError('invalid-participant', 'Operator/context mismatch'); };
  const definition: TownActivityDefinition<ShowcaseState, ShowcaseTool> = {
    id: 'showcase-stall', zoneId: 'market', capacity: 1, resultEventTypes: ['stall.opened', 'stall.visited', 'stall.closed'], stateSchema: ShowcaseStateSchema, toolSchema: ShowcaseToolSchema,
    createInitialState: context => ({ version: 'showcase-state.v1', phase: 'closed', operatorResidentId: context.participantIds[0]!, stallId: context.activityInstanceId, showcaseItemIds: [], interactions: [], summary: { visitorCount: 0, interactionCount: 0 } }),
    transition: (state, tool, context) => {
      assertContext(state, context);
      if (tool.type === 'setup') { if (state.phase !== 'closed') return illegal('Setup is only legal from closed'); if (new Set(tool.showcaseItemIds).size !== tool.showcaseItemIds.length || tool.showcaseItemIds.some(id => !items.has(id))) throw new ShowcaseActivityError('invalid-item', 'Unknown or duplicate showcase item'); return { ...state, phase: 'setting-up', theme: tool.theme, signStyle: tool.signStyle, showcaseItemIds: [...tool.showcaseItemIds], openDurationMs: tool.openDurationMs, promotionLine: buildShowcasePromotion(parsed.pet, tool.showcaseItemIds.map(id => items.get(id)!), tool.theme) }; }
      if (tool.type === 'open') { if (state.phase !== 'setting-up' || !state.theme || !state.signStyle || !state.openDurationMs || !state.promotionLine || state.showcaseItemIds.length === 0) return illegal('Configured stall required before opening'); return { ...state, phase: 'open', theme: state.theme, signStyle: state.signStyle, openDurationMs: state.openDurationMs, promotionLine: state.promotionLine, showcaseItemIds: state.showcaseItemIds }; }
      if (tool.type === 'close') { if (state.phase !== 'open') return illegal('Only an open stall can close'); return { ...state, phase: 'closing' }; }
      if (state.phase !== 'open') return illegal('Visitor interactions require an open stall');
      if (tool.visitorResidentId === state.operatorResidentId || (available.size && !available.has(tool.visitorResidentId))) throw new ShowcaseActivityError('invalid-participant', 'Visitor must be external and available');
      if (state.interactions.some(i => i.id === tool.interactionId)) return illegal('Interaction ID already used');
      const first = !state.interactions.some(i => i.visitorResidentId === tool.visitorResidentId);
      return { ...state, interactions: [...state.interactions, { id: tool.interactionId, visitorResidentId: tool.visitorResidentId, kind: tool.type }], summary: { visitorCount: state.summary.visitorCount + (first ? 1 : 0), interactionCount: state.summary.interactionCount + 1 } };
    },
    resultEvents: (state, context) => {
      assertContext(state, context); const emitted = new Set(context.emittedResults.map(x => x.factKey)); const facts: { key: string; type: 'stall.opened' | 'stall.visited' | 'stall.closed'; participants: string[]; payload: object }[] = [];
      if (state.phase === 'open' && !emitted.has('stall-opened')) facts.push({ key: 'stall-opened', type: 'stall.opened', participants: [state.operatorResidentId], payload: { stallId: state.stallId, showcaseItemIds: state.showcaseItemIds } });
      for (const interaction of state.interactions) { const key = `stall-visited-${interaction.visitorResidentId}-${interaction.id}`; if (!emitted.has(key)) facts.push({ key, type: 'stall.visited', participants: [state.operatorResidentId, interaction.visitorResidentId], payload: { stallId: state.stallId, visitorResidentId: interaction.visitorResidentId } }); }
      if (state.phase === 'closing' && !emitted.has('stall-closed')) facts.push({ key: 'stall-closed', type: 'stall.closed', participants: [state.operatorResidentId], payload: { stallId: state.stallId } });
      return facts.map((f, i) => TownEventSchema.parse({ id: context.nextEventId(), sessionId: context.sessionId, sequence: context.lastEventSequence + i + 1, baseVersion: context.baseVersion + i, type: f.type, zoneId: 'market', participantIds: f.participants, timestamp: context.now, payload: f.payload }));
    },
    validateResultEvent: (event, state, context) => {
      if (event.type !== 'stall.opened' && event.type !== 'stall.visited' && event.type !== 'stall.closed') return false;
      if (event.zoneId !== 'market' || event.payload.stallId !== state.stallId || event.sessionId !== context.sessionId) return false;
      if (event.type === 'stall.opened') return state.phase === 'open' && exact(event.participantIds, [state.operatorResidentId]) && exact(event.payload.showcaseItemIds, state.showcaseItemIds);
      if (event.type === 'stall.closed') return state.phase === 'closing' && exact(event.participantIds, [state.operatorResidentId]);
      return state.phase === 'open' && event.payload.visitorResidentId !== state.operatorResidentId && exact(event.participantIds, [state.operatorResidentId, event.payload.visitorResidentId]) && state.interactions.some(interaction => interaction.visitorResidentId === event.payload.visitorResidentId);
    },
  };
  return Object.freeze(definition);
}
function illegal(message: string): never { throw new ShowcaseActivityError('illegal-transition', message); }
function exact(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const v of Object.values(value)) deepFreeze(v); Object.freeze(value); } return value; }
