import {
  PublicShowcaseItemSchema,
  TownEventSchema,
  type PetDefinition,
  type TownEvent,
} from '@cat-house/shared';
import { describe, expect, it } from 'vitest';

import {
  TownNarrator,
  deterministicEventSelection,
  fallbackReturnHomeRecap,
  validateExperienceCardDraft,
} from './narrator.js';

function pet(id: string, source: 'player-pet' | 'resident'): PetDefinition {
  return {
    schemaVersion: 'pet-definition.v1',
    id: `${id}-pet`,
    displayName: id,
    source,
    species: 'cat',
    spriteId: id,
    palette: { primary: '#112233', secondary: '#445566', accent: '#778899' },
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
function event(
  id: string,
  type: TownEvent['type'],
  payload: unknown,
  sequence: number,
  participants = ['player'],
  zoneId = 'plaza',
): TownEvent {
  return TownEventSchema.parse({
    id,
    sessionId: 'session-1',
    sequence,
    baseVersion: sequence - 1,
    type,
    zoneId,
    participantIds: participants,
    timestamp: `2026-07-13T0${sequence}:00:00.000Z`,
    payload,
  });
}
const moved = event(
  'move-1',
  'resident.moved',
  { residentId: 'player', position: { x: 1, y: 1 } },
  1,
  ['player'],
  'garden',
);
const played = event(
  'play-1',
  'residents.played',
  { activityInstanceId: 'game-1' },
  2,
  ['player', 'friend'],
  'arcade-house',
);
const relationship = event(
  'rel-1',
  'relationship.changed',
  { residentIdA: 'player', residentIdB: 'friend', affinity: 0.7 },
  3,
  ['player', 'friend'],
  'plaza',
);
const context = {
  sessionId: 'session-1',
  playerResidentId: 'player',
  events: [moved, played, relationship],
  pets: [pet('player', 'player-pet'), pet('friend', 'resident')],
  publicShowcaseItems: [
    PublicShowcaseItemSchema.parse({
      id: 'item-1',
      sessionId: 'session-1',
      kind: 'work',
      title: 'Lamp',
      content: 'A public lamp',
      presetIconId: 'lamp',
      isPublic: true,
    }),
  ],
};

describe('experience card grounding', () => {
  it.each([
    [
      {
        title: 'Day',
        body: 'I played.',
        location: 'arcade-house',
        participantIds: ['player'],
        sourceEventIds: ['unknown'],
      },
      'unknown event',
    ],
    [
      {
        title: 'Day',
        body: 'I played.',
        location: 'arcade-house',
        participantIds: ['stranger'],
        sourceEventIds: ['play-1'],
      },
      'unknown participant',
    ],
    [
      {
        title: 'Day',
        body: 'I played.',
        location: 'market',
        participantIds: ['player'],
        sourceEventIds: ['play-1'],
      },
      'unknown location',
    ],
    [
      {
        title: 'Day',
        body: 'I built a castle.',
        location: 'arcade-house',
        participantIds: ['player'],
        sourceEventIds: ['play-1'],
      },
      'invented build',
    ],
    [
      {
        title: 'Day',
        body: 'I found great fortune.',
        location: 'arcade-house',
        participantIds: ['player'],
        sourceEventIds: ['play-1'],
      },
      'invented fortune',
    ],
  ])('rejects %s', (draft) => {
    expect(() => validateExperienceCardDraft(draft, context)).toThrow();
  });
  it('rejects extra/private fields and more than five references', () => {
    expect(() =>
      validateExperienceCardDraft(
        {
          title: 'Day',
          body: 'I played.',
          location: 'arcade-house',
          participantIds: ['player'],
          sourceEventIds: ['play-1'],
          privateMemory: 'secret',
        },
        context,
      ),
    ).toThrow();
    expect(() =>
      validateExperienceCardDraft(
        {
          title: 'Day',
          body: 'I played.',
          location: 'arcade-house',
          participantIds: ['player'],
          sourceEventIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        },
        context,
      ),
    ).toThrow();
  });
  it('selects highest-priority worthy events in chronological order', () => {
    expect(
      deterministicEventSelection([relationship, moved, played]).map(
        (value) => value.id,
      ),
    ).toEqual(['play-1', 'rel-1']);
  });
  it('rejects unsupported open-prose claims even without reserved keywords', () => {
    expect(() =>
      validateExperienceCardDraft(
        {
          title: 'A dragon appeared',
          body: 'I discovered a dragon beneath the arcade.',
          location: 'arcade-house',
          participantIds: ['player'],
          sourceEventIds: ['play-1'],
        },
        context,
      ),
    ).toThrow();
  });
});

describe('TownNarrator', () => {
  it('falls back to grounded first-person text on provider failure', async () => {
    const narrator = new TownNarrator(
      {
        generate: async () => {
          throw new Error('offline');
        },
      },
      { nextId: () => 'card-1', now: () => '2026-07-13T10:00:00.000Z' },
    );
    const result = await narrator.returnHome(context);
    expect(result.recap).toBe(fallbackReturnHomeRecap(context));
    expect(result.recap).toMatch(/^I\b/);
    expect(result.card).toBeUndefined();
  });
  it('does not create a card for ordinary movement or speech', async () => {
    const narrator = new TownNarrator(
      {
        generate: async () => ({
          recap: 'I walked in the garden.',
          card: {
            title: 'Walk',
            body: 'I walked.',
            location: 'garden',
            participantIds: ['player'],
            sourceEventIds: ['move-1'],
          },
        }),
      },
      { nextId: () => 'card-1', now: () => '2026-07-13T10:00:00.000Z' },
    );
    expect(
      (await narrator.returnHome({ ...context, events: [moved] })).card,
    ).toBeUndefined();
  });
  it('falls back when the provider recap is not first-person', async () => {
    const narrator = new TownNarrator(
      { generate: async () => ({ recap: 'We played together.' }) },
      { nextId: () => 'card-1', now: () => '2026-07-13T10:00:00.000Z' },
    );
    expect((await narrator.returnHome(context)).recap).toBe(
      fallbackReturnHomeRecap(context),
    );
  });
  it('requires the card to cite at least one worthy event', async () => {
    const narrator = new TownNarrator(
      {
        generate: async () => ({
          recap: 'I walked and played.',
          card: {
            title: 'A walk',
            body: 'I visited garden.',
            location: 'garden',
            participantIds: ['player'],
            sourceEventIds: ['move-1'],
          },
        }),
      },
      { nextId: () => 'card-1', now: () => '2026-07-13T10:00:00.000Z' },
    );
    expect((await narrator.returnHome(context)).card).toBeUndefined();
  });
  it('accepts an event-grounded first-person card and does not mutate frozen input', async () => {
    const frozen = Object.freeze({
      ...context,
      events: Object.freeze([...context.events]),
    });
    const narrator = new TownNarrator(
      {
        generate: async (received) => {
          expect(Object.keys(received).sort()).toEqual([
            'events',
            'operation',
            'pets',
            'publicShowcaseItems',
            'sessionId',
          ]);
          return {
            recap: 'I played with friend.',
            card: {
              title: 'Arcade time',
              body: 'I played with friend.',
              location: 'arcade-house',
              participantIds: ['player', 'friend'],
              sourceEventIds: ['play-1'],
            },
          };
        },
      },
      { nextId: () => 'card-1', now: () => '2026-07-13T10:00:00.000Z' },
    );
    const result = await narrator.returnHome(frozen);
    expect(result.card).toMatchObject({
      id: 'card-1',
      createdAt: '2026-07-13T10:00:00.000Z',
      sourceEventIds: ['play-1'],
    });
    expect(frozen.events).toEqual(context.events);
  });
});
