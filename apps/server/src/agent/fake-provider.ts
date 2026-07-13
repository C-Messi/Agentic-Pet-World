import {
  IdentifierSchema,
  TownZoneIdSchema,
  type AgentDecision,
} from '@cat-house/shared';
import { z } from 'zod';

import {
  ProviderError,
  type ProviderAdapter,
  type ProviderCompletionRequest,
} from './provider.js';

const WINDOW_DECISION: AgentDecision = {
  speech: 'I will take a look by the window.',
  thought: 'The light by the glass looks warm and interesting.',
  emotion: 'curious',
  actions: [
    {
      id: 'fake-window-move',
      type: 'move_to',
      targetId: 'window',
      timeoutMs: 8_000,
    },
  ],
  memoryCandidates: [
    {
      content: 'The player asked me to visit the window.',
      importance: 0.8,
      reason: 'A clear preference for exploring the room together.',
    },
  ],
};

const BED_DECISION: AgentDecision = {
  speech: 'A soft bed sounds good right now.',
  emotion: 'happy',
  actions: [
    {
      id: 'fake-bed-move',
      type: 'move_to',
      targetId: 'bed',
      timeoutMs: 8_000,
    },
  ],
};

const ARCADE_DECISION: AgentDecision = {
  speech: 'The arcade games are coming soon. I can admire the cabinet for now.',
  emotion: 'curious',
  actions: [
    {
      id: 'fake-arcade-move',
      type: 'move_to',
      targetId: 'arcade',
      timeoutMs: 8_000,
    },
    {
      id: 'fake-arcade-open',
      type: 'interact',
      targetId: 'arcade',
      interaction: 'open',
    },
  ],
};

const GENERAL_DECISION: AgentDecision = {
  speech: 'I am listening. Let us enjoy the room together.',
  emotion: 'happy',
  actions: [],
};

const RESIDENT_DECISION_CONTRACT = '[Output Contract: resident-decision.v1]';
const RESIDENT_REPLY_CONTRACT =
  '[Output Contract: resident-encounter-reply.v1]';
const AUTHORITATIVE_TOWN_STATE = '[Authoritative Public Town State]\n';
const MAX_AUTHORITATIVE_CONTEXT_LENGTH = 20_000;
const ResidentCandidateSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('socialize'),
      actorId: IdentifierSchema,
      targetResidentId: IdentifierSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('visit-zone'),
      actorId: IdentifierSchema,
      zoneId: TownZoneIdSchema,
    })
    .strict(),
]);
const AuthoritativeCandidateContextSchema = z.object({
  allowedCandidates: z.array(ResidentCandidateSchema).max(16),
});
const RESIDENT_REPLIES = {
  'player-cat': { speech: 'Let us take a look.', animation: 'curious' },
  'resident-mikan': {
    speech: 'What could this become?',
    animation: 'curious',
  },
  'resident-huihui': { speech: 'There is time.', animation: 'sit' },
  'resident-lanlan': { speech: 'Watch this!', animation: 'happy' },
  'resident-doubao': { speech: 'I can build that.', animation: 'confused' },
} as const;
type ResidentId = keyof typeof RESIDENT_REPLIES;

export class FakeProvider implements ProviderAdapter {
  public async complete(request: ProviderCompletionRequest): Promise<unknown> {
    const residentOutput = residentCompletion(request);
    if (residentOutput !== undefined) return residentOutput;

    const latestMessage =
      request.messages.at(-1)?.content.toLocaleLowerCase() ?? '';
    if (latestMessage.includes('hold this turn for cancellation')) {
      return waitForCancellation(request.signal, request.correlationId);
    }
    if (latestMessage.includes('window')) {
      return WINDOW_DECISION;
    }
    if (latestMessage.includes('bed')) {
      return BED_DECISION;
    }
    if (latestMessage.includes('arcade')) {
      return ARCADE_DECISION;
    }
    return GENERAL_DECISION;
  }
}

function residentCompletion(
  request: ProviderCompletionRequest,
): unknown | undefined {
  const decisionContract = request.trustedInstructions.some((instruction) =>
    instruction.startsWith(RESIDENT_DECISION_CONTRACT),
  );
  const replyContract = request.trustedInstructions.some((instruction) =>
    instruction.startsWith(RESIDENT_REPLY_CONTRACT),
  );
  if (!decisionContract && !replyContract) return undefined;

  const residentId = residentIdentity(request.trustedInstructions);
  if (residentId === undefined) return undefined;
  const identity = RESIDENT_REPLIES[residentId];
  if (replyContract) {
    return {
      speech: identity.speech,
      animation: identity.animation,
      followUpRequested: false,
    };
  }

  const candidates = authoritativeCandidates(
    request.trustedInstructions,
    residentId,
  );
  if (candidates.length === 0) {
    return { kind: 'rest', speech: identity.speech };
  }
  return {
    kind: 'candidate',
    candidateIndex: stableHash(residentId) % candidates.length,
    speech: identity.speech,
  };
}

function residentIdentity(
  trustedInstructions: readonly string[],
): ResidentId | undefined {
  for (const instruction of trustedInstructions) {
    if (instruction.length > 1_999) continue;
    const match =
      /(?:^| \|\| )Pet ID: ([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?: \|\| |$)/u.exec(
        instruction,
      );
    if (match?.[1] !== undefined && match[1] in RESIDENT_REPLIES) {
      return match[1] as ResidentId;
    }
  }
  return undefined;
}

function authoritativeCandidates(
  trustedInstructions: readonly string[],
  residentId: ResidentId,
): z.infer<typeof ResidentCandidateSchema>[] {
  const instruction = trustedInstructions.find((value) =>
    value.startsWith(AUTHORITATIVE_TOWN_STATE),
  );
  if (
    instruction === undefined ||
    instruction.length > MAX_AUTHORITATIVE_CONTEXT_LENGTH
  ) {
    return [];
  }
  try {
    const context = AuthoritativeCandidateContextSchema.parse(
      JSON.parse(instruction.slice(AUTHORITATIVE_TOWN_STATE.length)),
    );
    return context.allowedCandidates.filter(
      (candidate) => candidate.actorId === residentId,
    );
  } catch {
    return [];
  }
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return Math.abs(hash);
}

async function waitForCancellation(
  signal: AbortSignal,
  correlationId: string,
): Promise<never> {
  if (signal.aborted) throw new ProviderError('cancelled', { correlationId });
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new ProviderError('cancelled', { correlationId })),
      { once: true },
    );
  });
  throw new ProviderError('cancelled', { correlationId });
}
