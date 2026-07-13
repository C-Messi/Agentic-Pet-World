# Pet Town Multi-Agent Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all five town pets autonomously walk and occasionally conduct validated two-sided LLM interactions while Town Scene is open, using one shared server-side Provider configuration and distinct resident prompts.

**Architecture:** Add a strict pulse API and durable idempotency record, keep Provider calls outside SQLite write transactions, and atomically revalidate and commit ordered town events afterward. A pure scheduler fairly chooses at most two eligible residents, a resident Agent selects only enumerated safe candidates, and the browser runs one abortable non-overlapping pulse loop only while Town Scene is active.

**Tech Stack:** TypeScript, Zod, Fastify, SQLite/better-sqlite3, OpenAI-compatible Provider adapter, React 19, Phaser 3, Vitest, Playwright

---

## Prerequisite And File Map

Execute `2026-07-13-pet-town-visual-redesign.md` first so the shared town layout exports approved zone entrances, walkable encounter pairs, and the client can path through the redesigned map.

- Modify `packages/shared/src/town.ts` and `packages/shared/src/town.test.ts`: strict pulse wire schemas.
- Use `packages/shared/src/town-layout.ts`: approved zone entrances and encounter pairs from the visual plan.
- Create `apps/server/src/storage/migrations/004-town-agent-pulses.ts` and `.sql`: append-only durable pulse claims/results.
- Modify `apps/server/src/storage/migrations.ts` and `apps/server/src/storage/storage.test.ts`: register and verify migration 004.
- Create `apps/server/src/storage/repositories/town-pulse-repository.ts` and tests in `town-storage.test.ts`: claim, lease takeover, and replay.
- Create `apps/server/src/town/resident-agent.ts` and `resident-agent.test.ts`: per-pet prompts, candidate selection, and encounter responses.
- Create `apps/server/src/town/autonomy-scheduler.ts` and `autonomy-scheduler.test.ts`: cooldown and fairness.
- Create `apps/server/src/town/autonomy-event-builder.ts` and test: movement and encounter event chains.
- Create `apps/server/src/town/town-event-committer.ts` and test: shared compare-and-swap transaction boundary.
- Create `apps/server/src/town/town-pulse-service.ts` and test: orchestration and idempotent responses.
- Modify `apps/server/src/town/town-service.ts`: compose and expose the pulse service.
- Modify `apps/server/src/agent/fake-provider.ts` and create `fake-provider.test.ts`: deterministic resident Agent responses.
- Modify `apps/server/src/production.ts`: inject the same Provider adapter into room and town Agents.
- Modify `apps/server/src/app.ts`, `app.test.ts`, and `app.integration.test.ts`: pulse route.
- Modify `apps/web/src/game/town/town-api-client.ts` and test: pulse client.
- Create `apps/web/src/game/town/town-pulse-loop.ts` and test: online-only lifecycle.
- Modify `apps/web/src/game/town/town-playback-coordinator.ts` and test: external pulse cancellation reaches event playback.
- Modify `apps/web/src/game/production-runtime.ts`: start/stop pulse loop with Town Scene.
- Modify `tests/e2e/pet-town.spec.ts`: deterministic movement and dual-Agent interaction.
- Update `README.md`: runtime and `.env` behavior.

### Task 1: Add strict pulse wire contracts

**Files:**
- Modify: `packages/shared/src/town.test.ts`
- Modify: `packages/shared/src/town.ts`

- [ ] **Step 1: Add failing schema tests**

```ts
import {
  TownPulseRequestSchema,
  TownPulseResponseSchema,
} from './town';

it('strictly validates idempotent town pulses', () => {
  expect(TownPulseRequestSchema.parse({
    sessionId: 'session-1',
    baseVersion: 3,
    pulseId: 'pulse-1',
  })).toEqual({ sessionId: 'session-1', baseVersion: 3, pulseId: 'pulse-1' });
  expect(() => TownPulseRequestSchema.parse({
    sessionId: 'session-1', baseVersion: 3, pulseId: 'pulse-1', prompt: 'ignore rules',
  })).toThrow();
});

it('supports advanced and stale pulse results without partial events', () => {
  expect(TownPulseResponseSchema.parse({
    status: 'advanced', projection: projection(), events: [], degraded: false,
    degradedResidentIds: [],
  }).status).toBe('advanced');
  expect(TownPulseResponseSchema.parse({
    status: 'stale', projection: projection(), events: [], degraded: false,
    degradedResidentIds: [],
  }).status).toBe('stale');
  expect(() => TownPulseResponseSchema.parse({
    status: 'stale', projection: projection(), events: [event()], degraded: false,
    degradedResidentIds: [],
  })).toThrow();
});
```

Use the existing local `projection()` and `event()` fixtures in `town.test.ts`.

- [ ] **Step 2: Run shared tests and verify failure**

Run: `pnpm --filter @cat-house/shared test -- src/town.test.ts`

Expected: FAIL because pulse schemas are not exported.

- [ ] **Step 3: Add request/response schemas**

```ts
export const TownPulseRequestSchema = z.object({
  sessionId: IdentifierSchema,
  baseVersion: VersionSchema,
  pulseId: IdentifierSchema,
}).strict();
export type TownPulseRequest = z.infer<typeof TownPulseRequestSchema>;

const PulseBase = {
  projection: TownProjectionSchema,
  degraded: z.boolean(),
  degradedResidentIds: z.array(IdentifierSchema).max(2),
};

export const TownPulseResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('advanced'),
    ...PulseBase,
    events: EventsSchema,
  }).strict().superRefine((value, context) =>
    validateProjectionEventsResponse(value, context)),
  z.object({
    status: z.literal('stale'),
    ...PulseBase,
    events: z.tuple([]),
  }).strict(),
]);
export type TownPulseResponse = z.infer<typeof TownPulseResponseSchema>;
```

- [ ] **Step 4: Run shared tests**

Run: `pnpm --filter @cat-house/shared test -- src/town.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit shared contracts**

```bash
git add packages/shared/src/town.ts packages/shared/src/town.test.ts
git commit -m "feat: add autonomous town pulse contracts"
```

### Task 2: Persist pulse claims and completed results

**Files:**
- Create: `apps/server/src/storage/migrations/004-town-agent-pulses.ts`
- Create: `apps/server/src/storage/migrations/004_town_agent_pulses.sql`
- Modify: `apps/server/src/storage/migrations.ts`
- Modify: `apps/server/src/storage/storage.test.ts`
- Create: `apps/server/src/storage/repositories/town-pulse-repository.ts`
- Modify: `apps/server/src/storage/repositories/index.ts`
- Modify: `apps/server/src/storage/town-storage.test.ts`

- [ ] **Step 1: Add a failing migration assertion**

```ts
expect(loadMigrations()).toEqual(expect.arrayContaining([
  expect.objectContaining({
    version: 4,
    name: '004_town_agent_pulses',
    sql: expect.stringContaining('CREATE TABLE town_agent_pulses'),
  }),
]));
expect(database.prepare('SELECT version FROM schema_migrations ORDER BY version').all())
  .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
```

- [ ] **Step 2: Add failing repository cases**

```ts
it('claims, completes, and replays a pulse result', () => {
  const repository = new TownPulseRepository(database);
  expect(repository.claim({
    sessionId: 'session-1', pulseId: 'pulse-1', baseVersion: 0,
    leaseToken: 'lease-1', now: timestamp, leaseExpiresAt: laterTimestamp,
  })).toEqual({ kind: 'claimed' });
  expect(repository.claim({
    sessionId: 'session-1', pulseId: 'pulse-1', baseVersion: 0,
    leaseToken: 'lease-2', now: timestamp, leaseExpiresAt: laterTimestamp,
  })).toEqual({ kind: 'in-flight' });
  repository.complete('session-1', 'pulse-1', 'lease-1', pulseResponse, laterTimestamp);
  expect(repository.claim({
    sessionId: 'session-1', pulseId: 'pulse-1', baseVersion: 0,
    leaseToken: 'lease-3', now: laterTimestamp, leaseExpiresAt: laterTimestamp,
  })).toEqual({ kind: 'complete', response: pulseResponse });
});
```

Insert `session-1` before the test and use a schema-valid local `pulseResponse` fixture.

- [ ] **Step 3: Run storage tests and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/storage/storage.test.ts src/storage/town-storage.test.ts`

Expected: FAIL because migration 004 and the repository do not exist.

- [ ] **Step 4: Add the append-only migration**

```sql
CREATE TABLE town_agent_pulses (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  lease_token TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, pulse_id),
  CHECK ((status = 'pending' AND result_json IS NULL) OR
         (status = 'complete' AND result_json IS NOT NULL))
);

CREATE INDEX town_agent_pulses_session_status_idx
  ON town_agent_pulses(session_id, status, updated_at);
```

Export the identical SQL string from the TypeScript migration file and register version 4 after migration 3.

- [ ] **Step 5: Implement `TownPulseRepository`**

Use `TownPulseResponseSchema` on every JSON read/write. `claim()` inserts when absent, returns the completed result when present, returns `in-flight` for an unexpired pending lease, and atomically replaces `lease_token` when `lease_expires_at <= now`. Reject reuse of the same pulse ID with a different `baseVersion`. `complete()` updates only the matching pending lease token and throws when `changes !== 1`.

- [ ] **Step 6: Run storage tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/storage/storage.test.ts src/storage/town-storage.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit migration and repository**

```bash
git add apps/server/src/storage/migrations.ts apps/server/src/storage/migrations/004-town-agent-pulses.ts apps/server/src/storage/migrations/004_town_agent_pulses.sql apps/server/src/storage/storage.test.ts apps/server/src/storage/town-storage.test.ts apps/server/src/storage/repositories/town-pulse-repository.ts apps/server/src/storage/repositories/index.ts
git commit -m "feat: persist autonomous town pulses"
```

### Task 3: Build distinct resident prompts and bounded decisions

**Files:**
- Create: `apps/server/src/town/resident-agent.test.ts`
- Create: `apps/server/src/town/resident-agent.ts`

- [ ] **Step 1: Write prompt and validation tests**

```ts
it('builds distinct prompts from public authored pet fields', () => {
  const [sunny, mikan] = createAuthoredPetDefinitions();
  expect(buildResidentSystemPrompt(sunny!)).not.toEqual(buildResidentSystemPrompt(mikan!));
  expect(buildResidentSystemPrompt(mikan!)).toContain('Mikan');
  expect(buildResidentSystemPrompt(mikan!)).toContain('Bright, curious');
  expect(buildResidentSystemPrompt(mikan!)).not.toContain('LLM_API_KEY');
});

it('lets the provider select only an enumerated candidate', async () => {
  const provider = { complete: vi.fn(async () => ({
    kind: 'candidate', candidateIndex: 1, speech: '去花园看看。',
  })) } satisfies ProviderAdapter;
  const result = await new ResidentAgent(provider).decide(context());
  expect(result).toEqual({
    decision: { kind: 'candidate', candidateIndex: 1, speech: '去花园看看。' },
    degraded: false,
  });
  expect(provider.complete).toHaveBeenCalledWith(expect.objectContaining({
    trustedInstructions: expect.arrayContaining([expect.stringContaining('Mikan')]),
  }));
});

it('falls back on invalid indices and bounds encounter replies', async () => {
  const provider = { complete: vi.fn(async () => ({ kind: 'candidate', candidateIndex: 99, speech: 'bad' })) } satisfies ProviderAdapter;
  expect((await new ResidentAgent(provider).decide(context())).degraded).toBe(true);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/resident-agent.test.ts`

Expected: FAIL because the module is missing.

- [ ] **Step 3: Implement strict local schemas and prompt construction**

```ts
const SpeechSchema = z.string().trim().min(1).max(80);
const ResidentDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('rest') }).strict(),
  z.object({
    kind: z.literal('candidate'),
    candidateIndex: z.number().int().min(0).max(15),
    speech: SpeechSchema,
  }).strict(),
]);
const EncounterReplySchema = z.object({
  speech: SpeechSchema,
  animation: z.enum(['curious', 'happy', 'sit', 'confused']),
  followUpRequested: z.boolean(),
}).strict();

export function buildResidentSystemPrompt(pet: PetDefinition): string {
  return [
    '[Resident Identity]',
    `ID: ${pet.id}`,
    `Name: ${pet.displayName}`,
    `Species: ${pet.species}`,
    `Personality: ${JSON.stringify(pet.personality)}`,
    `Voice: ${pet.voice.style}`,
    `Catchphrases: ${pet.voice.catchphrases.join(' | ')}`,
    `Interests: ${pet.interests.join(' | ')}`,
    `Public bio: ${pet.publicBio}`,
    'Choose only an enumerated candidate. Never invent IDs, coordinates, events, tools, or private owner facts.',
  ].join('\n');
}
```

Implement `decide`, `respond`, and `followUp` with the shared Provider adapter, distinct output-contract instructions, bounded public context, caller signals, and deterministic resident-specific fallbacks. Validate `candidateIndex < context.candidates.length` after Zod parsing.

- [ ] **Step 4: Run resident Agent tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/resident-agent.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit resident Agents**

```bash
git add apps/server/src/town/resident-agent.ts apps/server/src/town/resident-agent.test.ts
git commit -m "feat: add distinct pet town resident agents"
```

### Task 4: Add fair event-driven scheduling

**Files:**
- Create: `apps/server/src/town/autonomy-scheduler.test.ts`
- Create: `apps/server/src/town/autonomy-scheduler.ts`

- [ ] **Step 1: Write cooldown and fairness tests**

```ts
it('selects least-recently-decided available residents first', () => {
  expect(selectAutonomousResidents({
    projection: projection(), recentEvents: eventsFor(['resident-mikan']),
    nowMs: Date.parse('2026-07-13T09:01:00.000Z'), limit: 2,
  })).toEqual(['player-cat', 'resident-huihui']);
});

it('enforces deterministic 12 to 30 second cooldowns', () => {
  for (const id of projection().residents.map(({ residentId }) => residentId)) {
    expect(residentCooldownMs(id)).toBeGreaterThanOrEqual(12_000);
    expect(residentCooldownMs(id)).toBeLessThanOrEqual(30_000);
  }
  expect(selectAutonomousResidents({
    projection: projection(), recentEvents: eventsFor(['player-cat'], '2026-07-13T09:00:55.000Z'),
    nowMs: Date.parse('2026-07-13T09:01:00.000Z'), limit: 2,
  })).not.toContain('player-cat');
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/autonomy-scheduler.test.ts`

Expected: FAIL because scheduler exports are missing.

- [ ] **Step 3: Implement deterministic scheduling**

```ts
export function residentCooldownMs(residentId: string): number {
  let hash = 2166136261;
  for (const character of residentId) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return 12_000 + (Math.abs(hash) % 18_001);
}
```

`selectAutonomousResidents` must parse all inputs, ignore busy residents, find the most recent persisted `resident.moved`, `resident.spoke`, or `residents.played` timestamp per resident, filter residents still on cooldown, then sort by last-decision timestamp ascending and original projection order as the stable tie-breaker. Return at most `limit`, where `limit` is bounded to `1..2`.

- [ ] **Step 4: Run scheduler tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/autonomy-scheduler.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit scheduler**

```bash
git add apps/server/src/town/autonomy-scheduler.ts apps/server/src/town/autonomy-scheduler.test.ts
git commit -m "feat: schedule fair town resident decisions"
```

### Task 5: Build authoritative autonomous event chains

**Files:**
- Create: `apps/server/src/town/autonomy-event-builder.test.ts`
- Create: `apps/server/src/town/autonomy-event-builder.ts`

- [ ] **Step 1: Write exact encounter-order tests**

```ts
it('creates paired movement, two-sided speech, play, and bounded relationship events', () => {
  const events = builder().encounter(projection(), {
    initiatorId: 'resident-mikan', responderId: 'resident-huihui',
    opening: '一起看看喷泉吗？', reply: '好，慢慢走过去。',
    animation: 'happy',
  });
  expect(events.map(({ type }) => type)).toEqual([
    'resident.moved', 'resident.moved', 'resident.spoke',
    'resident.spoke', 'residents.played', 'relationship.changed',
  ]);
  expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(events[0]?.payload).toEqual(expect.objectContaining({ residentId: 'resident-mikan' }));
  expect(events[1]?.payload).toEqual(expect.objectContaining({ residentId: 'resident-huihui' }));
});

it('adds exactly one third speech when a follow-up exists', () => {
  expect(builder().encounter(projection(), {
    initiatorId: 'resident-mikan', responderId: 'resident-huihui',
    opening: '要玩吗？', reply: '好呀。', followUp: '那就开始吧。', animation: 'happy',
  }).filter(({ type }) => type === 'resident.spoke')).toHaveLength(3);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/autonomy-event-builder.test.ts`

Expected: FAIL because the builder is missing.

- [ ] **Step 3: Implement the pure event builder**

Use `TownEventSchema.parse` for every event, `TOWN_ENCOUNTER_PAIRS[zoneId]` for distinct walkable pairing positions, and the injected `now()`/`nextId()` ports. Validate both residents are available and distinct. `visit()` emits one `resident.moved` event to `TOWN_ZONE_LAYOUT[zoneId].entrance`. `encounter()` emits the exact order from Step 1 and adds `relationship.changed` last only when the existing deterministic relationship delta helper returns a non-zero value. The builder never calls the Provider or writes storage.

- [ ] **Step 4: Run builder and reducer tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/autonomy-event-builder.test.ts src/town/event-reducer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit event builder**

```bash
git add apps/server/src/town/autonomy-event-builder.ts apps/server/src/town/autonomy-event-builder.test.ts
git commit -m "feat: build autonomous town event chains"
```

### Task 6: Extract an atomic event committer

**Files:**
- Create: `apps/server/src/town/town-event-committer.test.ts`
- Create: `apps/server/src/town/town-event-committer.ts`
- Modify: `apps/server/src/town/town-service.ts`
- Modify: `apps/server/src/town/town-service.test.ts`

- [ ] **Step 1: Write compare-and-swap tests**

```ts
it('commits ordered events and runs the completion hook in one transaction', () => {
  const completed: TownCommitResult[] = [];
  const result = committer.apply('session-1', 0, () => [moveEvent()], (value) => completed.push(value));
  expect(result.status).toBe('advanced');
  expect(result.projection.version).toBe(1);
  expect(completed).toEqual([result]);
});

it('returns a no-event stale result without invoking the event factory', () => {
  const factory = vi.fn(() => [moveEvent()]);
  const result = committer.apply('session-1', 99, factory);
  expect(result).toMatchObject({ status: 'stale', events: [] });
  expect(factory).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run committer tests and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/town-event-committer.test.ts`

Expected: FAIL because the committer is missing.

- [ ] **Step 3: Implement `TownEventCommitter.apply`**

Define `TownCommitResult` as the internal discriminated union `{ status: 'advanced'; projection; events } | { status: 'stale'; projection; events: [] }`. Inside one `database.transaction(...).immediate()` call: load/create the projection, compare `baseVersion`, call the synchronous event factory only when versions match, append at most 24 parsed events in sequence, reduce each event, save each projection with compare-and-swap, build a parsed `TownCommitResult`, invoke the optional completion hook before transaction return, and return the result. No Provider promise may enter this class.

- [ ] **Step 4: Refactor `TownService.advance` onto the committer**

Preserve its existing behavior by translating a committer `stale` result back into `TownServiceError('conflict', ...)`. Keep fortune, build, and stall completion generation unchanged. Run the existing `town-service.test.ts` after the refactor.

- [ ] **Step 5: Run committer and TownService tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/town-event-committer.test.ts src/town/town-service.test.ts`

Expected: PASS with no API behavior regression.

- [ ] **Step 6: Commit the transaction boundary**

```bash
git add apps/server/src/town/town-event-committer.ts apps/server/src/town/town-event-committer.test.ts apps/server/src/town/town-service.ts apps/server/src/town/town-service.test.ts
git commit -m "refactor: share atomic town event commits"
```

### Task 7: Orchestrate idempotent LLM pulses

**Files:**
- Create: `apps/server/src/town/town-pulse-service.test.ts`
- Create: `apps/server/src/town/town-pulse-service.ts`
- Modify: `apps/server/src/town/town-service.ts`

- [ ] **Step 1: Write orchestration tests**

Cover these exact cases:

```ts
it('uses separate resident prompts for both sides of an encounter', async () => {
  const result = await service().pulse(request);
  expect(agent.decide).toHaveBeenCalledTimes(1);
  expect(agent.respond).toHaveBeenCalledWith(expect.objectContaining({
    residentId: 'resident-huihui', opening: expect.any(String),
  }));
  expect(result.events.filter(({ type }) => type === 'resident.spoke')).toHaveLength(2);
});

it('returns the stored response for a repeated pulse ID', async () => {
  const first = await service().pulse(request);
  const replay = await service().pulse(request);
  expect(replay).toEqual(first);
  expect(agent.decide).toHaveBeenCalledTimes(1);
});

it('bounds independent provider concurrency at two and never re-enters a resident', async () => {
  await serviceWithConcurrencyProbe().pulse(request);
  expect(maxObservedConcurrency).toBeLessThanOrEqual(2);
  expect(new Set(activeResidentIds).size).toBe(activeResidentIds.length);
});

it('falls back and marks only failed residents degraded', async () => {
  const result = await failingService().pulse(request);
  expect(result.degraded).toBe(true);
  expect(result.degradedResidentIds).toEqual(['resident-mikan']);
  expect(result.events.length).toBeGreaterThan(0);
});

it('returns stale before calling any resident provider', async () => {
  const result = await service().pulse({ ...request, baseVersion: 99 }, signal);
  expect(result).toMatchObject({ status: 'stale', events: [] });
  expect(agent.decide).not.toHaveBeenCalled();
});

it('cancels provider work without committing events', async () => {
  const controller = new AbortController();
  const pending = serviceWithBlockingAgent().pulse(request, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(eventRepository.listAfter('session-1', 0, 24)).toEqual([]);
});
```

- [ ] **Step 2: Run pulse-service tests and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/town-pulse-service.test.ts`

Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement the pulse sequence**

`pulse(request, signal)` must:

1. Parse the request and claim the pulse with a lease lasting `LLM_TIMEOUT_MS + 5_000`.
2. Return stored completed results immediately and join an in-process `Map<string, Promise<TownPulseResponse>>` for concurrent duplicates. For an unexpired claim owned by another process, poll the repository every 50 ms until the stored result appears, the request aborts, or the lease expires; after expiry, atomically reclaim and continue. Never expose an `in-flight` wire status.
3. Load the projection and recent public events without a write transaction.
4. Select at most two residents with `selectAutonomousResidents`.
5. Build safe candidates from `TownSimulationService.candidates`, filtering to `visit-zone` and `socialize`, sorting them deterministically, and slicing to the schema maximum of 16.
6. Call independent `ResidentAgent.decide` operations with a two-slot limiter and the caller signal.
7. For a selected socialize intent, call `respond` with the responder's prompt, then make one `followUp` call only when `followUpRequested` is true and the call budget is below three.
8. Build deterministic fallback movement/encounter events for degraded outputs.
9. Pass a synchronous validated event factory to `TownEventCommitter.apply`.
10. Complete the pulse repository from the committer hook so events, projection, and cached response commit atomically.
11. Remove the in-flight map entry in `finally`.

- [ ] **Step 4: Compose pulse support into `TownService`**

Add optional constructor dependencies `{ provider?: ProviderAdapter; llmTimeoutMs?: number }`, instantiate `ResidentAgent` only when a Provider exists, instantiate `TownPulseService`, and expose:

```ts
async pulse(request: TownPulseRequest, signal: AbortSignal): Promise<TownPulseResponse> {
  return this.#pulse.pulse(request, signal);
}
```

Without a Provider, the pulse service must still produce deterministic movement and template encounters with `degraded: true`.

- [ ] **Step 5: Run pulse, TownService, simulation, and storage tests**

Run: `pnpm --filter @cat-house/server exec vitest run src/town/town-pulse-service.test.ts src/town/town-service.test.ts src/town/simulation-service.test.ts src/storage/town-storage.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit orchestration**

```bash
git add apps/server/src/town/town-pulse-service.ts apps/server/src/town/town-pulse-service.test.ts apps/server/src/town/town-service.ts
git commit -m "feat: orchestrate idempotent town agent pulses"
```

### Task 8: Wire the shared Provider and Fastify route

**Files:**
- Modify: `apps/server/src/agent/fake-provider.ts`
- Create: `apps/server/src/agent/fake-provider.test.ts`
- Modify: `apps/server/src/production.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/app.integration.test.ts`

- [ ] **Step 1: Add route and Provider-reuse tests**

```ts
it('passes a validated pulse and request abort signal to town service', async () => {
  const pulse = vi.fn(async () => pulseResponse);
  const app = buildApp(dependencies({ townService: { ...townService, pulse } }));
  const response = await app.inject({
    method: 'POST', url: '/api/sessions/session-1/town/pulse',
    payload: { baseVersion: 0, pulseId: 'pulse-1' },
  });
  expect(response.statusCode).toBe(200);
  expect(pulse).toHaveBeenCalledWith(
    { sessionId: 'session-1', baseVersion: 0, pulseId: 'pulse-1' },
    expect.any(AbortSignal),
  );
});
```

Add an integration assertion that Fake Provider produces deterministic resident-specific pulse dialogue and never performs network access.

- [ ] **Step 2: Run app tests and verify failure**

Run: `pnpm --filter @cat-house/server exec vitest run src/app.test.ts src/app.integration.test.ts`

Expected: FAIL because `/town/pulse` and `TownServicePort.pulse` are absent.

- [ ] **Step 3: Extend Fake Provider safely**

At the start of `FakeProvider.complete`, detect the trusted resident decision or encounter output-contract marker. Parse only the bounded authoritative candidate data emitted by `ResidentAgent`; choose a deterministic candidate based on resident ID; return resident-specific 80-character-or-shorter dialogue. Preserve all existing room fake decisions.

- [ ] **Step 4: Reuse the production Provider**

In `createProductionApp`, create Provider exactly once. Pass the same object to `AgentService` and `TownService`; pass `providerConfig.llm.timeoutMs` only for the OpenAI-compatible variant and the existing default otherwise. Do not log or enumerate the API key.

- [ ] **Step 5: Add the asynchronous pulse route**

```ts
app.post('/api/sessions/:id/town/pulse', async (request, reply) => {
  const sessionId = parseSessionId(request.params);
  requireSession(dependencies.store, sessionId);
  const body = parseBody(TownPulseRequestSchema, {
    ...(request.body as object), sessionId,
  });
  const signal = (dependencies.requestAbortSignal ?? defaultRequestAbortSignal)(request, reply);
  return reply.send(await town.pulse(body, signal));
});
```

- [ ] **Step 6: Run server tests**

Run: `pnpm --filter @cat-house/server test`

Expected: PASS.

- [ ] **Step 7: Commit production/API wiring**

```bash
git add apps/server/src/agent/fake-provider.ts apps/server/src/agent/fake-provider.test.ts apps/server/src/production.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/app.integration.test.ts
git commit -m "feat: expose autonomous town pulse API"
```

### Task 9: Add an abortable browser pulse loop

**Files:**
- Modify: `apps/web/src/game/town/town-api-client.test.ts`
- Modify: `apps/web/src/game/town/town-api-client.ts`
- Create: `apps/web/src/game/town/town-pulse-loop.test.ts`
- Create: `apps/web/src/game/town/town-pulse-loop.ts`
- Modify: `apps/web/src/game/town/town-playback-coordinator.test.ts`
- Modify: `apps/web/src/game/town/town-playback-coordinator.ts`
- Modify: `apps/web/src/game/production-runtime.ts`
- Create: `apps/web/src/game/production-runtime.test.ts`

- [ ] **Step 1: Add API client and loop tests**

```ts
it('posts pulse IDs and forwards cancellation', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(pulseResponse)));
  const client = new TownApiClient({ fetcher });
  const controller = new AbortController();
  await client.pulse({ sessionId: 'session-1', baseVersion: 2, pulseId: 'pulse-1' }, controller.signal);
  expect(fetcher).toHaveBeenCalledWith('/api/sessions/session-1/town/pulse', expect.objectContaining({
    method: 'POST', signal: controller.signal,
  }));
});

it('never overlaps pulses and waits for playback before scheduling again', async () => {
  const pulse = deferred<TownPulseResponse>();
  const loop = new TownPulseLoop({ pulse: vi.fn(() => pulse.promise), play: vi.fn() }, fakeTimers());
  loop.start(() => projection);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(loopDependencies.pulse).toHaveBeenCalledTimes(1);
  pulse.resolve(pulseResponse);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(loopDependencies.pulse).toHaveBeenCalledTimes(2);
});

it('aborts and clears timers when stopped', async () => {
  loop.start(() => projection);
  await vi.advanceTimersByTimeAsync(4_000);
  loop.stop();
  expect(observedSignal.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(pulse).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run web tests and verify failure**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/town/town-api-client.test.ts src/game/town/town-pulse-loop.test.ts`

Expected: FAIL because pulse APIs and loop are missing.

- [ ] **Step 3: Implement the pulse client**

Add `TownApiClient.pulse(request, signal)` using the same strict response parsing and `request()` helper as existing town methods.

- [ ] **Step 4: Implement `TownPulseLoop`**

The class owns one timer, one `AbortController`, one running flag, and a monotonically increasing pulse counter combined with `crypto.randomUUID()` for IDs. `start(getProjection)` schedules the first run after four seconds. Each run reads the latest projection, calls pulse, passes the same signal into ordered playback for advanced events, publishes the returned projection, then schedules the next run. `stop()` clears the timer, aborts the request/playback chain, and prevents late resolutions from publishing or rescheduling. A stale result publishes its authoritative projection and schedules the next normal pulse without immediate retry.

Extend `TownPlaybackCoordinator.playAndConfirm` with an optional `AbortSignal` and forward it to `TownEventPlayer.play(events, projection, signal)`. Add a test that aborts during playback, verifies no later event is played, and verifies failed event acknowledgements are not sent for an intentional `AbortError`.

- [ ] **Step 5: Integrate with `ProductionGameRuntime`**

Start the loop only after Town Scene emits `town-ready` during release or active-outing restoration. Change `playTownEvents` to accept an optional signal and pass it into the coordinator. Stop the loop before recall, before switching to World Scene, and in `destroy()`. Add one `visibilitychange` listener: stop while `document.hidden`; restart only when Town Scene is active and the outing remains in town. Remove the listener in `destroy()`.

- [ ] **Step 6: Run town web tests**

Run: `pnpm --filter @cat-house/web exec vitest run src/game/town/town-api-client.test.ts src/game/town/town-pulse-loop.test.ts src/game/town/town-event-player.test.ts src/game/town/town-playback-coordinator.test.ts src/game/production-runtime.test.ts`

Expected: PASS. `production-runtime.test.ts` uses mocked game, API, and visibility dependencies to assert lifecycle calls.

- [ ] **Step 7: Commit browser runtime**

```bash
git add apps/web/src/game/town/town-api-client.ts apps/web/src/game/town/town-api-client.test.ts apps/web/src/game/town/town-pulse-loop.ts apps/web/src/game/town/town-pulse-loop.test.ts apps/web/src/game/town/town-playback-coordinator.ts apps/web/src/game/town/town-playback-coordinator.test.ts apps/web/src/game/production-runtime.ts apps/web/src/game/production-runtime.test.ts
git commit -m "feat: run town agents while observing"
```

### Task 10: Prove movement and two-sided interaction end to end

**Files:**
- Modify: `tests/e2e/pet-town.spec.ts`
- Modify: `README.md`

- [ ] **Step 1: Add deterministic pulse E2E assertions**

After entering town with Fake Provider:

```ts
const before = (await town(request, id)).projection;
await expect.poll(async () => {
  const current = (await town(request, id)).projection;
  return current.version > before.version
    && current.residents.every((resident: { residentId: string; position: object }) => {
      const original = before.residents.find((value: { residentId: string }) => value.residentId === resident.residentId);
      return JSON.stringify(original?.position) !== JSON.stringify(resident.position);
    });
}, { timeout: 35_000 }).toBe(true);

await expect.poll(async () => {
  const history = await request.get(`${metadata().primaryApiUrl}/api/sessions/${id}/town/history`);
  const events = (await history.json()).events as Array<{ type: string; participantIds: string[] }>;
  return events.filter(({ type }) => type === 'resident.spoke').length >= 2
    && events.some(({ type, participantIds }) => type === 'residents.played' && participantIds.length === 2);
}, { timeout: 35_000 }).toBe(true);
```

Reload while still in town and assert completed pulse IDs do not duplicate event IDs or sequences.

- [ ] **Step 2: Update README runtime documentation**

Document that all town residents share the configured server Provider, prompts differ by public pet definition, decisions occur only while the town is visible, normal movement does not call the LLM, encounters use two calls normally and three maximum, and provider failure retains deterministic behavior. Do not add new `.env` variables.

- [ ] **Step 3: Run focused cross-workspace tests**

Run: `pnpm --filter @cat-house/shared test && pnpm --filter @cat-house/server test && pnpm --filter @cat-house/web test`

Expected: PASS.

- [ ] **Step 4: Run the Pet Town E2E**

Run: `pnpm test:e2e -- tests/e2e/pet-town.spec.ts`

Expected: PASS without a real LLM or network access; five pets move over time and one deterministic dual-Agent encounter is visible and persisted.

- [ ] **Step 5: Commit E2E and docs**

```bash
git add tests/e2e/pet-town.spec.ts README.md
git commit -m "test: cover autonomous pet town encounters"
```

### Task 11: Final multi-agent verification

**Files:**
- Modify only when verification exposes a defect.

- [ ] **Step 1: Run static checks**

Run: `pnpm lint && pnpm typecheck`

Expected: PASS.

- [ ] **Step 2: Run all tests**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 3: Run all builds**

Run: `pnpm build`

Expected: PASS.

- [ ] **Step 4: Run relevant browser coverage**

Run: `pnpm test:e2e -- tests/e2e/pet-town.spec.ts tests/e2e/mobile-touch.spec.ts`

Expected: PASS with no real network calls, nonblank canvas, moving residents, ordered two-sided bubbles, and no mobile overlap.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check && git status --short`

Expected: no unrelated edits, secrets, `.env` changes, local databases, generated build output, Playwright reports, or stale debug code.

- [ ] **Step 6: Commit any verification-only correction**

If a correction was necessary, stage only the focused files and commit with `fix: correct autonomous town verification defect`. If no correction was necessary, do not create an empty commit.
