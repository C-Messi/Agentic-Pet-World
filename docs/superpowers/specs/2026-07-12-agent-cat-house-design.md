# Agent Cat House Demo Design

## 1. Goal

Build a browser-based pixel-art cat house that demonstrates agentic gaming through natural-language interaction. The resident cat is controlled by an LLM-backed agent rather than direct player movement. The player talks to the cat, observes its reasoning and behavior, and can eventually enter agentic mini-games through extensible room objects.

The first demo succeeds when a player can open the app, see a living pixel-art room, send a natural-language instruction, and watch the cat produce a response and execute a valid in-world action. State and memory must survive a restart. Mini-games are represented by discoverable placeholder objects and a stable plugin contract, but no full mini-game is included in this milestone.

## 2. Product Experience

### Main screen

- Use a top-down, Stardew-like pixel-art room as the full-screen primary experience.
- Keep a compact natural-language command bar docked at the bottom.
- Show short speech or thought bubbles near the cat while actions run.
- Put conversation history, memories, settings, and diagnostics in drawers rather than permanent sidebars.
- Design desktop-first while keeping the command flow and drawers usable on mobile browsers.

### Core loop

1. The cat performs low-cost local idle behaviors such as resting, wandering, inspecting an object, or looking through the window.
2. The player sends a natural-language message such as "go sit by the window" or "what do you want to do?".
3. The server builds context from the current world snapshot, recent conversation, SQLite memories, and Markdown knowledge documents.
4. The LLM returns a validated structured decision containing dialogue, emotion, and zero or more permitted game actions.
5. The client executes the action sequence, shows visible feedback, and reports completion or failure to the server.
6. The server records the event and applies any validated memory updates.

LLM calls occur on player input and meaningful world events, not every animation tick or idle decision.

## 3. Architecture

### Workspace

Use a TypeScript pnpm workspace with three packages:

- `apps/web`: Vite, React, and Phaser 3 browser client.
- `apps/server`: Fastify BFF, LLM orchestration, Markdown loading, and SQLite persistence.
- `packages/shared`: Zod schemas and shared types for commands, world snapshots, agent decisions, events, and mini-game manifests.

React owns application chrome, drawers, forms, connection state, and accessibility. Phaser owns the game canvas, scene lifecycle, tile/object rendering, collisions, pathfinding, sprite animation, and action execution. The two communicate through a typed event bridge rather than importing each other's internal state.

### Client game systems

- `WorldScene`: loads the initial cat house and exposes stable object identifiers.
- `EntitySystem`: owns the cat and interactable object runtime state.
- `NavigationSystem`: finds and follows paths to registered interaction points.
- `ActionRunner`: executes only known action types and emits progress/result events.
- `AmbientBehaviorSystem`: chooses deterministic weighted idle behaviors locally.
- `AgentBridge`: sends player intents and world snapshots to the BFF and queues returned actions.
- `MiniGameRegistry`: discovers manifests and opens placeholder or future game scenes without coupling them to the room scene.

The first room contains a bed, sofa, rug, food bowl, window, bookshelf, toy basket, and arcade cabinet. The arcade cabinet is the visible mini-game placeholder.

### Server systems

- `AgentService`: constructs prompts, calls the configured provider, validates structured output, and returns a safe decision.
- `ContextService`: combines current world state, recent messages, relevant memories, and Markdown knowledge within a bounded context budget.
- `MemoryService`: reads and writes durable memories and creates conversation summaries.
- `KnowledgeService`: loads Markdown documents at startup and supports explicit reload in development.
- `SessionService`: stores the active world state, conversation, events, and action results.
- `ProviderAdapter`: begins with an OpenAI-compatible chat-completions adapter and keeps provider-specific details behind an interface.

The server never forwards arbitrary model output as executable code. It validates all responses with shared Zod schemas and rejects unknown action types, object identifiers, and invalid parameters.

## 4. Agent Contract

The client sends an `AgentTurnRequest` containing:

- session identifier;
- player message;
- compact world snapshot;
- currently running action, if any;
- recent client-side action results.

The server responds with an `AgentDecision` containing:

- `speech`: short player-facing text;
- `thought`: optional short in-world thought bubble;
- `emotion`: one of the supported sprite states;
- `actions`: an ordered list of zero to four validated actions;
- `memoryCandidates`: optional server-reviewed memory proposals.

Initial action types are `move_to`, `interact`, `emote`, `wait`, and `speak`. `move_to` and `interact` reference object IDs registered by the world scene. Actions are executed sequentially, can time out, and return structured success or failure results. A failed action stops the remaining sequence and creates a follow-up event; it does not recursively call the LLM without a bounded retry policy.

## 5. Persistence And Knowledge

SQLite is the durable runtime store. Initial tables cover sessions, messages, memories, world state, events, and action runs. Use migrations from the first version and keep repository access behind typed services so storage can later move to another database.

Markdown files provide editable authored context:

- `content/character.md`: personality, voice, preferences, and behavioral boundaries.
- `content/world.md`: room fiction and global rules.
- `content/objects/*.md`: semantic descriptions and available interactions for room objects.
- `content/minigames/*.md`: future mini-game rules and agent guidance.

Markdown is source-controlled authored knowledge; SQLite is mutable player/session memory. The agent cannot rewrite Markdown files through chat in this milestone.

## 6. Configuration And Failure Handling

Provide `.env.example` with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_TIMEOUT_MS`, `DATABASE_URL`, `PORT`, and client origin settings. Secrets remain in the server environment and are never exposed through Vite variables or browser bundles.

On provider timeout, invalid output, or unavailable configuration, the room remains playable. The UI reports the degraded state and the cat performs a local fallback response without inventing LLM actions. Requests are single-flight per session, cancelable from the client, rate-limited, and assigned correlation IDs for diagnostics.

## 7. Extensibility

Mini-games implement a manifest and lifecycle contract with an ID, title, trigger object, scene loader, optional agent tools, initial state factory, and state schema. The room only opens a registered mini-game by ID. Future rooms, characters, providers, memory retrieval strategies, and agent tools use the same registry/adapter pattern rather than adding branches to the main scene or route handlers.

Keep the demo single-player and single-resident. Accounts, multiplayer, vector search, voice input, speech synthesis, user-authored tools, and a complete mini-game are outside this milestone.

## 8. Verification

- Unit-test shared schemas, action validation, memory selection, prompt-context limits, and local idle behavior selection.
- Integration-test the BFF with a deterministic fake provider, including malformed output, timeout, cancellation, and action failure flows.
- Test SQLite migrations and restart persistence using a temporary database.
- Browser-test the main loop: load room, submit instruction, receive decision, move and interact, persist history, and reopen drawers.
- Verify desktop and mobile layouts, canvas visibility, pixel scaling, keyboard focus, touch input, loading, empty, offline, and provider-error states.
- Keep one optional provider smoke test gated by environment variables; normal CI must not require a real API key.
