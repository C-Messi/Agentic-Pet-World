import {
  PublicShowcaseItemSchema,
  TownProjectionSchema,
} from '@cat-house/shared';
import { describe, expect, it, vi } from 'vitest';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
} from '../agent/provider.js';
import { createDefaultPetCatalog } from './pet-catalog.js';
import {
  TownAgentService,
  TownDecisionSchema,
  type TownAgentContext,
} from './town-agent-service.js';

const pets = createDefaultPetCatalog().list();
const player = pets.find((pet) => pet.source === 'player-pet')!;
const friend = pets.find((pet) => pet.displayName.includes('灰灰')) ?? pets[1]!;
const projection = TownProjectionSchema.parse({
  sessionId: 'session-1',
  version: 2,
  lastEventSequence: 0,
  residents: [player, friend].map((pet, index) => ({
    residentId: pet.id,
    pet: structuredClone(pet),
    position: { x: 2 + index, y: 4 },
    zoneId: 'plaza',
    availability: 'available',
  })),
  relationships: [],
  modifications: [],
  activities: [],
});
const showcase = PublicShowcaseItemSchema.parse({
  id: 'music-item',
  sessionId: 'session-1',
  kind: 'interest',
  title: '音乐',
  content: '主人和我喜欢听音乐',
  presetIconId: 'music',
  isPublic: true,
});

function context(message: string): TownAgentContext {
  return {
    sessionId: 'session-1',
    playerResidentId: player.id,
    playerMessage: message,
    projection,
    outingStatus: 'town',
    publicShowcaseItems: [showcase],
    recentEvents: [],
    recentMessages: ['我们去小镇看看'],
  };
}

describe('TownAgentService', () => {
  it.each([
    ['放它出去', 'release'],
    ['叫它回家', 'recall'],
    ['去和灰灰抽签', 'town-intent'],
    ['摆一个展示音乐兴趣的摊', 'town-intent'],
    ['一起修广场的灯', 'town-intent'],
  ] as const)(
    'turns %s into a validated %s decision',
    async (message, kind) => {
      const result = await new TownAgentService().decide(context(message));
      expect(result.decision.kind).toBe(kind);
      expect(TownDecisionSchema.parse(result.decision)).toEqual(
        result.decision,
      );
    },
  );

  it.each([
    {
      kind: 'town-intent',
      speech: '走吧',
      intent: {
        type: 'socialize',
        actorId: player.id,
        targetResidentId: 'unknown',
      },
    },
    {
      kind: 'town-intent',
      speech: '走吧',
      intent: { type: 'visit-zone', actorId: player.id, zoneId: 'moon' },
    },
    {
      kind: 'town-intent',
      speech: '开工',
      intent: {
        type: 'build',
        actorId: player.id,
        recipeId: 'castle',
        plotId: 'plot-1',
      },
    },
    {
      kind: 'town-intent',
      speech: '开摊',
      intent: {
        type: 'open-stall',
        actorId: player.id,
        stallId: 'stall-1',
        showcaseItemIds: ['private-item'],
      },
    },
  ])('rejects provider-selected unknown town IDs', async (decision) => {
    const provider: ProviderAdapter = { complete: async () => decision };
    const result = await new TownAgentService({ provider }).decide(
      context('随便逛逛'),
    );
    expect(result.degraded).toBe(true);
    expect(result.decision.kind).toBe('speak-only');
  });

  it('sends only public town state and bounded conversation to the provider', async () => {
    let request: ProviderCompletionRequest | undefined;
    const provider: ProviderAdapter = {
      complete: async (value) => {
        request = value;
        return { kind: 'speak-only', speech: '我先看看。' };
      },
    };
    await new TownAgentService({ provider }).decide({
      ...context('看看小镇'),
      recentMessages: ['PRIVATE_MEMORY: secret', '你好'],
    });
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain('PRIVATE_MEMORY');
    expect(serialized).not.toContain('secret');
    expect(request?.trustedInstructions[0]).toContain('town-decision.v1');
  });

  it('uses the same valid fallback when the provider is unavailable', async () => {
    const failing: ProviderAdapter = {
      complete: async () => {
        throw new Error('offline');
      },
    };
    const first = await new TownAgentService({ provider: failing }).decide(
      context('去和灰灰抽签'),
    );
    const second = await new TownAgentService({ provider: failing }).decide(
      context('去和灰灰抽签'),
    );
    expect(first).toEqual(second);
    expect(first.decision.kind).toBe('town-intent');
  });

  it('emits return speech before an optional new-card signal', async () => {
    const emit = vi.fn();
    const service = new TownAgentService({ emit });
    await service.announceReturn({
      recap: 'I played together.',
      cardId: 'card-1',
    });
    expect(emit.mock.calls).toEqual([
      ['town.return-speech', { speech: 'I played together.' }],
      ['town.experience-card-created', { cardId: 'card-1' }],
    ]);
  });
});
