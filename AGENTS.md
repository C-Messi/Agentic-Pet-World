# AGENTS.md

This file applies to the entire repository. It is the operational guide for coding agents. Use
`README.md` for product behavior, setup details, API documentation, and extension walkthroughs.

## Project Snapshot

Agent Cat House and Pet Town is a TypeScript pnpm workspace:

- `apps/web`: React 19 UI and Phaser 3 game runtime, built with Vite.
- `apps/server`: Fastify API, agent/provider orchestration, authored knowledge, and SQLite storage.
- `packages/shared`: Zod schemas and shared wire/domain types used by both applications.
- `tests/e2e`: Playwright coverage for desktop, mobile touch, fake-provider, and degraded-provider flows.
- `scripts`: deterministic asset-generation utilities.

The main runtime boundary is:

```text
React controls <-> typed game event bus <-> Phaser scenes
       |                                      |
       +---------- Fastify HTTP API ----------+
                          |
             validated provider output + SQLite
```

Do not collapse these boundaries. React owns application controls and drawers, Phaser owns the
rendered world and scene lifecycle, the server owns provider credentials and persistence, and
`packages/shared` owns cross-process contracts.

## Toolchain And Commands

- Use Node.js 22.9.0 or newer and pnpm 10.13.1.
- Run commands from the repository root unless a command explicitly changes scope.
- Install dependencies with `pnpm install`.
- Start both applications with `pnpm dev`.
- Run all unit/integration tests with `pnpm test`.
- Run static checks with `pnpm lint` and `pnpm typecheck`.
- Build all workspaces with `pnpm build`.
- Run browser tests with `pnpm test:e2e`.

Prefer the narrowest useful feedback loop while developing:

```bash
pnpm --filter @cat-house/shared test
pnpm --filter @cat-house/server test
pnpm --filter @cat-house/web test
pnpm --filter @cat-house/web exec vitest run src/game/navigation/navigation-system.test.ts
```

Before handing off a change, run the checks proportionate to its scope. Cross-workspace contract or
user-flow changes normally require `pnpm lint`, `pnpm typecheck`, `pnpm test`, and the relevant E2E
specs. Do not claim a check passed unless you ran it in the current worktree.

## Working Rules

- Read the nearest implementation and tests before editing. Follow existing naming, dependency,
  error-handling, and test patterns.
- Keep changes focused. Do not refactor unrelated modules or regenerate unrelated assets.
- Use strict TypeScript. The base config enables `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`; model absence explicitly instead of silencing errors.
- Use ESM imports. Local TypeScript imports use `.js` specifiers where required by the existing
  server/shared build pattern.
- Format with the repository Prettier settings: single quotes and trailing commas.
- Add or update colocated `*.test.ts` / `*.test.tsx` coverage for behavior changes.
- Treat public HTTP payloads, provider output, persisted JSON, Markdown frontmatter, and asset
  manifests as untrusted input. Parse them with the existing Zod schemas at their boundaries.
- Keep identifiers and discriminated unions stable. When a shared contract changes, update all
  producers, consumers, fixtures, and tests in the same change.
- Preserve cancellation, timeout, retry, replay, and idempotency behavior. These are product
  contracts, not optional hardening.
- Do not edit `.env`, commit credentials, expose secrets through `VITE_*`, or log provider secrets.
  Add new variables to `.env.example` with safe placeholder values when configuration changes.

## Architecture Contracts

### Shared Contracts

- Put schemas shared across HTTP or workspace boundaries in `packages/shared/src` and export them
  from `packages/shared/src/index.ts`.
- Derive TypeScript types from Zod schemas rather than maintaining parallel interfaces.
- Keep schemas bounded and strict. Reject unknown fields where the surrounding contract does.
- Build `@cat-house/shared` before diagnosing stale cross-package types; root `dev` and `test`
  already do this.

### Server

- Build Fastify routes through the dependency-injected app in `apps/server/src/app.ts`. Keep
  production wiring in `apps/server/src/production.ts`.
- Provider output is data, never executable code. It must produce one validated decision or fall
  back through the existing degraded path.
- Keep Provider calls outside SQLite write transactions. Revalidate prepared town intents against
  the latest projection, then atomically append events, update the projection, and complete the
  pulse claim through `TownEventCommitter`.
- Provider adapters must translate timeout, cancellation, retryability, and upstream failures into
  the established provider error model without leaking secrets.
- SQLite migrations are ordered and append-only once shipped. Update both migration registration
  and storage tests when the schema changes.
- Use transactions for multi-record state transitions. Preserve correlation IDs, event ordering,
  compare-and-swap projection updates, and replay-safe identities.
- Authored knowledge under `apps/server/content` uses validated YAML frontmatter plus Markdown.
  Keep IDs aligned with `KnowledgeService` allowlists and stay within document budgets.

### Web

- React and Phaser communicate through the typed event bus in `apps/web/src/game/events.ts`; avoid
  hidden cross-runtime mutable state.
- Scene code must clean up listeners, timers, input handlers, and transient objects during shutdown.
- Keep the autonomous town pulse loop non-overlapping and active only while Town Scene is visible.
  It must wait for ordered playback, abort on scene exit, page hiding, recall, or runtime teardown,
  and ignore late request or playback results after stopping.
- Agent actions execute sequentially through the action runner. Keep client-side target validation,
  cancellation, timeouts, typed results, and stop-on-failure behavior intact.
- Navigation and object placement must remain deterministic and reachable. Update registry/layout
  tests when collision, walk targets, plots, or entrances change.
- Keep desktop and 390x844 touch layouts usable. UI changes that affect interaction or canvas
  framing need relevant component tests and Playwright coverage.
- Use the existing Lucide dependency for interface icons. Preserve accessible labels for icon-only
  controls.

### Pet Town

- Town events are authoritative; projections are derived snapshots. New behavior should append
  validated events and update reducers rather than mutating projections ad hoc.
- Autonomous pulse IDs are idempotent durable claims. Preserve lease takeover, same-process joining,
  completed-response replay, compare-and-swap projection checks, and all-or-nothing completion.
- All resident Agents share the injected server Provider configuration. Build distinct prompts only
  from authored public pet definitions and bounded public town state; never include private room
  messages, memories, owner data, credentials, or arbitrary persisted text.
- Autonomous candidates and encounter pairs must be deterministic, reachable, currently executable,
  and rechecked in event order. Keep the two-request concurrency limit, prevent resident re-entry,
  and cap one encounter at three Provider calls.
- Activity transitions and event derivation must remain deterministic, bounded, and testable as
  pure logic.
- Offline recovery is bounded and idempotent. It emits at most the configured recovery window,
  never silently opens or publishes a showcase, and returns stored results on replay.
- Return narration and experience cards must be grounded in persisted source events.
- Showcase data is explicitly public personality display only. Never infer or publish it from
  private conversations, memories, prompts, credentials, or hidden owner data. Do not add commerce
  semantics such as prices, currency, inventory, purchases, or profit.
- The current town residents are deterministic local fixtures. Do not describe them as real online
  users or add implied multiplayer behavior without an explicit product change.

## Tests And Fixtures

- Use Vitest for shared, server, and web unit/integration tests; use Playwright for browser flows.
- Prefer deterministic clocks, ID factories, fake providers, and in-memory or temporary databases.
- Tests must not depend on a real LLM, network access, a developer's `.env`, or persistent local
  SQLite data.
- Cover both success and degraded/error paths at trust boundaries.
- For evented flows, assert ordering, duplicate delivery/replay behavior, correlation identity, and
  reducer compatibility, not only the final snapshot.
- E2E configuration creates isolated temporary databases and selects its own port block. Do not add
  E2E-only variables to `.env`.
- If Playwright Chromium is missing, install it with `pnpm exec playwright install chromium`. A
  local Chrome run may use `E2E_BROWSER_CHANNEL=chrome pnpm test:e2e`.

## Assets And Generated Files

- Keep asset manifests synchronized with their PNG atlases/backgrounds and validate exact
  dimensions, frame geometry, animation rows, alpha, and safe bounds.
- Treat `scripts/generate-pixel-assets.mjs` as the deterministic generator for the checked-in pixel
  assets it owns. Update the generator and generated outputs together.
- Pet atlases use the versioned contracts documented in `README.md`. Do not register assets that
  fail manifest, transparency, dimension, or frame-mapping tests.
- Do not commit build output, coverage, Playwright reports, test results, local databases, or secret
  environment files.

## Definition Of Done

Before finishing:

1. Confirm the change respects the ownership and trust boundaries above.
2. Add or update focused tests that would fail without the change.
3. Run targeted tests during development, then the appropriate lint, typecheck, test, build, and E2E
   commands for the final scope.
4. Update `README.md`, `.env.example`, schemas, manifests, or authored knowledge when their public
   contracts changed.
5. Review `git diff` for unrelated edits, generated churn, secrets, and stale debug code.
6. Report exactly which checks ran and any checks that remain outstanding.
