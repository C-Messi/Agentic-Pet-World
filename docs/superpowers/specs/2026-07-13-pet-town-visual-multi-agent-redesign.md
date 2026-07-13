# Pet Town Visual And Multi-Agent Redesign

## 1. Goal

Redesign Pet Town as a cohesive, layered pixel-art village while retaining the current seven area identities:

- `gate`
- `plaza`
- `fortune-pavilion`
- `market`
- `garden`
- `build-plots`
- `arcade-house`

The town must read as one place rather than seven colored rectangles. Its macro composition should take inspiration from the supplied Stardew Valley town screenshot: perimeter buildings and trees, a central public space, continuous roads, a foreground waterfront, and clear near/middle/far layers. The rendering style must remain Agent Cat House's own warm, low-resolution style with dark outlines, compact forms, and the existing palette family.

While the town scene is open, all five pets must walk autonomously. Each pet is an independent Agent that uses the same server-side LLM configuration from `.env` but receives a different system prompt derived from its authored public pet definition. Pets occasionally meet, face one another, and produce short two-sided interactions. Closing or leaving the town stops online Agent scheduling; existing bounded offline recovery remains authoritative.

## 2. Confirmed Decisions

- Use the selected "layered village" composition.
- Keep the existing area IDs and activity semantics, but move their visual bounds and entrances to fit the selected composition.
- Keep the `20 x 11`, 32-pixel navigation grid and the `640 x 360` town background.
- Show the complete town at once using the current worktree's centered `TOWN_CAMERA_LAYOUT` and `1.2` zoom.
- Extend the deterministic pixel asset generator; do not replace the town with a model-generated bitmap or introduce Tiled in this change.
- Use event-driven Agent decisions. Ordinary walking uses deterministic rules and does not call the LLM.
- During an encounter, the initiator and responder call the shared Provider separately with their own prompts. An encounter uses two calls normally and no more than three calls.
- Run autonomous Agent scheduling only while the client is actively observing Town Scene.

## 3. Map Composition

### 3.1 Spatial layout

The selected composition maps onto the existing grid as follows:

| Zone | Bounds | Entrance | Visual role |
| --- | --- | --- | --- |
| `fortune-pavilion` | `x 1..5, y 1..3` | `(4, 3)` | Upper-left red-roof pavilion and fortune garden |
| `garden` | `x 7..12, y 1..3` | `(10, 3)` | Upper-center greenhouse, flower beds, and trellis |
| `market` | `x 14..18, y 1..4` | `(15, 4)` | Upper-right awning-lined market street |
| `arcade-house` | `x 1..5, y 5..7` | `(5, 7)` | Lower-left dark-roof playhouse |
| `plaza` | `x 7..12, y 4..7` | `(10, 6)` | Central fountain and primary encounter space |
| `build-plots` | `x 14..18, y 5..7` | `(15, 7)` | Lower-right workshop and bounded build plots |
| `gate` | `x 8..11, y 8..10` | `(10, 9)` | Foreground bridge and town entrance |

A horizontal road joins the upper districts, a vertical spine connects the garden, plaza, and gate, and a lower loop joins the arcade house and build plots. The plaza and its four approach tiles are the highest-probability encounter area, but residents can also meet at zone entrances and activity interaction points.

The bottom of the background is a water edge. Only the bridge and marked waterfront paths are walkable. A new static town walkability definition must distinguish grass, roads, structures, water, and decorative collision before dynamic modifications are applied. `TownNavigation` must combine static blocked cells with persisted modification collision and continue to return deterministic paths.

### 3.2 Visual readability

Zone recognition comes from architecture and ground treatment, not permanent floating labels. The existing zone labels are removed from the scene. Physical pixel signs remain near entrances. React town drawers retain the textual zone names for accessible history and activity descriptions.

The scene uses these depth bands:

1. Static terrain background: grass texture, roads, soil, shoreline, water, and distant tree shadows.
2. Large landmark parts: buildings, greenhouse, pavilion, bridge, and permanent structures.
3. Y-sorted environment props: fences, benches, signs, flowers, crates, lamps, and lower foliage.
4. Residents, activity effects, modifications, and speech bubbles.
5. Sparse foreground occluders: tree canopies, eaves, and bridge rails that create depth without covering entrances or bubbles.

## 4. Pixel Asset Contract

`scripts/generate-pixel-assets.mjs` remains the source of truth for the town PNG files it owns. It must be expanded with reusable drawing primitives for roof segments, walls, windows, awnings, greenhouse glass, trees, fences, flower beds, shoreline, water highlights, signs, and foreground masks. Generated output and generator changes are committed together.

The palette extends the current Agent Cat House values rather than introducing a new art direction. Dark ink, warm wood, coral red, sunflower yellow, moss greens, muted sky blue, pale aqua, and cream remain the dominant families. Texture is added through small clusters and highlights rather than gradients or high-resolution noise.

`town-background.png` remains exactly `640 x 360` RGBA. It contains only static terrain and distant scenery that never needs independent depth, collision, or state.

The existing `64 x 64` atlas grid and frame indices `0..27` remain stable. The atlas expands to `512 x 512`, eight columns by eight rows. Frames `28..63` are appended with these names in this order:

`fortune-roof-left`, `fortune-roof-right`, `fortune-base-left`, `fortune-base-right`, `greenhouse-left`, `greenhouse-right`, `greenhouse-door`, `market-awning-red`, `market-awning-yellow`, `market-awning-blue`, `arcade-roof-left`, `arcade-roof-right`, `arcade-base-left`, `arcade-base-right`, `workshop-left`, `workshop-right`, `workshop-yard`, `gate-roof-left`, `gate-roof-right`, `bridge-rail`, `tree-green`, `tree-blossom`, `tree-canopy-foreground`, `hedge-horizontal`, `hedge-vertical`, `fence-horizontal`, `fence-vertical`, `lamp-post`, `bench-detailed`, `flower-bed`, `planter`, `market-crates-detailed`, `dock`, `plaza-fountain-detailed`, `plaza-banner`, and `shoreline-reeds`.

`manifest.json` must exactly describe the `512 x 512` output, grid, names, and indices. No existing frame is reordered or reinterpreted.

`TownZonePresentation` changes from a single landmark frame to an ordered list of render parts. Each part declares a stable frame index, tile anchor, pixel offset, depth offset, a collision-cell array that is empty when the part does not block movement, and a foreground-occluder boolean. This keeps the scene declarative and prevents district-specific drawing logic from accumulating in `TownScene`.

## 5. Autonomous Resident Agents

### 5.1 Runtime boundary

The browser owns the observation lifecycle and Phaser playback. When `TownScene` becomes active, `ProductionGameRuntime` starts one non-overlapping pulse loop. It stops and aborts the loop before leaving the scene or destroying the runtime. A pulse is requested every four seconds only after the prior pulse and event playback have completed.

The server owns selection, LLM calls, validation, event creation, and persistence. Add an asynchronous `POST /api/sessions/:id/town/pulse` boundary with a strict shared request and response schema. The request contains the session ID from the route, current projection version, and an idempotent client pulse ID. It does not contain proposed positions, resident sources, prompts, or model text. The response contains the authoritative projection, zero or more ordered events, and degraded metadata.

User-directed `/town/advance` remains the deterministic explicit-intent path. Autonomous pulses use a new orchestrator that composes `TownSimulationService`, the shared Provider adapter, event storage, and projection storage.

### 5.2 Scheduling and fairness

For each pulse, the orchestrator:

1. Loads the authoritative projection and recent events.
2. Builds deterministic valid candidates for available residents.
3. Excludes residents that are busy, on cooldown, unreachable, or already selected in the pulse.
4. Selects at most two eligible residents using a fair least-recently-decided queue with personality weights as a tie-breaker.
5. Uses deterministic movement or rest when no meaningful decision point exists.
6. Calls an independent resident Agent when the resident reaches a decision point.
7. Revalidates all chosen intents against the latest projection before appending events.

Each resident has a decision cooldown between 12 and 30 seconds, deterministically derived from resident ID and the most recent persisted `resident.moved`, `resident.spoke`, or `residents.played` event involving that resident. Fair selection ensures every continuously available resident receives a decision opportunity before one resident receives a second opportunity. The server permits at most two independent Provider requests concurrently. A single resident can never have overlapping requests.

Provider calls occur before opening the SQLite write transaction. The final transaction reloads and version-checks the projection, validates the selected intent again, appends events, and updates the projection with compare-and-swap semantics. A stale projection yields a conflict response; it never partially commits model output.

### 5.3 Per-resident prompts

Production creates one shared `ProviderAdapter` from `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, and `LLM_TIMEOUT_MS`. The API key remains non-enumerable and server-only. The same adapter is injected into the autonomous town orchestrator.

`buildResidentSystemPrompt(petDefinition)` constructs a distinct trusted system instruction from only these authored public fields:

- stable pet ID and display name;
- species;
- bounded personality traits;
- voice style and catchphrases;
- interests;
- public bio.

Every prompt also receives the same strict output contract and a bounded authoritative town context containing allowed candidates, public resident state, relationships, zone capacity, and at most eight recent public town events. Private conversations, memories, owner data, credentials, and arbitrary persisted text are not included.

The decision output is a strict discriminated union: rest, select one enumerated candidate, or produce a bounded reaction for an active encounter. Models cannot invent coordinates, events, asset paths, activity tools, residents, zones, build recipes, showcase items, or relationship values.

### 5.4 Encounters

An encounter starts only when a validated socialize candidate is selected and both residents are available. The server creates a bounded chain:

1. Move the initiator and responder to distinct reachable pairing tiles near the encounter point.
2. Call the initiator Agent for a short opening line and validated interaction intent.
3. Call the responder Agent with the accepted opening line as untrusted encounter data and its own resident prompt.
4. Make one final initiator call only when the responder's parsed decision contains `followUpRequested: true` and the encounter has used fewer than three calls.
5. Append events in this exact order: the two `resident.moved` events, the initiator `resident.spoke`, the responder `resident.spoke`, the final initiator `resident.spoke` when step 4 ran, and one `residents.played` event. Append `relationship.changed` last only when the existing deterministic relationship rule produces a non-zero bounded change.

Dialogue is limited to 80 visible characters per event. One encounter produces two dialogue turns normally and at most three. Relationship changes continue to be small deterministic effects derived from accepted events; model text cannot set affinity.

On the client, residents walk to their pairing tiles, flip horizontally to face each other, play `curious`, `happy`, `sit`, or `confused` animations, and show one bubble at a time. Independent events continue after the encounter chain completes; event playback remains sequential and stop-on-failure.

## 6. Failure And Lifecycle Behavior

- Missing provider configuration: all pets continue deterministic walking, resting, and template encounters; pulse responses are marked degraded.
- Timeout, cancellation, rate limiting, invalid JSON, invalid IDs, or semantic rejection: discard that model result and use the resident's deterministic fallback without partial persistence.
- Scene exit or runtime destruction: abort the active pulse, clear its timer, ignore late results, and remove scene listeners.
- Server conflict: reload the authoritative snapshot and retry only on the next scheduled pulse.
- Playback failure: report failed event results, stop the chain, and restore the authoritative projection.
- Offline or hidden page: do not start new live pulses. Existing bounded and idempotent offline recovery remains unchanged and does not continuously call resident Agents.
- Fake Provider: return deterministic resident-specific decisions and encounter replies without network access.

## 7. Testing And Acceptance

### 7.1 Asset and navigation tests

- Assert the background is exactly `640 x 360` RGBA.
- Assert atlas dimensions are complete `64 x 64` rows, old frame names retain indices `0..27`, all new names are unique, and the manifest matches the PNG.
- Assert all seven zone bounds and entrances match the selected composition and remain within the `20 x 11` grid.
- Assert every spawn, zone entrance, interaction point, bridge tile, and build plot is reachable with static and dynamic collision applied.
- Assert no large landmark blocks its own entrance or the gate-to-plaza spine.

### 7.2 Server tests

- Use deterministic clocks, IDs, randomness, and fake providers.
- Assert fair resident selection, 12–30 second cooldowns, maximum two concurrent calls, no resident re-entry, and pulse idempotency.
- Assert every resident receives a distinct prompt while all calls use the same Provider adapter.
- Assert prompts exclude private messages, memories, credentials, and unknown fields.
- Assert initiator/responder call order, two-turn normal encounters, three-call maximum, event ordering, relationship derivation, and replay compatibility.
- Assert stale versions, invalid outputs, timeout, cancellation, rate limiting, and provider failure produce no partial state and use deterministic degradation.

### 7.3 Web and E2E tests

- Assert the pulse loop starts only in Town Scene, never overlaps, waits for playback, stops on exit, and cleans up on destroy.
- Assert five resident positions visibly change over time under Fake Provider.
- Assert a deterministic encounter moves two residents to pairing tiles, faces them toward each other, plays both sides' bubbles in order, and returns them to idle.
- Run Pet Town E2E at desktop and `390 x 844`, checking a nonblank canvas, full-town framing, distinguishable zones, readable bubbles, and no overlap with controls or subtitles.
- Capture desktop and mobile screenshots and inspect them for empty color fields, incoherent occlusion, blocked entrances, clipping, and unreadable visual hierarchy.

Final verification for this cross-workspace change is `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the relevant Pet Town Playwright specifications. No test may require a real LLM or network access.

## 8. Out Of Scope

- Real multiplayer residents or remote user discovery.
- Continuous server-side Agent execution after the page closes.
- Per-pet credentials, models, or `.env` files.
- Arbitrary model-authored map data, collision, code, or assets.
- A Tiled migration, free-form building, commerce, or a completed arcade game.
- Replacing the deterministic offline recovery contract.
