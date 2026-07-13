import {
  ExperienceCardsResponseSchema,
  OfflineRecoveryRequestSchema,
  OfflineRecoveryResponseSchema,
  ShowcaseDeleteResponseSchema,
  ShowcaseListResponseSchema,
  ShowcaseUpsertRequestSchema,
  ShowcaseUpsertResponseSchema,
  TownAdvanceRequestSchema,
  TownAdvanceResponseSchema,
  TownEventResultsRequestSchema,
  TownEventResultsResponseSchema,
  TownHistoryResponseSchema,
  TownPulseRequestSchema,
  TownPulseResponseSchema,
  TownRecallRequestSchema,
  TownRecallResponseSchema,
  TownRelationshipsResponseSchema,
  TownReleaseRequestSchema,
  TownReleaseResponseSchema,
  TownSnapshotResponseSchema,
  type OfflineRecoveryRequest,
  type PublicShowcaseItem,
  type TownAdvanceRequest,
  type TownEventResultsRequest,
  type TownPulseRequest,
} from '@cat-house/shared';
import type { z } from 'zod';

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class TownHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'TownHttpError';
  }
}

export class TownApiClient {
  readonly #baseUrl: string;
  readonly #fetcher: Fetcher;
  readonly #resultRetryCount: number;

  constructor(
    options: {
      baseUrl?: string;
      fetcher?: Fetcher;
      resultRetryCount?: number;
    } = {},
  ) {
    this.#baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.#fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
    this.#resultRetryCount = options.resultRetryCount ?? 2;
  }

  snapshot(sessionId: string, signal?: AbortSignal) {
    return this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}/town`,
      TownSnapshotResponseSchema,
      signal,
    );
  }
  release(sessionId: string, residentId: string, signal?: AbortSignal) {
    return this.#post(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/release`,
      TownReleaseRequestSchema.parse({ sessionId, residentId }),
      TownReleaseResponseSchema,
      signal,
    );
  }
  recall(sessionId: string, residentId: string, signal?: AbortSignal) {
    return this.#post(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/recall`,
      TownRecallRequestSchema.parse({ sessionId, residentId }),
      TownRecallResponseSchema,
      signal,
    );
  }
  advance(request: TownAdvanceRequest, signal?: AbortSignal) {
    const value = TownAdvanceRequestSchema.parse(request);
    return this.#post(
      `/api/sessions/${encodeURIComponent(value.sessionId)}/town/advance`,
      value,
      TownAdvanceResponseSchema,
      signal,
    );
  }
  pulse(request: TownPulseRequest, signal?: AbortSignal) {
    const value = TownPulseRequestSchema.parse(request);
    return this.#post(
      `/api/sessions/${encodeURIComponent(value.sessionId)}/town/pulse`,
      value,
      TownPulseResponseSchema,
      signal,
    );
  }
  recover(request: OfflineRecoveryRequest, signal?: AbortSignal) {
    const value = OfflineRecoveryRequestSchema.parse(request);
    return this.#post(
      `/api/sessions/${encodeURIComponent(value.sessionId)}/town/recover`,
      value,
      OfflineRecoveryResponseSchema,
      signal,
    );
  }
  history(sessionId: string, signal?: AbortSignal) {
    return this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/history`,
      TownHistoryResponseSchema,
      signal,
    );
  }
  relationships(sessionId: string, signal?: AbortSignal) {
    return this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/relationships`,
      TownRelationshipsResponseSchema,
      signal,
    );
  }
  experienceCards(sessionId: string, signal?: AbortSignal) {
    return this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/experience-cards`,
      ExperienceCardsResponseSchema,
      signal,
    );
  }
  listShowcase(sessionId: string, signal?: AbortSignal) {
    return this.#get(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/showcase`,
      ShowcaseListResponseSchema,
      signal,
    );
  }

  upsertShowcase(
    sessionId: string,
    item: PublicShowcaseItem,
    signal?: AbortSignal,
  ) {
    const request = ShowcaseUpsertRequestSchema.parse({ item });
    return this.#request(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/showcase/${encodeURIComponent(item.id)}`,
      {
        method: 'PUT',
        headers: jsonHeaders,
        body: JSON.stringify(request),
        ...(signal ? { signal } : {}),
      },
      ShowcaseUpsertResponseSchema,
    );
  }

  deleteShowcase(sessionId: string, itemId: string, signal?: AbortSignal) {
    return this.#request(
      `/api/sessions/${encodeURIComponent(sessionId)}/town/showcase/${encodeURIComponent(itemId)}`,
      { method: 'DELETE', ...(signal ? { signal } : {}) },
      ShowcaseDeleteResponseSchema,
    );
  }

  async deliverEventResults(
    request: TownEventResultsRequest,
    signal?: AbortSignal,
  ) {
    const value = TownEventResultsRequestSchema.parse(request);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#post(
          `/api/sessions/${encodeURIComponent(value.sessionId)}/town/event-results`,
          value,
          TownEventResultsResponseSchema,
          signal,
        );
      } catch (error) {
        if (
          signal?.aborted ||
          attempt >= this.#resultRetryCount ||
          (error instanceof TownHttpError && error.status < 500)
        )
          throw error;
      }
    }
  }

  #get<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return this.#request(path, signal ? { signal } : {}, schema);
  }
  #post<T>(
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) {
    const payload = { ...(body as Record<string, unknown>) };
    delete payload.sessionId;
    return this.#request(
      path,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
      },
      schema,
    );
  }
  async #request<T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const response = await this.#fetcher(`${this.#baseUrl}${path}`, init);
    const payload: unknown = await response.json();
    if (!response.ok)
      throw new TownHttpError(response.status, errorText(payload));
    return schema.parse(payload);
  }
}

const jsonHeaders = { 'content-type': 'application/json' };
const errorText = (payload: unknown) =>
  typeof payload === 'object' &&
  payload !== null &&
  'message' in payload &&
  typeof payload.message === 'string'
    ? payload.message
    : 'Town request failed';
