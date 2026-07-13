import {
  IdentifierSchema,
  PetDefinitionSchema,
  TOWN_ENCOUNTER_PAIRS,
  TOWN_ZONE_ORDER,
  TownEventSchema,
  TownProjectionSchema,
  TownZoneIdSchema,
  type PetDefinition,
  type TownEvent,
  type TownIntent,
  type TownProjection,
} from '@cat-house/shared';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import type {
  ProviderAdapter,
  ProviderCompletionRequest,
  UntrustedProviderContext,
} from '../agent/provider.js';
import { createAuthoredPetDefinitions } from './residents.js';

const GraphemeSegmenter = new Intl.Segmenter('en', {
  granularity: 'grapheme',
});
const SpeechSchema = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .refine((value) => graphemeCount(value) <= 80, {
    message: 'Speech must contain at most 80 grapheme clusters',
  });

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
  readonly candidates: readonly TownIntent[];
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ResidentResponseContext {
  readonly residentId: string;
  readonly opening: string;
  readonly initiatorId: string;
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
}

export interface ResidentFollowUpContext {
  readonly residentId: string;
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
const ResidentCandidateSchema = z
  .discriminatedUnion('type', [
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
  ])
  .superRefine((candidate, context) => {
    if (
      candidate.type === 'socialize' &&
      candidate.actorId === candidate.targetResidentId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A resident cannot socialize with itself',
        path: ['targetResidentId'],
      });
    }
  });
const SharedContextFields = {
  residentId: IdentifierSchema,
  projection: TownProjectionSchema,
  recentEvents: EventsSchema,
  signal: SignalSchema,
  correlationId: IdentifierSchema.max(96),
};
const ResidentDecisionContextSchema = z
  .object({
    ...SharedContextFields,
    candidates: z.array(ResidentCandidateSchema).max(16),
  })
  .strict()
  .superRefine(({ residentId, candidates }, context) => {
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
  .strict();
const ResidentFollowUpContextSchema = z
  .object({
    ...SharedContextFields,
    opening: SpeechSchema,
    reply: SpeechSchema,
    responderId: IdentifierSchema,
  })
  .strict();

const AuthoredPetDefinitions = deepFreeze(
  createAuthoredPetDefinitions().map((pet) =>
    PetDefinitionSchema.parse(structuredClone(pet)),
  ),
);
const AuthoredPetsByResidentId: ReadonlyMap<string, PetDefinition> = new Map(
  AuthoredPetDefinitions.map((pet) => [pet.id, pet]),
);

export const RESIDENT_DECISION_OUTPUT_CONTRACT_V1 = `[Output Contract: resident-decision.v1]
Return exactly one strict JSON object.
Use {"kind":"rest","speech":"1-80 characters"} or {"kind":"candidate","candidateIndex":0,"speech":"1-80 characters"}.
candidateIndex must identify one of the authoritative allowedCandidates and must never be invented.`;

export const ENCOUNTER_REPLY_OUTPUT_CONTRACT_V1 = `[Output Contract: resident-encounter-reply.v1]
Return exactly one strict JSON object with speech (1-80 characters), animation (curious, happy, sit, or confused), and followUpRequested (true or false), with no additional fields.
Set followUpRequested to true only when a short third round would be meaningful; otherwise use false.`;

export function buildResidentSystemPrompt(source: PetDefinition): string {
  const pet = PetDefinitionSchema.parse(source);
  return [
    'You are one authored Pet Town resident. Speak and choose consistently with this public identity.',
    `Name: ${pet.displayName}`,
    `Pet ID: ${pet.id}`,
    `Species: ${pet.species}`,
    `Personality: ${JSON.stringify(pet.personality)}`,
    `Voice: ${pet.voice.style}`,
    `Catchphrases: ${JSON.stringify(pet.voice.catchphrases.map(boundPromptText))}`,
    `Interests: ${JSON.stringify(pet.interests.map(boundPromptText))}`,
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
    const pet = requireAuthoredResident(context);
    validateDecisionSemantics(context);
    throwIfAborted(context.signal);
    const fallback = deterministicDecision(context, pet);
    if (!this.provider) return { decision: fallback, degraded: true };

    try {
      const output = await completeProvider(
        this.provider,
        providerRequest(
          context,
          pet,
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
    const pet = requireAuthoredResident(context);
    requireEncounterCounterpart(context, context.initiatorId);
    return this.completeReply(
      context,
      pet,
      [{ source: 'messages', content: context.opening }],
      deterministicReply(pet, false),
    );
  }

  public async followUp(
    source: ResidentFollowUpContext,
  ): Promise<EncounterReplyResult> {
    const context = ResidentFollowUpContextSchema.parse(source);
    const pet = requireAuthoredResident(context);
    requireEncounterCounterpart(context, context.responderId);
    return this.completeReply(
      context,
      pet,
      [
        {
          source: 'messages',
          content: JSON.stringify({
            opening: context.opening,
            reply: context.reply,
          }),
        },
      ],
      deterministicReply(pet, true),
    );
  }

  private async completeReply(
    context: ParsedSharedContext,
    pet: PetDefinition,
    untrustedContext: readonly UntrustedProviderContext[],
    fallback: EncounterReply,
  ): Promise<EncounterReplyResult> {
    throwIfAborted(context.signal);
    if (!this.provider) return { reply: fallback, degraded: true };

    try {
      const output = await completeProvider(
        this.provider,
        providerRequest(
          context,
          pet,
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
  readonly projection: TownProjection;
  readonly recentEvents: readonly TownEvent[];
  readonly signal: AbortSignal;
  readonly correlationId: string;
};

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function requireAuthoredResident(context: ParsedSharedContext): PetDefinition {
  const residentIds = new Set(
    context.projection.residents.map(({ residentId }) => residentId),
  );
  for (const resident of context.projection.residents) {
    const authored = AuthoredPetsByResidentId.get(resident.residentId);
    if (authored === undefined) {
      throw new TypeError(`Unknown authored resident: ${resident.residentId}`);
    }
    if (!isDeepStrictEqual(resident.pet, authored)) {
      throw new TypeError(
        `Resident pet snapshot does not match authored definition: ${resident.residentId}`,
      );
    }
  }
  let previousSequence = 0;
  for (const event of context.recentEvents) {
    if (event.sessionId !== context.projection.sessionId) {
      throw new TypeError('Recent event session does not match projection');
    }
    if (event.participantIds.some((id) => !residentIds.has(id))) {
      throw new TypeError('Recent event references an unknown resident');
    }
    if (
      event.sequence <= previousSequence ||
      event.sequence > context.projection.lastEventSequence
    ) {
      throw new TypeError('Recent event sequence is inconsistent');
    }
    previousSequence = event.sequence;
  }

  const resident = context.projection.residents.find(
    ({ residentId }) => residentId === context.residentId,
  );
  if (resident === undefined) {
    throw new TypeError(
      `Resident is missing from projection: ${context.residentId}`,
    );
  }
  if (resident.availability !== 'available') {
    throw new TypeError(`Resident is unavailable: ${context.residentId}`);
  }
  return AuthoredPetsByResidentId.get(context.residentId)!;
}

function validateDecisionSemantics(
  context: z.infer<typeof ResidentDecisionContextSchema>,
): void {
  const resident = context.projection.residents.find(
    ({ residentId }) => residentId === context.residentId,
  )!;
  for (const candidate of context.candidates) {
    if (candidate.type === 'visit-zone') {
      if (candidate.zoneId === resident.zoneId) {
        throw new TypeError('Visit candidate must leave the current zone');
      }
      continue;
    }
    const target = context.projection.residents.find(
      ({ residentId }) => residentId === candidate.targetResidentId,
    );
    if (target === undefined || target.availability !== 'available') {
      throw new TypeError('Socialize target is missing or unavailable');
    }
  }
}

function requireEncounterCounterpart(
  context: ParsedSharedContext,
  counterpartId: string,
): void {
  if (counterpartId === context.residentId) {
    throw new TypeError('Encounter residents must be distinct');
  }
  if (
    !context.projection.residents.some(
      ({ residentId }) => residentId === counterpartId,
    )
  ) {
    throw new TypeError(`Encounter counterpart is missing: ${counterpartId}`);
  }
}

function providerRequest(
  context: ParsedSharedContext,
  pet: PetDefinition,
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
    recentEvents: context.recentEvents.slice(-8).map((event) => ({
      type: event.type,
      sequence: event.sequence,
      timestamp: event.timestamp,
      participantIds: event.participantIds,
      ...(event.zoneId === undefined ? {} : { zoneId: event.zoneId }),
    })),
  };
  return {
    trustedInstructions: [
      buildResidentSystemPrompt(pet),
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
  pet: PetDefinition,
): ResidentDecision {
  const speech = fallbackSpeech(pet, false);
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
  const catchphrase = pet.voice.catchphrases[followUp ? 1 : 0]?.trim();
  const residentSpecific = `${pet.displayName} pauses to consider the next step.`;
  const bounded = truncateGraphemes(catchphrase || residentSpecific, 80, 280);
  return SpeechSchema.parse(
    bounded || truncateGraphemes(residentSpecific, 80, 280),
  );
}

function boundPromptText(value: string): string {
  return truncateGraphemes(value, 80, 80);
}

function truncateGraphemes(
  value: string,
  maximumGraphemes: number,
  maximumCodeUnits: number,
): string {
  let bounded = '';
  let graphemes = 0;
  for (const { segment } of GraphemeSegmenter.segment(value.trim())) {
    if (
      graphemes >= maximumGraphemes ||
      bounded.length + segment.length > maximumCodeUnits
    ) {
      break;
    }
    bounded += segment;
    graphemes += 1;
  }
  return bounded;
}

function graphemeCount(value: string): number {
  return Array.from(GraphemeSegmenter.segment(value)).length;
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

function completeProvider(
  provider: ProviderAdapter,
  request: ProviderCompletionRequest,
): Promise<unknown> {
  throwIfAborted(request.signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      request.signal.removeEventListener('abort', onAbort);
    };
    const resolveOnce = (value: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(abortError());
    };

    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) {
      onAbort();
      return;
    }

    let completion: Promise<unknown>;
    try {
      completion = Promise.resolve(provider.complete(request));
    } catch (error) {
      completion = Promise.reject(error);
    }
    completion.then(resolveOnce, rejectOnce);
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError();
  }
}
