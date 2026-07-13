# Agent Cat House And Pet Town

Agent Cat House is a single-player browser demo where a resident pixel-art cat responds to natural-language requests. React provides the application controls, Phaser renders and animates the room, and a Fastify server asks an OpenAI-compatible model for a strictly validated decision before the client executes any action.

The demo contains a private room and a persistent pixel-art Pet Town. Releasing the player's pet opens an observer view with four resident pets, follow-camera controls, fortune activities, safe predefined town builds, public personality stalls, and evidence-bound return stories.

## Controls

- Type a request in the bottom command bar and press Enter or the send button.
- Use the cancel button while the cat is thinking or acting.
- Open the conversation, memory, and settings drawers from the top-right controls.
- Toggle sound from the speaker control or the settings drawer.
- Close a drawer with its close button or Escape.
- In the arcade placeholder, use its return button, Enter, or Escape to return to the room.
- Use the map/home button to release the pet to town or recall it. The resident selector changes the camera follow target; there are no direct movement controls.
- In town, open the history, relationship, experience, and showcase drawers from the observation controls. The single subtitle line reports key events without pausing the simulation.

There are no direct movement controls. The cat navigates and interacts through validated agent actions and local ambient behavior.

The four town residents are deterministic local demo residents. The interface presents them as town residents so the demo reads naturally, but it must not claim that real users are online. There is no multiplayer transport or account discovery in this milestone.

## Architecture

This is a TypeScript pnpm workspace:

- `apps/web`: Vite, React, Phaser, UI state, room rendering, navigation, ambient behavior, action execution, and mini-game scenes.
- `apps/server`: Fastify API, provider orchestration, prompt/context construction, Markdown knowledge, and SQLite persistence.
- `packages/shared`: Zod schemas and shared types for the wire protocol and mini-game manifests.

The main request flow is:

```text
command bar -> world snapshot -> Fastify -> context + provider
            <- validated decision <- Zod validation
Phaser action runner -> structured results -> Fastify -> SQLite
```

React and Phaser communicate through a typed event bus. Provider credentials remain on the server and are never exposed through `VITE_*` variables. SQLite stores mutable session state; source-controlled Markdown stores authored character and world knowledge.

## Prerequisites

- Node.js 22.9.0 or newer
- pnpm 10.13.1 (the version declared by `packageManager`)

Corepack can activate the declared pnpm version when it is available in your Node installation.

## Setup

Install dependencies and create a local environment file:

```bash
pnpm install
cp .env.example .env
```

For deterministic local development without an API key, set:

```dotenv
USE_FAKE_LLM=true
```

For a real OpenAI-compatible chat-completions provider, leave `USE_FAKE_LLM=false` and configure:

```dotenv
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-provider-key
LLM_MODEL=gpt-4.1-mini
LLM_TEMPERATURE=0.4
LLM_TIMEOUT_MS=30000
```

`LLM_BASE_URL` may point to another OpenAI-compatible endpoint. The API key is server-only. If fake mode is disabled and any required provider field is missing, `/health` reports degraded status and turns use the safe local fallback path.

Start both applications:

```bash
pnpm dev
```

With `.env.example` values, the web app is at `http://localhost:5173`, the API is at `http://localhost:8787`, and health endpoints are `http://localhost:8787/live` and `http://localhost:8787/health`. `HOST`, `PORT`, `WEB_ORIGIN`, and `VITE_API_URL` can change those bindings; keep the origins aligned for CORS.

### Pet Town Demo Walkthrough

1. Start the app with `USE_FAKE_LLM=true` and open `http://localhost:5173`.
2. Use the home/town control, or ask the pet to go outside, to release it into Pet Town.
3. Select a resident to follow. The town contains the player pet plus Mikan, Huihui, Lanlan, and Doubao.
4. Use natural language to socialize, draw a fortune with residents, build a registered town recipe, or open a personality showcase stall.
5. Open the history, relationship, experience, and showcase drawers to inspect authoritative events and public display data.
6. Recall the pet to receive a first-person account grounded in its persisted outing events. Reloading during an outing exercises bounded, idempotent offline recovery.

The current vertical slice completes the full fortune (`started -> revealed -> interpreted`), build (`started -> completed`), and showcase (`opened -> visited -> closed`) lifecycles. Residents are deterministic local fixtures presented as town residents; the UI does not label them as mocks or claim that real users are online.

## Persistence And Knowledge

`DATABASE_URL` defaults to `./data/cat-house.sqlite`. When started through the root scripts, that resolves to `apps/server/data/cat-house.sqlite`. The server creates the directory, enables foreign keys and WAL mode, and applies the ordered migrations in `apps/server/src/storage/migrations/` automatically at startup. Set `DATABASE_URL=:memory:` only for disposable runs.

Authored agent knowledge lives in `apps/server/content/`:

- `character.md` and `world.md` define the cat and room.
- `objects/*.md` describe each registered object and allowed behavior.
- `minigames/*.md` describe mini-game availability and guidance.
- `town/*.md` describes Pet Town rules and registered activity guidance.

Files use validated YAML frontmatter followed by Markdown. IDs must match the allowlists in `KnowledgeService`, every required document must exist, and per-file/total character budgets are enforced. Restart the server after editing knowledge so it reloads the documents. Chat cannot modify these files.

Pet Town adds `town_events`, `town_projections`, `town_residents`, `town_relationships`, `town_world_modifications`, `town_activity_instances`, `town_outings`, `town_recovery_windows`, `town_experience_cards`, `town_experience_card_events`, and `public_showcase_items` through migration `003-pet-town`. Events are authoritative, projections are compare-and-swap snapshots, and experience cards retain explicit source-event links.

Offline town behavior is bounded catch-up, not a continuously running background process. Reopening an active outing submits one idempotent recovery window based on the last confirmed timestamp. A window returns zero to five events, permits at most one build, never opens or publishes a showcase stall automatically, and replays the same stored result when retried. Return narration and cards are generated only from persisted town events; degraded narration uses the same evidence and does not invent experiences.

Showcase items are personality display only. They have no price, inventory, currency, purchase, or profit fields. An item is available to a stall only after the owner explicitly enters it, checks the public confirmation, and saves it. Do not derive showcase content from private conversation, memories, provider prompts, or hidden owner data.

## Pet Town API

All routes are scoped below `/api/sessions/:id/town` and require an existing session:

| Method and path            | Purpose                                                                |
| -------------------------- | ---------------------------------------------------------------------- |
| `GET /`                    | Projection, active outing, public showcase items, and experience cards |
| `POST /release`            | Release the player pet into town; idempotent while already out         |
| `POST /recall`             | Recall an interruptible player pet                                     |
| `POST /advance`            | Validate one to sixteen town intents and append deterministic events   |
| `POST /event-results`      | Idempotently acknowledge client playback results                       |
| `POST /recover`            | Execute or replay one bounded offline recovery window                  |
| `GET /history`             | Recent source events and linked experience cards                       |
| `GET /relationships`       | Current resident affinity projection                                   |
| `GET /experience-cards`    | Evidence-bound first-person return cards                               |
| `GET /showcase`            | Public personality items only                                          |
| `PUT /showcase/:itemId`    | Explicitly publish a schema-valid showcase item                        |
| `DELETE /showcase/:itemId` | Remove a published showcase item                                       |

Town intents never accept arbitrary map coordinates or raw event payloads. Builds use only `stone-path`, `flower-patch`, `street-lamp`, `showcase-stall`, and `wish-corner`, and placement must use an allowed plot while preserving reachability to every activity entrance.

## Scripts

| Command          | Purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `pnpm dev`       | Build shared types, then run the web and server watchers      |
| `pnpm lint`      | Run ESLint in every workspace package                         |
| `pnpm typecheck` | Run project-reference TypeScript checks                       |
| `pnpm test`      | Build shared types and run all Vitest suites                  |
| `pnpm build`     | Produce the shared, server, and web production builds         |
| `pnpm test:e2e`  | Start isolated fake/degraded servers and run Playwright tests |

Playwright uses its bundled Chromium by default. Install it once with `pnpm exec playwright install chromium` if it is not already present. To use a locally installed Google Chrome instead, run:

```bash
E2E_BROWSER_CHANNEL=chrome pnpm test:e2e
```

`E2E_BASE_PORT` may set the E2E server port block (1024 through 65532); otherwise a random base in the configured range is selected. E2E databases are created in a temporary run directory and removed by teardown. These E2E-only variables do not belong in `.env`.

## Action Safety Contract

The model must return one `agent-decision.v1` JSON object, not code or prose. Shared Zod schemas allow only `move_to`, `interact`, `emote`, `wait`, and `speak`, with bounded text, durations, action counts, unique action IDs, known object IDs, and permitted interactions. The server rejects malformed or unsafe output and returns a degraded fallback decision. The client independently checks runtime target availability, executes actions sequentially with cancellation/timeouts, stops on failure, and reports typed results plus the authoritative world snapshot back to the server. Provider output is never evaluated as code.

## Extending The Demo

### Add A Room Object

1. Add the stable ID to `WorldObjectIdSchema` in `packages/shared/src/protocol.ts`; raise the world object limit only if the room will exceed eight objects.
2. Add its render frame, positions, walk target, occupied tiles, and allowed interactions to `ROOM_OBJECTS` in `apps/web/src/game/world/object-registry.ts`. Add/update the room atlas and asset manifest when a new frame is required.
3. Add `object:<id>` to `KNOWLEDGE_DOCUMENT_IDS` in `apps/server/src/knowledge/knowledge-service.ts` and create the matching `apps/server/content/objects/<id>.md` frontmatter/content.
4. Add the ID to the explicit allowed-object list in `AGENT_DECISION_OUTPUT_CONTRACT_V1` in `apps/server/src/agent/agent-service.ts`.
5. Update the shared protocol, object registry, asset manifest, context, and action-runner tests. Verify that the walk target remains reachable.

### Add A Provider Adapter

1. Implement `ProviderAdapter` from `apps/server/src/agent/provider.ts`; return a provider completion string and translate timeout, cancellation, retryability, and provider failures into `ProviderError`.
2. Add only the required server-side environment fields and a new discriminated config variant in `apps/server/src/config.ts`. Do not use `VITE_*` for secrets.
3. Construct the adapter in `createProvider` in `apps/server/src/production.ts`.
4. Add adapter tests for valid output, HTTP/provider errors, timeout, cancellation, and secret redaction, plus config tests for missing/invalid values.

The existing `OpenAICompatibleProvider` should be configured rather than replaced when the provider supports the OpenAI chat-completions contract.

### Add A Mini-Game

1. Create a Phaser scene that consumes `MiniGameLaunchData`, registers cleanup with the scene lifecycle, and returns to `returnSceneKey`.
2. Define a `MiniGameManifest` in `apps/web/src/game/minigames/manifests.ts` with a unique `id`, `title`, registered `triggerObjectId`, versioned `stateSchemaId`, Zod-compatible JSON state schema, initial-state factory, and lazy `loadScene`. Add bounded agent tools only when needed.
3. Register the manifest with `miniGameRegistry.register(...)`. Each manifest ID and trigger object must be unique; unknown games use the fallback manifest.
4. Ensure the trigger room object exposes the `open` interaction. `WorldScene` already delegates open interactions through `openByTriggerObject`.
5. Add the corresponding mini-game knowledge ID/schema entry in `KnowledgeService` and its Markdown file under `apps/server/content/minigames/` when the agent needs authored rules.
6. Add shared manifest validation, registry, lifecycle, scene, interaction, and E2E tests. Keep mini-game state JSON-compatible and validated at every tool boundary.

### Add A Town Activity

1. Implement a `TownActivityDefinition` in `apps/server/src/town/activities/` with a stable ID, zone, capacity, declared result-event types, bounded Zod state/tool schemas, and a deterministic initial state.
2. Implement pure `transition`, `resultEvents`, and `validateResultEvent` functions. Result events must use the provided context IDs, versions, sequence, participants, zone, timestamp, and emitted-result cursor; never construct unvalidated free-form events.
3. Register the definition with `TownActivityRegistry`, add its availability metadata to the simulation allowlist, and expose only a validated high-level intent. Models never receive raw activity tools.
4. Add lifecycle tests covering invalid tools, capacity, replay/idempotency, event ordering, result validation, and reducer compatibility. Add client playback only for event types that need a visible scene effect.

### Add A Pet

Every generated or authored pet uses the same two versioned contracts before catalog registration:

1. Add a schema-valid `pet-definition.v1` record with a stable pet ID, display name, source, species, sprite ID, three-color palette, bounded personality traits, voice, interests, and public bio. Keep private owner data outside this record.
2. Produce a `128x224` RGBA PNG atlas: fixed `32x32` frames, exactly four columns, and seven required animation rows in contract order (`idle`, `walk`, `sit`, `sleep`, `happy`, `curious`, `confused`). Unused pixels must remain transparent and visible body pixels must stay inside the safe frame bounds.
3. Add a schema-valid `pet-sprite.v1` `manifest.json` beside `pet-atlas.png`, with the exact atlas size, frame geometry, animation row/frame mapping, alpha mode, and safe body bounds.
4. Put web assets under `apps/web/public/assets/pets/<sprite-id>/`, register the validated definition in the server and web catalogs, and add its sprite ID to the town scene preload allowlist.
5. Run the shared pet schema tests and `apps/web/src/game/assets/asset-manifest.test.ts`. Do not register an atlas that fails dimensions, transparency, frame mapping, or manifest validation.

## Demo Scope

This milestone intentionally uses one local player pet plus four deterministic town residents and an arcade placeholder rather than real multiplayer or a complete agentic-game catalog. It has no accounts, authentication, voice input/output, networked residents, commerce, vector search, user-authored tools, or production operations layer.
