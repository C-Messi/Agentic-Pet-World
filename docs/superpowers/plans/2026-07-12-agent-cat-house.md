# Agent Cat House Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable browser pixel-art cat house where a persistent LLM agent understands natural-language instructions and performs validated in-world actions.

**Architecture:** Use a pnpm TypeScript workspace with a React/Phaser client, a Fastify BFF, and a shared Zod protocol package. The server owns provider secrets, Markdown-authored knowledge, SQLite state, prompt construction, and validation; the client owns deterministic rendering, navigation, ambient behavior, and safe action execution.

**Tech Stack:** TypeScript, pnpm, Vite, React, Phaser 3, Fastify, OpenAI-compatible SDK, Zod, better-sqlite3, gray-matter, Vitest, Playwright, ESLint, Prettier.

---

## File Map

- `apps/web/src/game/`: Phaser bootstrapping, room scene, object registry, navigation, ambient behavior, action runner, and mini-game registry.
- `apps/web/src/ui/`: React command dock, status bar, conversation/memory/settings drawers, and game-to-UI state bridge.
- `apps/server/src/agent/`: provider adapter, prompt/context construction, structured-decision validation, and fallback behavior.
- `apps/server/src/storage/`: SQLite connection, migrations, repositories, and session persistence.
- `apps/server/content/`: Markdown character, world, object, and mini-game knowledge.
- `packages/shared/src/`: the only wire protocol used by both browser and server.
- `tests/e2e/`: browser acceptance tests using a deterministic fake provider.

### Task 1: Bootstrap The Workspace

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `apps/web/package.json`
- Create: `apps/server/package.json`
- Create: `packages/shared/package.json`

- [ ] **Step 1: Initialize Git and package metadata**

Run:

```bash
git init
pnpm init
```

Replace the root package with scripts that run all workspaces:

```json
{
  "name": "agent-cat-house",
  "private": true,
  "packageManager": "pnpm@10.13.1",
  "scripts": {
    "dev": "pnpm --parallel --filter @cat-house/web --filter @cat-house/server dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test:e2e": "playwright test"
  },
  "devDependencies": {
    "@playwright/test": "^1.54.1",
    "prettier": "^3.6.2",
    "typescript": "^5.8.3"
  }
}
```

- [ ] **Step 2: Define workspace and shared compiler settings**

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  }
}
```

- [ ] **Step 3: Add environment contract and ignored runtime files**

```dotenv
# .env.example
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4.1-mini
LLM_TEMPERATURE=0.4
LLM_TIMEOUT_MS=30000
DATABASE_URL=./data/cat-house.sqlite
PORT=8787
WEB_ORIGIN=http://localhost:5173
VITE_API_URL=http://localhost:8787
USE_FAKE_LLM=false
```

Ignore `.env`, `node_modules`, `dist`, `coverage`, `playwright-report`, `test-results`, `apps/server/data`, and `.superpowers`.

- [ ] **Step 4: Install dependencies and verify the empty workspace**

Run `pnpm install`, then `pnpm typecheck`. Expected: all workspace commands exist and exit 0 after package stubs are added.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .gitignore .env.example apps packages
git commit -m "chore: bootstrap agent cat house workspace"
```

### Task 2: Define The Shared Agent Protocol

**Files:**
- Create: `packages/shared/src/protocol.ts`
- Create: `packages/shared/src/protocol.test.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write failing schema tests**

Test that an `AgentDecision` accepts `speech`, `thought`, `emotion`, and at most four known actions; rejects a fifth action, an unknown action type, and an unknown target ID. Use the fixed target IDs `bed`, `sofa`, `window`, `food-bowl`, `bookshelf`, `toy-basket`, and `arcade`.

```ts
expect(() => AgentDecisionSchema.parse(validDecision)).not.toThrow();
expect(() => AgentDecisionSchema.parse({...validDecision, actions: fiveActions})).toThrow();
expect(() => AgentDecisionSchema.parse({...validDecision, actions: [{type: 'run_code'}]})).toThrow();
```

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/shared test -- protocol.test.ts`. Expected: FAIL because schemas do not exist.

- [ ] **Step 3: Implement discriminated action schemas**

Define `WorldObjectIdSchema`, `EmotionSchema`, and a discriminated union for:

```ts
type AgentAction =
  | { id: string; type: 'move_to'; targetId: WorldObjectId; timeoutMs: number }
  | { id: string; type: 'interact'; targetId: WorldObjectId; interaction: 'inspect' | 'rest' | 'eat' | 'play' | 'open' }
  | { id: string; type: 'emote'; emotion: Emotion; durationMs: number }
  | { id: string; type: 'wait'; durationMs: number }
  | { id: string; type: 'speak'; text: string };
```

Add schemas and inferred types for `WorldSnapshot`, `ActionResult`, `AgentTurnRequest`, `MemoryCandidate`, and `AgentDecision`. Bound text lengths, action counts, timeouts, and memory importance values in Zod.

- [ ] **Step 4: Run shared tests and typecheck**

Run `pnpm --filter @cat-house/shared test` and `pnpm --filter @cat-house/shared typecheck`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat: define validated agent protocol"
```

### Task 3: Add SQLite Storage And Migrations

**Files:**
- Create: `apps/server/src/storage/database.ts`
- Create: `apps/server/src/storage/migrations/001_initial.sql`
- Create: `apps/server/src/storage/repositories.ts`
- Create: `apps/server/src/storage/storage.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Create a temporary SQLite database, migrate it, create a session, append player/agent messages, upsert a world snapshot, add a durable memory, close the database, reopen it, and assert every record remains available.

- [ ] **Step 2: Run the targeted test**

Run `pnpm --filter @cat-house/server test -- storage.test.ts`. Expected: FAIL because the database module is missing.

- [ ] **Step 3: Implement the initial migration**

Create tables `schema_migrations`, `sessions`, `messages`, `memories`, `world_states`, `events`, and `action_runs`. Use text UUIDs, ISO timestamps, JSON text columns for validated payloads, foreign keys, and indexes on session/time and memory importance.

- [ ] **Step 4: Implement focused repositories**

Expose `SessionRepository`, `MessageRepository`, `MemoryRepository`, `WorldStateRepository`, `EventRepository`, and `ActionRunRepository`. Parse JSON through shared schemas when reading and use prepared statements for every write.

- [ ] **Step 5: Verify restart persistence**

Run `pnpm --filter @cat-house/server test -- storage.test.ts`. Expected: PASS with a temporary on-disk database.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/storage
git commit -m "feat: add sqlite persistence layer"
```

### Task 4: Load Markdown Knowledge And Select Memories

**Files:**
- Create: `apps/server/content/character.md`
- Create: `apps/server/content/world.md`
- Create: `apps/server/content/objects/*.md`
- Create: `apps/server/content/minigames/arcade.md`
- Create: `apps/server/src/knowledge/knowledge-service.ts`
- Create: `apps/server/src/agent/context-service.ts`
- Create: `apps/server/src/agent/context-service.test.ts`

- [ ] **Step 1: Write failing context tests**

Assert that the context service loads all authored documents, includes only the current target object's document, orders memories by importance then recency, caps recent messages, and never exceeds its configured character budget.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/server test -- context-service.test.ts`. Expected: FAIL because services are missing.

- [ ] **Step 3: Write authored knowledge**

Give the cat a concise warm, curious personality with short responses and no claim of actions it cannot perform. Describe the single room and each registered object's allowed interactions. Mark the arcade cabinet as installed but unavailable, with the response that games are coming soon.

- [ ] **Step 4: Implement deterministic context assembly**

Load Markdown with `gray-matter`; cache documents by stable ID; assemble sections in the order safety rules, character, world, relevant object, durable memories, recent messages, world snapshot. Truncate oldest conversation first, then lowest-importance memories, while never truncating safety rules or the current world snapshot.

- [ ] **Step 5: Run tests**

Run `pnpm --filter @cat-house/server test -- context-service.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/content apps/server/src/knowledge apps/server/src/agent/context-service*
git commit -m "feat: add markdown knowledge and memory context"
```

### Task 5: Implement The LLM Provider And Agent Service

**Files:**
- Create: `apps/server/src/config.ts`
- Create: `apps/server/src/agent/provider.ts`
- Create: `apps/server/src/agent/openai-compatible-provider.ts`
- Create: `apps/server/src/agent/fake-provider.ts`
- Create: `apps/server/src/agent/agent-service.ts`
- Create: `apps/server/src/agent/agent-service.test.ts`

- [ ] **Step 1: Write failing agent tests**

Cover a valid structured decision, invalid JSON, an unknown target, provider timeout, cancellation, and memory candidates below/above the accepted importance threshold. Assert all failures return a local fallback decision with no model-generated actions.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/server test -- agent-service.test.ts`. Expected: FAIL because the service is missing.

- [ ] **Step 3: Implement provider configuration**

Parse environment variables with Zod. Require key/base URL/model unless `USE_FAKE_LLM=true`. Create a `ProviderAdapter.complete({system, messages, signal})` interface returning unknown structured data.

- [ ] **Step 4: Implement adapters and validation**

Use the OpenAI-compatible chat-completions endpoint with JSON response format, timeout via `AbortSignal.timeout`, and no browser exposure. The fake adapter maps phrases such as `window`, `bed`, and `arcade` to deterministic decisions for tests and local demo use.

- [ ] **Step 5: Implement AgentService**

Build context, call the adapter, parse with `AgentDecisionSchema`, replace unsafe output with a localized fallback, accept memory candidates only when importance is at least `0.7`, and persist messages/events around every turn. Do not retry malformed responses; allow one retry only for transient provider status 429/5xx with bounded backoff.

- [ ] **Step 6: Run tests and typecheck**

Run `pnpm --filter @cat-house/server test -- agent-service.test.ts` and `pnpm --filter @cat-house/server typecheck`. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/config.ts apps/server/src/agent
git commit -m "feat: add safe llm agent orchestration"
```

### Task 6: Expose The Fastify BFF

**Files:**
- Create: `apps/server/src/app.ts`
- Create: `apps/server/src/index.ts`
- Create: `apps/server/src/routes/agent.ts`
- Create: `apps/server/src/routes/session.ts`
- Create: `apps/server/src/app.test.ts`

- [ ] **Step 1: Write failing HTTP tests**

Using `app.inject`, test `GET /health`, `POST /api/sessions`, `GET /api/sessions/:id`, `POST /api/sessions/:id/turns`, `POST /api/sessions/:id/action-results`, and `GET /api/sessions/:id/memories`. Cover invalid bodies, unknown sessions, concurrent turns, and request cancellation.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/server test -- app.test.ts`. Expected: FAIL because routes are missing.

- [ ] **Step 3: Implement the app factory**

Create `buildApp(dependencies)` so tests inject a temporary database and fake provider. Add CORS restricted to `WEB_ORIGIN`, request IDs, JSON error envelopes, a per-session single-flight guard, and a small in-memory rate limiter suitable for the demo.

- [ ] **Step 4: Implement routes**

Validate every body and response with shared schemas. Return `409` for a concurrent turn, `404` for an unknown session, `422` for schema failures, and `503` with a fallback decision when the provider is unavailable.

- [ ] **Step 5: Run server tests**

Run `pnpm --filter @cat-house/server test`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src
git commit -m "feat: expose agent session api"
```

### Task 7: Build The Pixel Room And Autonomous Cat

**Files:**
- Create: `apps/web/src/game/create-game.ts`
- Create: `apps/web/src/game/scenes/world-scene.ts`
- Create: `apps/web/src/game/world/object-registry.ts`
- Create: `apps/web/src/game/navigation/navigation-system.ts`
- Create: `apps/web/src/game/behavior/ambient-behavior.ts`
- Create: `apps/web/src/game/behavior/ambient-behavior.test.ts`
- Create: `apps/web/public/assets/room/*`
- Create: `apps/web/public/assets/cat/*`

- [ ] **Step 1: Write failing deterministic behavior tests**

With a seeded random source, assert idle behavior never selects a blocked target, does not interrupt a running agent action, respects cooldowns, and chooses among `rest`, `wander`, `inspect`, and `look_outside`.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/web test -- ambient-behavior.test.ts`. Expected: FAIL because the system is missing.

- [ ] **Step 3: Create original pixel assets**

Produce a coherent 16x16 or 32x32 tile set and cat spritesheet with idle, walk, sit, sleep, happy, curious, and confused states. Keep nearest-neighbor scaling, transparent sprites, stable frame dimensions, and an asset manifest documenting frame keys.

- [ ] **Step 4: Implement the room scene**

Render a fixed-aspect top-down room containing the registered bed, sofa, rug, food bowl, window, bookshelf, toy basket, and arcade cabinet. Each object exposes a stable ID, walk target, interaction point, and allowed interaction set. Configure resize scaling so the canvas remains visible and centered from 360px mobile width through wide desktop.

- [ ] **Step 5: Implement navigation and ambient behavior**

Use a walkable tile grid with A* pathfinding, reserve interaction tiles, animate movement without changing layout, and let the local ambient system schedule low-cost actions only while the agent action queue is empty.

- [ ] **Step 6: Run tests and a production build**

Run `pnpm --filter @cat-house/web test` and `pnpm --filter @cat-house/web build`. Expected: PASS and a non-empty `dist` bundle.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/game apps/web/public/assets
git commit -m "feat: add autonomous pixel cat house scene"
```

### Task 8: Execute Validated Agent Actions

**Files:**
- Create: `apps/web/src/game/actions/action-runner.ts`
- Create: `apps/web/src/game/actions/action-runner.test.ts`
- Create: `apps/web/src/game/agent/agent-bridge.ts`
- Create: `apps/web/src/game/events.ts`

- [ ] **Step 1: Write failing action-runner tests**

Test sequential execution, timeout, cancellation, unknown targets, failed interaction stopping the queue, ambient behavior suspension, and structured result events for all five action types.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/web test -- action-runner.test.ts`. Expected: FAIL because the runner is missing.

- [ ] **Step 3: Implement the typed event bridge**

Define UI/game events for `world-ready`, `world-snapshot`, `agent-busy`, `bubble-changed`, `action-started`, `action-completed`, and `action-failed`. Keep Phaser types out of React-facing payloads.

- [ ] **Step 4: Implement ActionRunner and AgentBridge**

Validate decisions again in the browser, execute at most four actions sequentially, enforce per-action timeouts, cancel the active sequence on session replacement, and POST every result back to the BFF. A failed action displays a confused emote and returns control without an automatic recursive LLM call.

- [ ] **Step 5: Run tests**

Run `pnpm --filter @cat-house/web test -- action-runner.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/game/actions apps/web/src/game/agent apps/web/src/game/events.ts
git commit -m "feat: execute validated agent actions"
```

### Task 9: Build The React Game Interface

**Files:**
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/ui/command-dock.tsx`
- Create: `apps/web/src/ui/status-bar.tsx`
- Create: `apps/web/src/ui/drawer.tsx`
- Create: `apps/web/src/ui/conversation-panel.tsx`
- Create: `apps/web/src/ui/memory-panel.tsx`
- Create: `apps/web/src/ui/settings-panel.tsx`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/ui/command-dock.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Test submitting a message, disabling while busy, canceling a request, preserving the typed draft on server failure, opening each drawer, rendering memory importance/source, and accessible focus return when a drawer closes.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/web test -- command-dock.test.tsx`. Expected: FAIL because components are missing.

- [ ] **Step 3: Implement the full-screen composition**

Mount Phaser as the full-bleed background. Overlay a compact top status strip and bottom command dock. Use icon buttons with tooltips for conversation, memory, settings, sound, and cancel. Keep message history and settings in edge drawers; do not place the primary game in a card.

- [ ] **Step 4: Implement interaction states**

Show connecting, ready, thinking, acting, offline, canceled, and provider-error states without obscuring the room. Render speech/thought bubbles through the game bridge, keep all text within responsive bounds, and provide mobile-safe input sizing and drawer widths.

- [ ] **Step 5: Run component tests and build**

Run `pnpm --filter @cat-house/web test` and `pnpm --filter @cat-house/web build`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat: add natural language game interface"
```

### Task 10: Add The Mini-Game Plugin Boundary

**Files:**
- Create: `packages/shared/src/minigame.ts`
- Create: `apps/web/src/game/minigames/registry.ts`
- Create: `apps/web/src/game/minigames/coming-soon-scene.ts`
- Create: `apps/web/src/game/minigames/registry.test.ts`

- [ ] **Step 1: Write failing registry tests**

Test manifest registration, duplicate ID rejection, schema validation, trigger-object lookup, lazy scene loading, and unknown mini-game fallback.

- [ ] **Step 2: Run the test and verify failure**

Run `pnpm --filter @cat-house/web test -- registry.test.ts`. Expected: FAIL because the registry is missing.

- [ ] **Step 3: Define and implement the contract**

Define `MiniGameManifest` with `id`, `title`, `triggerObjectId`, `stateSchema`, `createInitialState`, `loadScene`, and optional `agentTools`. Register an `arcade-coming-soon` manifest whose scene presents a short in-world unavailable message and returns to `WorldScene` without changing the session.

- [ ] **Step 4: Verify the boundary**

Run shared and web tests. Expected: PASS and the arcade interaction opens and closes the placeholder scene through the registry only.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/minigame.ts apps/web/src/game/minigames
git commit -m "feat: add minigame plugin registry"
```

### Task 11: Add End-To-End Acceptance Coverage

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/cat-house.spec.ts`
- Create: `tests/e2e/mobile.spec.ts`
- Create: `tests/e2e/provider-error.spec.ts`

- [ ] **Step 1: Write acceptance tests against fake LLM mode**

Cover first load, session creation, `go to the window`, visible cat movement, speech bubble, persisted conversation after reload, memory drawer contents, arcade placeholder, concurrent-submit prevention, and provider-error fallback.

- [ ] **Step 2: Add visual and canvas assertions**

At 1440x900, 1024x768, and 390x844, assert the Phaser canvas has non-zero rendered pixels, the cat and major furniture are inside the viewport, the command dock does not overlap drawers, and the longest configured status label fits its container.

- [ ] **Step 3: Run end-to-end tests**

Run `USE_FAKE_LLM=true pnpm test:e2e`. Expected: all Chromium scenarios PASS with screenshots retained only on failure.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts tests/e2e
git commit -m "test: cover agent cat house workflows"
```

### Task 12: Final Documentation And Verification

**Files:**
- Create: `README.md`
- Modify: `.env.example`
- Modify: workspace scripts as required by verified commands

- [ ] **Step 1: Document setup and extension points**

Document Node/pnpm prerequisites, `pnpm install`, `.env` setup, fake-provider demo mode, development URLs, test commands, SQLite location, Markdown knowledge editing, provider compatibility, action safety model, and the exact steps for registering a future mini-game.

- [ ] **Step 2: Run the complete verification suite**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
USE_FAKE_LLM=true pnpm test:e2e
```

Expected: every command exits 0, the production bundles are non-empty, and the E2E suite passes at desktop and mobile sizes.

- [ ] **Step 3: Run an optional real-provider smoke test**

With a configured `.env`, start the app and send one instruction. Confirm the API key is absent from browser network payloads and bundles, the model response validates, and the cat completes the returned action. Skip with an explicit note when no key is configured.

- [ ] **Step 4: Inspect the final worktree**

Run `git status --short` and `git log --oneline --decorate -12`. Expected: only intentional files are tracked and the task commits are present.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md .env.example package.json apps/*/package.json packages/*/package.json
git commit -m "docs: document agent cat house demo"
```
