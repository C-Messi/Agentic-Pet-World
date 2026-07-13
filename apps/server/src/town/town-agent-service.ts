import {
  TownIntentSchema,
  type PublicShowcaseItem,
  type TownEvent,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { z } from 'zod';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
} from '../agent/provider.js';
import { BUILD_PLOTS, BUILD_RECIPES } from './build-recipes.js';

const Speech = z.string().trim().min(1).max(280);
export const TownDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('speak-only'), speech: Speech }).strict(),
  z
    .object({
      kind: z.literal('town-intent'),
      speech: Speech,
      intent: TownIntentSchema,
    })
    .strict(),
  z.object({ kind: z.literal('release'), speech: Speech }).strict(),
  z.object({ kind: z.literal('recall'), speech: Speech }).strict(),
]);
export type TownDecision = z.infer<typeof TownDecisionSchema>;

export const TOWN_DECISION_OUTPUT_CONTRACT_V1 = `[Output Contract: town-decision.v1]
Return exactly one JSON object with kind speak-only, town-intent, release, or recall.
All IDs must come from the authoritative allowed metadata. Never invent coordinates, events, tools, SQL, or asset paths.`;

export interface TownAgentContext {
  readonly sessionId: string;
  readonly playerResidentId: string;
  readonly playerMessage: string;
  readonly projection: TownProjection;
  readonly outingStatus: 'home' | 'town' | 'returning';
  readonly publicShowcaseItems: readonly PublicShowcaseItem[];
  readonly recentEvents: readonly TownEvent[];
  readonly recentMessages: readonly string[];
}
export type TownClientEvent =
  | ['town.return-speech', { readonly speech: string }]
  | ['town.experience-card-created', { readonly cardId: string }];
export interface TownAgentDependencies {
  readonly provider?: ProviderAdapter;
  readonly emit?: (...event: TownClientEvent) => void;
}

export class TownAgentService {
  constructor(private readonly dependencies: TownAgentDependencies = {}) {}

  async decide(
    source: TownAgentContext,
  ): Promise<{ decision: TownDecision; degraded: boolean }> {
    const fallback = deterministicDecision(source);
    if (!this.dependencies.provider)
      return { decision: fallback, degraded: true };
    try {
      const output = await this.dependencies.provider.complete(
        providerRequest(source),
      );
      const parsed = TownDecisionSchema.parse(parseJson(output));
      validateDecision(parsed, source);
      return { decision: parsed, degraded: false };
    } catch {
      return { decision: fallback, degraded: true };
    }
  }

  async announceReturn(value: {
    readonly recap: string;
    readonly cardId?: string;
  }): Promise<void> {
    const speech = Speech.parse(value.recap);
    this.dependencies.emit?.('town.return-speech', { speech });
    if (value.cardId)
      this.dependencies.emit?.('town.experience-card-created', {
        cardId: value.cardId,
      });
  }
}

function deterministicDecision(context: TownAgentContext): TownDecision {
  const message = context.playerMessage;
  const actorId = context.playerResidentId;
  if (/放.*出去|去小镇|出门/.test(message))
    return { kind: 'release', speech: '好呀，我去小镇转转。' };
  if (/回家|回来|叫.*回/.test(message))
    return { kind: 'recall', speech: '我这就回家。' };
  const namedResident = context.projection.residents.find(
    ({ pet }) =>
      message
        .toLocaleLowerCase()
        .includes(pet.displayName.toLocaleLowerCase()) ||
      (pet.id === 'resident-huihui' && message.includes('灰灰')),
  );
  if (/抽签|签运|玄学/.test(message)) {
    return {
      kind: 'town-intent',
      speech: '走，我们一起去抽签。',
      intent: {
        type: 'start-activity',
        actorId,
        activityId: 'fortune-draw',
        invitedResidentIds: namedResident ? [namedResident.residentId] : [],
      },
    };
  }
  if (/摆.*摊|开.*摊|展示/.test(message)) {
    const item =
      context.publicShowcaseItems.find(
        (value) =>
          message.includes(value.title) || message.includes(value.content),
      ) ?? context.publicShowcaseItems[0];
    if (item)
      return {
        kind: 'town-intent',
        speech: '我来摆一个有我们风格的小摊。',
        intent: {
          type: 'open-stall',
          actorId,
          stallId: 'market-stall-1',
          showcaseItemIds: [item.id],
        },
      };
  }
  if (/修.*灯|广场.*灯|路灯/.test(message))
    return {
      kind: 'town-intent',
      speech: '一起把广场的灯修好。',
      intent: {
        type: 'build',
        actorId,
        recipeId: 'street-lamp',
        plotId: 'plaza-north',
      },
    };
  return { kind: 'speak-only', speech: '我先在小镇看看，再告诉你新鲜事。' };
}

function providerRequest(context: TownAgentContext): ProviderCompletionRequest {
  const allowed = {
    residentIds: context.projection.residents.map(
      ({ residentId }) => residentId,
    ),
    zoneIds: [
      'gate',
      'plaza',
      'fortune-pavilion',
      'market',
      'garden',
      'build-plots',
      'arcade-house',
    ],
    activityIds: ['fortune-draw', 'social-play'],
    recipeIds: BUILD_RECIPES.map(({ id }) => id),
    plotIds: BUILD_PLOTS.map(({ id }) => id),
    showcaseItemIds: context.publicShowcaseItems.map(({ id }) => id),
  };
  const publicState = {
    sessionId: context.sessionId,
    playerResidentId: context.playerResidentId,
    outingStatus: context.outingStatus,
    projection: context.projection,
    publicShowcaseItems: context.publicShowcaseItems,
    recentEvents: context.recentEvents.slice(-8),
    allowed,
  };
  return {
    trustedInstructions: [
      TOWN_DECISION_OUTPUT_CONTRACT_V1,
      `[Authoritative Town State]\n${JSON.stringify(publicState)}`,
    ],
    untrustedContext: [
      {
        source: 'messages',
        content: JSON.stringify(
          context.recentMessages
            .filter((message) => !message.startsWith('PRIVATE_MEMORY:'))
            .slice(-8),
        ),
      },
    ],
    messages: [{ role: 'user', content: context.playerMessage }],
    signal: new AbortController().signal,
    correlationId: `town-${context.sessionId}-${context.projection.version}`,
  };
}

function validateDecision(
  decision: TownDecision,
  context: TownAgentContext,
): void {
  if (decision.kind !== 'town-intent') return;
  const intent: TownIntent = decision.intent;
  if (intent.actorId !== context.playerResidentId)
    throw new Error('Town intent actor mismatch');
  const residents = new Set(
    context.projection.residents.map(({ residentId }) => residentId),
  );
  if (intent.type === 'socialize' && !residents.has(intent.targetResidentId))
    throw new Error('Unknown resident');
  if (intent.type === 'start-activity') {
    if (!['fortune-draw', 'social-play'].includes(intent.activityId))
      throw new Error('Unknown activity');
    if (intent.invitedResidentIds.some((id) => !residents.has(id)))
      throw new Error('Unknown invited resident');
  }
  if (intent.type === 'build') {
    const recipe = BUILD_RECIPES.find(({ id }) => id === intent.recipeId);
    if (!recipe || !recipe.allowedPlotIds.includes(intent.plotId))
      throw new Error('Unknown build selection');
  }
  if (intent.type === 'open-stall') {
    const items = new Set(context.publicShowcaseItems.map(({ id }) => id));
    if (intent.showcaseItemIds.some((id) => !items.has(id)))
      throw new Error('Unknown public showcase item');
  }
}

function parseJson(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}
