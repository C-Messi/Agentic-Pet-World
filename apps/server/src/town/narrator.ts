import {
  IdentifierSchema,
  PetDefinitionSchema,
  PublicShowcaseItemSchema,
  TownEventSchema,
  TownZoneIdSchema,
  type PetDefinition,
  type PublicShowcaseItem,
  type TownEvent,
} from '@cat-house/shared';
import { z } from 'zod';

import { buildShowcasePromotion } from './activities/showcase-stall.js';

const Text = z.string().trim().min(1).max(280);
const FirstPersonText = Text.refine((text) => /^I(?:\b|['’])/i.test(text), {
  message: 'Narration must be first-person',
});
const CardDraftSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: Text,
    location: TownZoneIdSchema,
    participantIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length),
    sourceEventIds: z
      .array(IdentifierSchema)
      .min(1)
      .max(5)
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
const ProviderReturnSchema = z
  .object({ recap: FirstPersonText, card: CardDraftSchema.optional() })
  .strict();
const ProviderDialogueSchema = z.object({ dialogue: Text }).strict();

export type ExperienceCardDraft = z.infer<typeof CardDraftSchema>;
export interface NarratorContext {
  readonly sessionId: string;
  readonly playerResidentId: string;
  readonly events: readonly TownEvent[];
  readonly pets: readonly PetDefinition[];
  readonly publicShowcaseItems: readonly PublicShowcaseItem[];
}
export interface NarratedExperienceCard extends ExperienceCardDraft {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: string;
}
export interface NarratorProvider {
  generate(
    input: Readonly<{
      operation: 'dialogue' | 'return-home';
      sessionId: string;
      events: readonly TownEvent[];
      pets: readonly PetDefinition[];
      publicShowcaseItems: readonly PublicShowcaseItem[];
    }>,
  ): Promise<unknown>;
}
export interface NarratorPorts {
  nextId(): string;
  now(): string;
}

const WORTHY_PRIORITY: Partial<Record<TownEvent['type'], number>> = {
  'fortune.revealed': 6,
  'fortune.interpreted': 6,
  'build.completed': 5,
  'stall.visited': 4,
  'stall.closed': 4,
  'relationship.changed': 3,
  'residents.played': 2,
};
export function deterministicEventSelection(
  events: readonly TownEvent[],
): readonly TownEvent[] {
  return [...events]
    .filter((event) => WORTHY_PRIORITY[event.type] !== undefined)
    .sort(
      (a, b) =>
        WORTHY_PRIORITY[b.type]! - WORTHY_PRIORITY[a.type]! ||
        a.sequence - b.sequence,
    )
    .slice(0, 5)
    .sort((a, b) => a.sequence - b.sequence);
}

function parseContext(source: NarratorContext): NarratorContext {
  const parsed = z
    .object({
      sessionId: IdentifierSchema,
      playerResidentId: IdentifierSchema,
      events: z.array(TownEventSchema).max(24),
      pets: z.array(PetDefinitionSchema).min(1).max(16),
      publicShowcaseItems: z.array(PublicShowcaseItemSchema).max(12),
    })
    .strict()
    .parse(structuredClone(source));
  if (
    parsed.events.some((event) => event.sessionId !== parsed.sessionId) ||
    parsed.publicShowcaseItems.some(
      (item) => item.sessionId !== parsed.sessionId,
    )
  )
    throw new Error('Narrator context session mismatch');
  if (
    !parsed.events.some((event) =>
      event.participantIds.includes(parsed.playerResidentId),
    ) &&
    parsed.events.length > 0
  )
    throw new Error('Player pet is absent from narrator events');
  return parsed;
}

const claimRules: readonly [RegExp, readonly TownEvent['type'][]][] = [
  [/\b(?:built|build|constructed)\b/i, ['build.completed']],
  [/\b(?:fortune|lucky|luck)\b/i, ['fortune.revealed', 'fortune.interpreted']],
  [/\b(?:stall|marketed|sold)\b/i, ['stall.visited', 'stall.closed']],
  [/\b(?:played|game)\b/i, ['residents.played']],
  [/\b(?:friendship|closer|bond)\b/i, ['relationship.changed']],
];

export function validateExperienceCardDraft(
  source: unknown,
  sourceContext: NarratorContext,
): ExperienceCardDraft {
  const draft = CardDraftSchema.parse(structuredClone(source));
  const context = parseContext(sourceContext);
  const byId = new Map(context.events.map((event) => [event.id, event]));
  const selected = draft.sourceEventIds.map((id) => byId.get(id));
  if (selected.some((event) => event === undefined))
    throw new Error('Experience card references an unknown event');
  const events = selected as TownEvent[];
  if (events.some((event) => event.sessionId !== context.sessionId))
    throw new Error('Experience card event session mismatch');
  const participants = new Set(events.flatMap((event) => event.participantIds));
  if (draft.participantIds.some((id) => !participants.has(id)))
    throw new Error('Experience card references an unknown participant');
  if (
    participants.has(context.playerResidentId) &&
    !draft.participantIds.includes(context.playerResidentId)
  )
    throw new Error('Experience card must include the player pet');
  if (!events.some((event) => event.zoneId === draft.location))
    throw new Error('Experience card location is not sourced by its events');
  const types = new Set(events.map((event) => event.type));
  if (!events.some((event) => WORTHY_PRIORITY[event.type] !== undefined))
    throw new Error('Experience card must cite a card-worthy event');
  for (const [pattern, required] of claimRules)
    if (
      pattern.test(`${draft.title} ${draft.body}`) &&
      !required.some((type) => types.has(type))
    )
      throw new Error('Experience card contains an unsupported claim');
  if (!/^I(?:\b|['’])/i.test(draft.body))
    throw new Error('Experience card body must be first-person');
  const deterministic = deterministicCardProse(events);
  if (draft.title !== deterministic.title || draft.body !== deterministic.body)
    throw new Error('Experience card prose must be derived from source events');
  return Object.freeze(draft);
}

function eventPhrase(event: TownEvent): string {
  switch (event.type) {
    case 'residents.played':
      return 'played together';
    case 'relationship.changed':
      return 'grew closer to a friend';
    case 'fortune.revealed':
      return 'revealed a fortune';
    case 'fortune.interpreted':
      return 'heard a fortune interpretation';
    case 'build.completed':
      return 'finished a build';
    case 'stall.visited':
      return 'visited a showcase stall';
    case 'stall.closed':
      return 'closed a showcase stall';
    case 'resident.moved':
      return `visited ${event.zoneId ?? 'town'}`;
    case 'resident.spoke':
      return 'shared a few words';
    default:
      return 'spent time in town';
  }
}
function deterministicCardProse(events: readonly TownEvent[]): {
  title: string;
  body: string;
} {
  const worthy = deterministicEventSelection(events);
  return {
    title: worthy.length === 1 ? 'A town memory' : 'Town memories',
    body: `I ${worthy.map(eventPhrase).join(' and ')}.`,
  };
}
export function fallbackReturnHomeRecap(source: NarratorContext): string {
  const context = parseContext(source);
  const selected = deterministicEventSelection(context.events);
  const events = selected.length > 0 ? selected : context.events.slice(-2);
  return events.length === 0
    ? 'I came home after a quiet outing.'
    : `I ${events.map(eventPhrase).join(' and ')}.`.slice(0, 280);
}
export function fallbackTownDialogue(source: NarratorContext): string {
  const context = parseContext(source);
  return context.events.length === 0
    ? 'I am enjoying a quiet moment in town.'
    : `I ${eventPhrase(context.events.at(-1)!)}.`;
}

export class TownNarrator {
  constructor(
    private readonly provider: NarratorProvider | undefined,
    private readonly ports: NarratorPorts,
  ) {}
  async dialogue(source: NarratorContext): Promise<string> {
    const context = parseContext(source);
    if (!this.provider) return fallbackTownDialogue(context);
    try {
      return ProviderDialogueSchema.parse(
        await this.provider.generate(this.request('dialogue', context)),
      ).dialogue;
    } catch {
      return fallbackTownDialogue(context);
    }
  }
  promotion(
    pet: Readonly<PetDefinition>,
    items: readonly PublicShowcaseItem[],
    theme: 'cozy' | 'playful' | 'gallery',
  ): string {
    return buildShowcasePromotion(pet, items, theme);
  }
  async returnHome(
    source: NarratorContext,
  ): Promise<{ recap: string; card?: NarratedExperienceCard }> {
    const context = parseContext(source);
    const fallback = fallbackReturnHomeRecap(context);
    if (!this.provider) return { recap: fallback };
    try {
      const output = ProviderReturnSchema.parse(
        await this.provider.generate(this.request('return-home', context)),
      );
      const worthy = deterministicEventSelection(context.events);
      if (!output.card || worthy.length === 0) return { recap: output.recap };
      const draft = CardDraftSchema.parse(output.card);
      const cited = context.events.filter((event) =>
        draft.sourceEventIds.includes(event.id),
      );
      const card = validateExperienceCardDraft(
        { ...draft, ...deterministicCardProse(cited) },
        context,
      );
      const completed = z
        .object({
          id: IdentifierSchema,
          sessionId: IdentifierSchema,
          createdAt: z.string().datetime({ offset: true }),
        })
        .parse({
          id: this.ports.nextId(),
          sessionId: context.sessionId,
          createdAt: this.ports.now(),
        });
      return {
        recap: output.recap,
        card: Object.freeze({ ...card, ...completed }),
      };
    } catch {
      return { recap: fallback };
    }
  }
  private request(
    operation: 'dialogue' | 'return-home',
    context: NarratorContext,
  ) {
    return Object.freeze({
      operation,
      sessionId: context.sessionId,
      events: Object.freeze(structuredClone(context.events)),
      pets: Object.freeze(structuredClone(context.pets)),
      publicShowcaseItems: Object.freeze(
        structuredClone(context.publicShowcaseItems),
      ),
    });
  }
}
