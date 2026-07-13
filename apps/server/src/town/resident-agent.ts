import {
  IdentifierSchema,
  PetDefinitionSchema,
  TOWN_ENCOUNTER_PAIRS,
  TOWN_ZONE_ORDER,
  TownEventSchema,
  TownIntentSchema,
  TownProjectionSchema,
  type PetDefinition,
  type TownEvent,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { z } from 'zod';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
  UntrustedProviderContext,
} from '../agent/provider.js';

const SpeechSchema = z.string().trim().min(1).max(80);

export const ResidentDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rest'), speech: SpeechSchema }).strict(),
  z
    .object({
      kind: z.literal('candidate'),
      candidateIndex: z.number().int().min(0).max(15),
      speech: SpeechSchema,
    })
    .strict(),
]);
export type ResidentDecision = z.infer<typeof ResidentDecisionSchema>;

export const EncounterReplySchema = z
  .object({
    speech: SpeechSchema,
    animation: z.enum(['curious', 'happy', 'sit', 'confused']),
    followUpRequested: z.boolean(),
  })
  .strict();
export type EncounterReply = z.infer<typeof EncounterReplySchema>;

export interface ResidentDecisionContext {
  readonly residentId: string;
  readonly pet: PetDefinition;
  readonly candidates: readonly TownIntent[];
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ResidentResponseContext {
  readonly residentId: string;
  readonly pet: PetDefinition;
  readonly opening: string;
  readonly initiatorId: string;
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ResidentFollowUpContext {
  readonly residentId: string;
  readonly pet: PetDefinition;
  readonly opening: string;
  readonly reply: string;
  readonly responderId: string;
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ResidentDecisionResult {
  readonly decision: ResidentDecision;
  readonly degraded: boolean;
}

export interface EncounterReplyResult {
  readonly reply: EncounterReply;
  readonly degraded: boolean;
}

const SignalSchema = z.custom<AbortSignal>(
  (value) => typeof AbortSignal !== 'undefined' && value instanceof AbortSignal,
  'Expected an AbortSignal',
);
const EventsSchema = z.array(TownEventSchema).max(8);
const SharedContextFields = {
  residentId: IdentifierSchema,
  pet: PetDefinitionSchema,
  projection: TownProjectionSchema,
  recentEvents: EventsSchema,
  signal: SignalSchema,
  correlationId: IdentifierSchema.max(96),
};
const ResidentDecisionContextSchema = z
  .object({
    ...SharedContextFields,
    candidates: z.array(TownIntentSchema).max(16),
  })
  .strict()
  .superRefine(({ residentId, pet, candidates }, context) => {
    if (pet.id !== residentId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resident pet identity does not match residentId',
        path: ['pet', 'id'],
      });
    }
    for (const [index, candidate] of candidates.entries()) {
      if (candidate.actorId !== residentId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Candidate actor does not match residentId',
          path: ['candidates', index, 'actorId'],
        });
      }
    }
  });
const ResidentResponseContextSchema = z
  .object({
    ...SharedContextFields,
    opening: SpeechSchema,
    initiatorId: IdentifierSchema,
  })
  .strict()
  .superRefine(validateResidentIdentity);
const ResidentFollowUpContextSchema = z
  .object({
    ...SharedContextFields,
    opening: SpeechSchema,
    reply: SpeechSchema,
    responderId: IdentifierSchema,
  })
  .strict()
  .superRefine(validateResidentIdentity);

export const RESIDENT_DECISION_OUTPUT_CONTRACT_V1 = `[Output Contract: resident-decision.v1]
Return exactly one strict JSON object.
Use {"kind":"rest","speech":"1-80 characters"} or {"kind":"candidate","candidateIndex":0,"speech":"1-80 characters"}.
candidateIndex must identify one of the authoritative allowedCandidates and must never be invented.`;

export const ENCOUNTER_REPLY_OUTPUT_CONTRACT_V1 = `[Output Contract: resident-encounter-reply.v1]
Return exactly {"speech":"1-80 characters","animation":"curious|happy|sit|confused","followUpRequested":false} as strict JSON with no additional fields.`;

export function buildResidentSystemPrompt(source: PetDefinition): string {
  const pet = PetDefinitionSchema.parse(source);
  return [
    'You are one authored Pet Town resident. Speak and choose consistently with this public identity.',
    `Name: ${pet.displayName}`,
    `Pet ID: ${pet.id}`,
    `Species: ${pet.species}`,
    `Personality: ${JSON.stringify(pet.personality)}`,
    `Voice: ${pet.voice.style}`,
    `Catchphrases: ${JSON.stringify(pet.voice.catchphrases)}`,
    `Interests: ${JSON.stringify(pet.interests)}`,
    `Public bio: ${pet.publicBio}`,
    'Choose only an enumerated candidate. Never invent IDs, coordinates, events, tools, or private owner facts.',
  ].join('\n');
}

export class ResidentAgent {
  public constructor(private readonly provider?: ProviderAdapter) {}

  public async decide(
    source: ResidentDecisionContext,
  ): Promise<ResidentDecisionResult> {
    const context = ResidentDecisionContextSchema.parse(source);
    throwIfAborted(context.signal);
    const fallback = deterministicDecision(context);
    if (!this.provider) return { decision: fallback, degraded: true };

    try {
      const output = await this.provider.complete(
        providerRequest(
          context,
          RESIDENT_DECISION_OUTPUT_CONTRACT_V1,
          [],
          context.candidates,
        ),
      );
      throwIfAborted(context.signal);
      const decision = ResidentDecisionSchema.parse(parseJson(output));
      if (
        decision.kind === 'candidate' &&
        decision.candidateIndex >= context.candidates.length
      ) {
        throw new Error('Candidate index is outside the authoritative list');
      }
      return { decision, degraded: false };
    } catch {
      throwIfAborted(context.signal);
      return { decision: fallback, degraded: true };
    }
  }

  public async respond(
    source: ResidentResponseContext,
  ): Promise<EncounterReplyResult> {
    const context = ResidentResponseContextSchema.parse(source);
    return this.completeReply(
      context,
      [{ source: 'messages', content: context.opening }],
      deterministicReply(context.pet, false),
    );
  }

  public async followUp(
    source: ResidentFollowUpContext,
  ): Promise<EncounterReplyResult> {
    const context = ResidentFollowUpContextSchema.parse(source);
    return this.completeReply(
      context,
      [
        {
          source: 'messages',
          content: JSON.stringify({
            opening: context.opening,
            reply: context.reply,
          }),
        },
      ],
      deterministicReply(context.pet, true),
    );
  }

  private async completeReply(
    context: ParsedSharedContext,
    untrustedContext: readonly UntrustedProviderContext[],
    fallback: EncounterReply,
  ): Promise<EncounterReplyResult> {
    throwIfAborted(context.signal);
    if (!this.provider) return { reply: fallback, degraded: true };

    try {
      const output = await this.provider.complete(
        providerRequest(
          context,
          ENCOUNTER_REPLY_OUTPUT_CONTRACT_V1,
          untrustedContext,
        ),
      );
      throwIfAborted(context.signal);
      return {
        reply: EncounterReplySchema.parse(parseJson(output)),
        degraded: false,
      };
    } catch {
      throwIfAborted(context.signal);
      return { reply: fallback, degraded: true };
    }
  }
}

type ParsedSharedContext = {
  readonly residentId: string;
  readonly pet: PetDefinition;
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
};

function validateResidentIdentity(
  value: { readonly residentId: string; readonly pet: PetDefinition },
  context: z.RefinementCtx,
): void {
  if (value.pet.id !== value.residentId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Resident pet identity does not match residentId',
      path: ['pet', 'id'],
    });
  }
}

function providerRequest(
  context: ParsedSharedContext,
  outputContract: string,
  untrustedContext: readonly UntrustedProviderContext[],
  candidates: readonly TownIntent[] = [],
): ProviderCompletionRequest {
  const publicState = {
    projection: {
      sessionId: context.projection.sessionId,
      version: context.projection.version,
      lastEventSequence: context.projection.lastEventSequence,
      residents: context.projection.residents.map(
        ({ residentId, pet, zoneId, availability }) => ({
          residentId,
          petId: pet.id,
          name: pet.displayName,
          zoneId,
          availability,
        }),
      ),
      relationships: context.projection.relationships.map(
        ({ residentIdA, residentIdB, affinity }) => ({
          residentIdA,
          residentIdB,
          affinity,
        }),
      ),
      zoneCapacity: Object.fromEntries(
        TOWN_ZONE_ORDER.map((zoneId) => [
          zoneId,
          TOWN_ENCOUNTER_PAIRS[zoneId].length * 2,
        ]),
      ),
    },
    allowedCandidates: candidates,
    recentEvents: context.recentEvents,
  };
  return {
    trustedInstructions: [
      buildResidentSystemPrompt(context.pet),
      outputContract,
      `[Authoritative Public Town State]\n${JSON.stringify(publicState)}`,
    ],
    untrustedContext,
    messages: [],
    signal: context.signal,
    correlationId: context.correlationId,
  };
}

function deterministicDecision(
  context: z.infer<typeof ResidentDecisionContextSchema>,
): ResidentDecision {
  const speech = fallbackSpeech(context.pet, false);
  if (context.candidates.length === 0) {
    return ResidentDecisionSchema.parse({ kind: 'rest', speech });
  }
  return ResidentDecisionSchema.parse({
    kind: 'candidate',
    candidateIndex:
      stableHash(
        `${context.residentId}:${context.projection.version}:${JSON.stringify(context.candidates)}`,
      ) % context.candidates.length,
    speech,
  });
}

function deterministicReply(
  pet: PetDefinition,
  followUp: boolean,
): EncounterReply {
  const animation =
    pet.personality.curiosity >= 0.75
      ? 'curious'
      : pet.personality.playfulness >= 0.75
        ? 'happy'
        : pet.personality.sociability >= 0.75
          ? 'sit'
          : 'confused';
  return EncounterReplySchema.parse({
    speech: fallbackSpeech(pet, followUp),
    animation,
    followUpRequested: false,
  });
}

function fallbackSpeech(pet: PetDefinition, followUp: boolean): string {
  const catchphrase = pet.voice.catchphrases[followUp ? 1 : 0];
  return SpeechSchema.parse(
    catchphrase ?? `${pet.displayName} pauses to consider the next step.`,
  );
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function parseJson(output: unknown): unknown {
  if (typeof output !== 'string') return output;
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('The operation was aborted', 'AbortError');
  }
}
