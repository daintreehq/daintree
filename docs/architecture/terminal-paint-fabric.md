# Terminal Paint-Plane Fabric

Dissolve the per-project single-thread parse-and-paint monolith — one renderer main thread parsing every terminal's VT stream, one `terminalInstanceService` singleton, one shared module-global glyph atlas, and one fixed 16-WebGL-context budget, all inside one `WebContentsView` — into a _paint fabric_: a coordinated set of render surfaces, each on its own thread and/or its own GPU-context budget, fronted by a thin main-thread compositor that re-provides every cross-terminal invariant the single view gives for free today.

This is the paint-plane counterpart to the terminal data-plane fabric (pty-host sharding). The data plane shards the _producer_ so bytes stop serializing on one event loop; this plane shards the _consumer_ so VT-parse throughput, GPU-context headroom, and paint latency scale with the machine instead of colliding on one main thread and one browser-imposed 16-context ceiling. It is the harder of the two: the data plane reused a proven in-house precedent (per-project UtilityProcess sharding + MessagePorts) and stayed in Daintree's own code, whereas the two things that bound the paint plane — xterm's core threading model and Chromium's GPU/process caps — are both upstream and both immovable from inside Daintree.

## Status

Phase 0 is landed behind `DAINTREE_PAINT_FABRIC` (default off). Phases 1–5 are planned; this doc is the reference for their invariants and acceptance gates.

## The four ceilings

All four are anchored in code Daintree does not own.

- **Single-thread parse.** Every terminal in a project streams into one renderer process and is parsed by xterm's `WriteBuffer` state machine on one main thread: `pty-host → MessagePort → terminalClient.onData → dataBuffer.bufferData` (`TerminalInstanceService.ts`) → `writeToTerminal` → `writeController.write → terminal.write()`. xterm parses atomically per write-buffer entry and yields only between entries (`WRITE_TIMEOUT_MS = 12`, `WriteBuffer.ts`); the 32 KB write-slicing defense (`TerminalWriteController.ts`) bounds one task's _length_ but not _count_ — N terminals still serialize N slice-streams on one thread. The SharedArrayBuffer/worker ingest path was built and intentionally disabled (per-view workers racing one ring buffer dropped output — `TerminalOutputIngestService.ts`), so MessagePort is the only path and everything downstream is synchronous main-thread work. There is no worker parse path anywhere in the terminal path.
- **16-WebGL-context cap.** Chromium caps active WebGL contexts at 16 per renderer and silently evicts the oldest on overflow (crbug 40939743, documented in `TerminalWebGLConfig.ts`). Daintree pre-empts eviction: keep the fleet in WebGL below `upperThreshold = 12`, flip _everyone_ to the DOM renderer above it (`TerminalWebGLManager.evaluateMode`). An LRU context pool was evaluated and rejected — it duplicated the eviction decision Chromium already makes one layer down and produced visible churn at 12–20 visible agent terminals. The budget cannot be grown within one `WebContentsView`.
- **Shared-mutable glyph atlas.** The atlas is module-global in the WebGL addon (`CharAtlasCache.ts`) and shared across every terminal with matching font/theme. `TextureAtlas._mergePages` rewrites glyph `texturePage` indices while each WebGL renderer keeps its own local model, so a page merge under many colored status-line TUIs leaves co-owner panes sampling the wrong glyph until an `atlasResync` local reset or a resize (#8080). The rAF-coalesced resync subsystem in `TerminalWebGLManager` exists solely to babysit this hazard, which is inherent to xterm's single-renderer sharing assumption.
- **Pacing-only defenses.** Every renderer-perf fix to date — write slicing (#10919), focused-drain priority (#10881), the four-tier refresh throttle (`TerminalRendererPolicy.ts`), the count-based WebGL mode switch, the atlas resync subsystem — interleaves and reorders already-queued work on one thread and one budget. None adds a core, a GPU-context slot, or a second atlas.

## The core decision

The project's renderer stops being one surface. It becomes a bounded set of render surfaces — each its own thread (worker parse) and/or its own `WebContentsView` (its own 16-context GPU budget and its own atlas) — fronted by a thin main-thread compositor (`PaintFabricCompositor`) that preserves every cross-terminal invariant the single view provides today.

Two ceilings, two different fixes, and a real solution needs both:

1. **Worker-parse** (thread the parse) multiplies parse throughput across cores but does not touch the GPU cap or the atlas.
2. **View-sharding** (multiply `WebContentsView`s) multiplies GPU headroom and dissolves the cross-pane atlas hazard, and incidentally buys parse parallelism at surface granularity, but does not parallelize parse within a view.

View-sharding ships first (Phases 1–3): it reuses the process-and-window model Daintree already operates (each project is already its own `WebContentsView` — `ProjectViewManager.ts`; this makes it "a project is a _small set_ of views" rather than one), and delivers the GPU-headroom and atlas-correctness wins that have no other fix. Worker-parse (Phase 4) layers on for the pathological single-surface-many-terminals case, behind a per-surface fallback to main-thread parse — it means forking xterm's core (there is no parse↔render seam to cut at; `InputHandler` mutates the buffer, fires events, and pokes the render service in one synchronous call) and carrying that fork against churning 6.x betas, so the fabric must deliver most of its value without it.

**Load-bearing invariant across all phases:** a terminal is owned by exactly one surface at a time, and the compositor is the sole authority on which. This is what makes view-shard → view-shard-plus-worker-parse an internal placement change, not a re-plumb.

## The compositor

`PaintFabricCompositor` (`src/services/terminal/paintFabric/`) replaces the `terminalInstanceService` singleton-per-project role behind the _same_ renderer-facing surface (`TerminalPaintPlane`), so grid components, action definitions, and stores don't change. Responsibilities: surface registry keyed by surface id; terminal→surface placement; per-surface lifecycle; routing focus/input/selection to the owning surface; cross-surface aggregation.

**Hard constraint (inherited from the data-plane router lesson):** the compositor is pure bookkeeping + event routing — never on the per-chunk paint path. Terminal bytes continue to flow pty-host↔owning-surface directly over `MessagePort`; the compositor learns _about_ terminals, it does not carry their bytes or grid deltas. If the compositor ever appears in per-frame LoAF attribution, the design has failed.

## Cross-surface invariants the compositor must re-provide

A single `WebContentsView` silently provides whole-project guarantees because it is one DOM, one focus domain, one input target, one process. Splitting a project across surfaces breaks each one; the compositor must re-provide it explicitly, across process boundaries the browser deliberately isolates.

1. **Focus & keyboard navigation.** One logical focus across processes; grid navigation crosses the view boundary without focus flicker or a double-focus race (`terminalFocusSlice.focusedId` stays authoritative).
2. **Input routing + fleet broadcast.** A broadcast fans out to every surface, applied per-owning-surface, preserving order and the focused-terminal exemption — without the compositor becoming a per-keystroke chokepoint.
3. **Selection & clipboard.** Cross-pane selection semantics re-provided or explicitly scoped per-surface with a documented behavior change.
4. **Grid layout, geometry & drag-drop.** Dragging a terminal from surface A to surface B is a cross-process re-parent (dispose on A, re-open on B, transfer scrollback + state) that must look instantaneous and drop zero input mid-drag. The single most user-visible hazard.
5. **Glyph atlas placement.** Panes in different views cannot share the module-global atlas — view-sharding trades the #8080 cross-pane hazard for duplicated atlas memory and loss of cross-pane glyph sharing across the split. Placement policy clusters same-font/theme terminals on the same surface; the per-view resync subsystem shrinks to within-surface.
6. **Aggregate GPU-context budget.** Per-view count-based mode switches are independent (each view honestly has its own 16), but the machine's GPU memory is shared — the compositor owns a machine-level ceiling bounding total live contexts across surfaces, rather than K views each independently packing to 12.
7. **Viewport / render-pause.** A terminal that moves surfaces carries its visibility/tier state; never "visible" on one surface and "paused" on another after a move.
8. **The singleton + its stores.** Each surface has its own instance registry, ingest buffer, write controller, renderer policy, and WebGL manager; the compositor is the merged registry, and every store/selector that iterates "all terminals in the project" fans across surfaces and merges without cross-attribution.
9. **Context-loss breaker + atlas resync.** Per-surface breakers stay local; a loss storm on one surface must not force sibling surfaces off WebGL; the compositor decides re-host vs ride-out.
10. **Perf diagnostics.** `perfMetricsStore` (fps/LoAF/CLS) and `longTaskMonitor` (LoAF >100 ms + per-script attribution) are per-renderer; post-split, "the project's fps" becomes worst-surface + per-surface breakdown, and LoAF attribution must still resolve.

### Phase 1 watch-list (routing semantics the Phase 0 classification cannot yet express)

Adversarial review of the Phase 0 seam surfaced routing cases that are correct at surface-count 1 but change meaning the moment a second surface exists. Each must be resolved as part of Phase 1, not discovered by it.

- **Subscription rebinding on placement.** Per-id subscriptions (`subscribeUnseenOutput`, `addAgentStateListener`, `addExitListener`, …) made before a terminal is placed route to the default surface; if the terminal is later created on (or moved to) another surface, those listeners are stranded. The cross-surface move/transfer path must rebind per-id subscriptions, or subscription must claim placement.
- **Aggregate-notify dedup.** `subscribeScrollbackRestoreState` subscribes the listener on every surface and `notifyScrollbackRestoreListeners` fans out — under K surfaces one logical state change would fire listeners up to K times. The compositor should own the aggregate listener set and notify once.
- **Cross-surface resize-pass coordination.** `scheduleBatchResize`/`runResizePass` partition by surface, which drops today's global-pass cancellation semantics: a new pass on one surface cannot abort stale chunked resize work on another. Needs a compositor-level resize generation.
- **E2E private-state bridges.** The `__daintree*` WebGL/link bridges reach private state on the primary surface only; multi-surface E2E needs a per-surface debug facade routed through the registry.

`DAINTREE_PAINT_FABRIC` gates the whole thing; default off; revertible to the single-surface path at every step. Per-phase flags pin any phase to last-good.

- **Phase 0 — Seam + parity harness (landed).** `PaintFabricCompositor` implements the `terminalInstanceService` renderer-facing surface (`TerminalPaintPlane`) with exactly one surface — behaviorally identical to today. The perf harness gains the parse-isolation scenario (PERF-034: focused echo p99 under a background flood of N streaming headless terminals) as the baseline the fabric must beat and the regression gate Phase 0 must not move.
- **Phase 1 — View-sharding, naive placement.** Terminals route to K `WebContentsView`s (fixed small K; focused-gets-own-surface or round-robin). Re-provide invariants 1–4. Prove: GPU acceleration survives past 12 terminals; cross-surface drag-drop is seamless; fleet broadcast hits every terminal in order.
- **Phase 2 — Aggregate GPU + atlas placement.** Compositor-level GPU ceiling and same-font/theme clustering. Prove: 20 terminals stay in WebGL without exhausting GPU RAM; the #8080 repro no longer reproduces across surfaces.
- **Phase 3 — Diagnostics + resilience.** Per-surface perf aggregation into a project view; per-surface context-loss breaker with compositor re-hosting.
- **Phase 4 — Worker-parse.** Fork xterm's VT state machine into a worker with a grid-delta stream, behind a per-surface fallback to main-thread parse. Land for the pathological single-surface case first.
- **Phase 5 — Bounded-K placement.** Placement scheduler; surface count capped from cores/RAM; hot/focused terminal promoted to a dedicated surface, cold ones packed.

## Acceptance gates

All measured via the existing renderer-perf infrastructure (`perfMetricsStore`, `longTaskMonitor`, `TerminalWebGLManager` mode-switch counters, deterministic seeded PERF workloads), none tautological.

1. **Parse isolation:** with N−1 background terminals streaming at saturation, the focused terminal's keystroke-echo p99 and scroll frame-gap are within a bounded budget of its solo baseline.
2. **GPU headroom:** a 20-terminal project sustains WebGL rendering — the `evaluateMode` DOM-flip never fires while aggregate live contexts are under the machine ceiling.
3. **Atlas correctness:** the #8080 tiled-colored-TUI repro produces zero cross-surface glyph corruption; within-surface resync frequency drops vs the single-surface baseline.
4. **Layout fidelity:** cross-surface drag-drop transfers scrollback + state byte-for-byte, drops zero input, shows no focus flicker.
5. **Broadcast correctness:** fleet broadcast reaches every terminal across every surface, in order, focused-terminal exemption intact.
6. **No whole-project degradation:** a context-loss storm on one surface never forces a sibling surface off WebGL.
7. **Diagnostic sight:** per-surface fps/LoAF/CLS aggregate into a project view; LoAF per-script attribution still resolves post-split.

## Non-goals

- The pty-host data plane (byte transport, per-shard governance, spill-to-disk, durable sessions) — the companion data-plane fabric. This plane starts where bytes arrive at the renderer.
- No new agent CLIs, no protocol changes, no user-facing feature beyond "fast and GPU-accelerated past ~12 terminals, no glyph corruption, focused terminal responsive under background flood".
- Not a rewrite of xterm as a precondition — Phases 1–3 deliver with unmodified xterm; the fork is an optional depth increase.
- Not OffscreenCanvas — xterm's WebGL renderer is not OffscreenCanvas-capable, and OffscreenCanvas contexts count against the same 16-per-renderer cap, so it neither lifts the GPU wall nor avoids the fork.

## Kill switches & rollback

- `DAINTREE_PAINT_FABRIC` unset/`0` → the single-surface `terminalInstanceService` path, unchanged, at every phase.
- The compositor-behind-the-`terminalInstanceService`-surface seam makes rollback a construction-site swap, not a caller migration.
- A surface that crash-loops falls back to co-locating its terminals on a sibling surface (graceful degradation toward the single view), never to dropping them.
