# Agent Activity Monitoring

Agent activity monitoring is the system that decides whether a live agent terminal is working, waiting for input, completed, or exited. It is a first class product surface: panel badges, toolbar counts, notifications, listener events, project eviction order, and orchestration workflows all depend on it.

This document is the canonical architecture note for agent terminal activity detection. Manual verification lives in [activity-testing.md](../activity-testing.md). Terminal identity rules live in [terminal-identity.md](./terminal-identity.md), and the rationale for building it this way — plus the rubric every new proposal is measured against — is in [agent-state-tracking-strategy.md](./agent-state-tracking-strategy.md).

The `agent:state-changed` events this pipeline emits are also a public surface: `terminal.waitUntilIdle` and the turn-outcome classifier both consume them ([mcp-server.md](./mcp-server.md)), and the fleet-size signal in [resource-governance.md](./resource-governance.md) counts terminals by their FSM state. Changing a transition changes all three.

## First Principles

- Agent state is derived from passive observation. We do not force arbitrary states into the state machine, and we do not modify user-owned agent config.
- The terminal's current visible behavior matters more than scrollback history. Activity detection should inspect the visible tail, currently the last 15 normalized visible lines.
- Spinner and status-line motion are strong liveness evidence. For agent CLIs, a spinner is often the only visible proof that a long model-thinking session is still active. Do not treat spinner motion as decorative noise.
- Resize and reflow are not activity. They must suppress or reseed baselines rather than heat the activity model.
- Both directions require sustained evidence. Entering working requires sustained visible change. Entering waiting requires sustained quiet.
- The model should tolerate backgrounded terminals. Active terminals poll faster; background terminals poll slower but continue analysis.

## Ownership

The core path is:

1. `electron/services/pty/TerminalProcess.ts` owns the PTY, the `@xterm/headless` terminal, parser hooks, and raw output observation.
2. `electron/services/pty/terminalActivityPatterns.ts` builds per-agent detection options from `shared/config/agentRegistry.ts`.
3. `electron/services/ActivityMonitor.ts` turns raw stream events, visible-line snapshots, prompt patterns, synchronized frame signals, CPU hints, and silence into local `busy` or `idle` activity.
4. `electron/services/pty/AgentStateService.ts` maps local activity to canonical agent FSM events and emits validated `agent:state-changed` events.
5. `shared/utils/agentFsm.ts` defines the canonical state transitions shared by main and renderer worker code.
6. Renderer stores and components consume the emitted state. They do not own the detection logic.

Valid canonical agent states are `idle`, `working`, `waiting`, `directing`, `completed`, and `exited`. `directing` is renderer-only. "Running" is not an agent state.

## Runtime Identity Gate

Every terminal is agent-capable, but only live agent terminals enter the agent state monitor. Runtime identity is derived from process detection:

- `detectedAgentId` means the PTY currently hosts an agent.
- `launchAgentId` is only a launch/restart hint.
- Plain processes can promote into agent identity when a user types an agent command in a normal terminal.

The activity monitor starts when an agent identity is detected or expected, and stops when the terminal is no longer live or analysis is disabled.

## Detection Layers

Activity detection is deliberately layered. No single layer is authoritative in all terminal modes.

### Simple Output Mode

Agent monitors run in simple output mode (`simpleOutputState`, set by `buildActivityMonitorOptions` whenever an agent id is present): busy/idle is driven by output observation — the visible-tail temperature model, the OSC 9;4 heartbeat, and the 8s idle debounce — rather than the non-simple working-signal arbitration. The detection layers below still run inside simple mode (#9873): compiled working patterns are matched against the rolling raw-stream buffer in `onData`, completion patterns are scanned from the polling cycle (feeding the `completed` transition with extracted cost/tokens), prompt patterns can exit boot early, every busy→idle transition classifies a `waitingReason`, and the polling cycle stays busy while boot is in progress. The synchronized-frame layer is the exception: `onSynchronizedFrame` returns early in simple mode, so frame signals currently have no consumer for agent terminals.

### Raw Stream And Pattern Layer

`ActivityMonitor.onData()` receives PTY output. It:

- ignores likely user echo and idle-only protocol noise;
- scans raw output with `AgentPatternDetector` for configured working patterns;
- tracks line rewrites with `LineRewriteDetector`;
- resets busy debounce when visible spinner/status-line output continues;
- prevents isolated prompt redraws from becoming working.

Agent-specific working, prompt, boot-complete, and completion patterns come from `shared/config/agentRegistry.ts` through `terminalActivityPatterns.ts`.

### Synchronized Frame Layer

Some CLIs bracket redraws with DEC mode 2026 synchronized output. The headless terminal parser in `SynchronizedFrameDetector` watches for frame close events and captures the bottom rows. `SynchronizedFrameAnalyzer` classifies those frames as:

- `spinner`: localized glyph cycling;
- `time-counter`: monotonic status counter such as `1s`, `2s`, `3s`;
- `cosmetic-only`: confined bottom-row redraw;
- `none`: no structural activity signal.

Spinner and time-counter frames are activity evidence. Cosmetic-only frames can keep an already-working agent alive, but idle-to-working recovery still needs sustained signal.

This layer applies to non-simple monitors only — simple-output agent monitors return early from `onSynchronizedFrame`, so frame signals have no consumer for live agent terminals.

### Escape-Sequence Progress Layer

`electron/services/pty/Osc94Parser.ts` taps raw PTY output for OSC 9;4 taskbar-progress sequences upstream of the rest of the pipeline, so the signal is viewport-independent. This matters for small grid tiles where the visible-tail snapshot is too small to feed the temperature/output detectors. `TerminalProcess` instantiates the parser and feeds every output chunk through `osc94Parser.feed(data, now)`; its callbacks drive `ActivityMonitor.onOscProgressWorking()` and `onOscProgressIdle()`.

State codes follow the de-facto ConEmu spec that Claude Code adopted (v2.0.56):

- `1` (normal/determinate) and `3` (indeterminate) mean working;
- `0` (remove/hide) is emitted between every tool call, so it is treated as advisory only — `onOscProgressIdle` is a deliberate no-op; real idle comes from natural `lastActivityTimestamp` decay through the 8s gate;
- `2` (error) and `4` (paused) are ignored — there is no matching agent state.

The parser is a read-only side channel. `IdleSequenceFilter.stripIdleTerminalSequences` still removes the sequence from the ActivityMonitor byte-volume / activity-gate path, so those detectors stay clean (the renderer keeps the raw bytes and renders the progress bar). `onOscProgressWorking` acts as a heartbeat: it refreshes the working hold without bypassing focus suppression or the `MAX_WORKING_SILENCE_MS` safety net.

### Visible-Tail Temperature Layer

`AgentActivityTemperature` is the current entropy/temperature model. It observes the visible tail instead of the full terminal buffer:

- `AGENT_OUTPUT_ACTIVITY_LINE_COUNT = 15`
- half-life: `4500ms`
- working threshold: `70`
- waiting threshold: `40`
- working dwell: `2000ms`
- waiting dwell: `6000ms`
- activity gap reset: `3000ms`
- resize quiet period: `500ms`

Visible changes add heat. Silence decays heat exponentially. The model emits a `busy` hint only when heat is above the working threshold for the working dwell. It emits an `idle` hint only when heat has cooled below the waiting threshold for the waiting dwell.

The important design rule is that status indicators are high-value activity evidence. A one-character spinner change should not be treated the same as a cursor blink or layout reflow. Observations carry a `signalKind` (#9874):

- `content`: ordinary visible text changes — max change gap `900ms`, minimum `4` changed samples;
- `indicator`: spinner, status line, token counter, time counter — max change gap `2000ms`, minimum `2` changed samples, so a 1Hz countdown or elapsed-time tick can still recover waiting→working;
- `decorative`: changes known not to represent agent progress — heat-capped and unable to drive working by itself.

`ActivityMonitor` owns the classification: the simple-output data path latches `lastStatusRewriteAt` when raw PTY data matches `isStatusLineRewrite`, and the polling cycle classifies a visible-content change as `indicator` when that latch is within `SPINNER_ACTIVE_MS` (`1500ms`). The tight `900ms` content gap (introduced to guard against scroll/resize repaint bursts) is unchanged for unclassified changes. Both directions of this timing contract are pinned by tests: 1Hz indicator output must recover, and 1Hz generic content must not.

### Waiting And Prompt Layer

Working-to-waiting is based on multiple quiet signals:

- temperature cooling through the waiting threshold;
- visible prompt detection;
- completion patterns;
- idle debounce timers;
- watchdog checks for dead waiting states.

Prompt detection prefers the cursor line when available and falls back to visible-line scanning. Waiting transitions can carry a `waitingReason` so UI and listeners can distinguish ordinary prompt waiting from approval prompts.

### Process And CPU Layer

The process tree is supporting evidence, not the primary signal. It prevents premature idle transitions during high CPU or live child-process work and helps the waiting watchdog detect stuck waiting states. Terminal output remains the main activity source because many agent CLIs hide or rewrite process metadata.

## State Flow

The monitor has local activity states:

- `busy`
- `idle`
- `completed`

`AgentStateService.handleActivityState()` maps those to FSM events:

- `busy` + input trigger -> `input`
- `busy` + other trigger -> `busy`
- `idle` -> `prompt`
- `completed` -> `completion`

The FSM then produces canonical agent states:

- `idle -> working` on start/busy/output/input
- `working -> waiting` on prompt
- `waiting -> working` on busy/output/input
- `working -> completed` on completion
- any non-exited state -> `exited` on exit

Agent state changes are emitted through the event bus as `agent:state-changed` (from `PtyEventsBridge`). Suppressed and rejected transition attempts (hysteresis, stale-session, schema validation, no-op) are emitted as `agent:state-transition-dropped` for diagnostics, with the same correlation context (`terminalId`, `cwd`, `traceId`) and an `outcome` discriminator so user reports of false `working`/`waiting` can be triaged from the event inspector. The dropped event is diagnostics tier only — no user-facing UI consumes it.

## Resize Handling

Resize is a special case because xterm reflow can make unchanged logical content look like a large viewport-relative diff.

Current behavior:

- `TerminalProcess.resize()` notifies `ActivityMonitor.notifyResize()`.
- The synchronized-frame analyzer resets because row and column coordinates are invalid after resize.
- The temperature model suppresses observations during the quiet period.
- After suppression, the next visible snapshot is treated as a baseline.
- Repeated resize events extend suppression from the last event. Resize/reflow bursts cannot satisfy working dwell by accumulating across layout changes.

This is a temporal mitigation. A stronger future fix is marker-anchored snapshotting, where visible content is compared relative to stable xterm buffer markers instead of viewport-relative rows.

## Polling Tiers

Active and background terminals use different polling cadences:

- active project terminals: `50ms`
- background project terminals: `500ms`

The PTY and activity monitor continue running when a project is backgrounded. Only the visual streaming and polling cadence are reduced. This is important for multi-window and project-switch workflows: a backgrounded agent must still be able to transition back to working or waiting.

## Tuning Guidance

Change constants only with a test that proves the timing contract.

- Working dwell protects against single stale spinner frames and resize churn.
- Waiting dwell controls how long a quiet working agent remains working before the UI reports waiting. Current target is about six seconds.
- Waiting threshold must match the decay curve. With a `4500ms` half-life, a max-temperature terminal cools to roughly `40` after six seconds.
- Visible-line count should stay at or below what the user can currently see. Raising it risks old scrollback pinning state.
- Spinner/status indicators should be weighted as strong liveness evidence, not decorative churn.

## Failure Modes

Common false-working causes:

- resize or reflow compared against a pre-resize baseline;
- prompt/cursor redraw classified as output;
- stale pattern text still visible in the scan window;
- old scrollback included in the activity snapshot.

Common stuck-waiting causes:

- spinner/status output short-circuited as cosmetic instead of activity;
- background polling cadence too sparse for the recovery gate;
- boot-complete detector not reached;
- agent-specific working patterns missing from the registry.

Common stuck-working causes:

- spinner/status output continues after the prompt is actually ready;
- prompt patterns are missing or too low confidence;
- CPU/process-tree guards keep extending the work cycle;
- idle debounce or temperature waiting dwell is too long.

## Test Coverage

Use these focused tests when changing the monitor:

- `electron/services/pty/__tests__/AgentActivityTemperature.test.ts`
- `electron/services/__tests__/ActivityMonitor.*.test.ts` — split by concern (`simple-output`, `signals-and-completion`, `polling-and-input`, `prompt-polling-hysteresis`, `boot-and-suppression`, `tier-recovery`, `disposal-high-output`, `backstop-reconfigure-watchdog`)
- `electron/services/pty/__tests__/TerminalProcess.lifecycle.test.ts`
- `electron/services/pty/__tests__/LineRewriteDetector.test.ts`
- `electron/services/pty/__tests__/SynchronizedFrameAnalyzer.test.ts`
- `electron/services/pty/__tests__/AgentPatternDetector.test.ts`
- `electron/services/pty/__tests__/Osc94Parser.test.ts`
- `electron/services/__tests__/ActivityMonitor.replay.test.ts` — golden-trace replay of `.cast` fixtures through the production `buildActivityMonitorOptions` path (see [Adding replay fixtures](#adding-replay-fixtures)).

Manual release checks live in [activity-testing.md](../activity-testing.md).

Important scenarios:

- sustained spinner enters or keeps working;
- a short spinner burst does not enter working;
- visible content output enters working after dwell;
- quiet output returns to waiting around the configured target;
- resize suppresses heat and reseeds baseline;
- background terminals recover from sparse spinner/status output;
- prompt redraws and protocol noise do not enter working;
- completion patterns produce completed before waiting.

## Adding Replay Fixtures

The replay suite (`electron/services/__tests__/ActivityMonitor.replay.test.ts`) feeds asciinema v2 `.cast` recordings through the harness in `electron/services/__tests__/replay/castReplayHarness.ts`, which builds the monitor via the production `buildActivityMonitorOptions` path and asserts the recorded state transitions against a sibling `.expected.json`. Fixtures live in `electron/services/__tests__/fixtures/activity-monitor/` and are named `{agent}-{scenario}` (e.g. `aider-working-to-idle`).

A second tier, `electron/services/__tests__/AgentStateFsm.replay.test.ts`, auto-discovers EVERY fixture in that directory (no registration needed) and replays it through the full production chain via `replayCastThroughFsm`: headless xterm → `ActivityMonitor` → the real `AgentStateService` (hysteresis, schema validation, waiting-reason attachment, cost/token extraction, check-result-on-settle) → `agent:state-changed`. A fixture opts into canonical-FSM assertions with an `fsm` block in its `.expected.json`:

- `fsm.transitions` — expected `idle/working/waiting/completed/exited` timeline, with optional `trigger`, `waitingReason`, `sessionCost`, `sessionTokens`, `exitCode` per entry.
- `fsm.checkResult` — the settled `lastCheckResult` (`{ passed, commandIncludes, failureSummaryIncludes }`); `null` asserts none was extracted.
- `fsm.finalWaitingReason` — the waiting reason the terminal must settle on.
- Top-level `forbidden` — transitions that must NOT appear (`{ scope: "activity"|"fsm", state, betweenMs }`), for pinning false positives like "resize noise must not enter working". Checked even under `allowExtraTransitions`.
- Cast `x` events (exit code in the data field) drive the FSM exit path, so non-zero exits and exit metadata are assertable.

`npm run pattern-discovery:eval` runs both replay tiers plus the JSONL corpus gate and writes a score report (per-agent pass rates, failure classes: false positives/negatives, wrong waiting reason, wrong check-result extraction) to `.tmp/agent-state-eval/report.md`.

### Workflow: corpus → convert → trim → calibrate

1. **Get a recording.** Either convert a pattern-discovery JSONL corpus (`scripts/pattern-discovery/corpus/*.jsonl`, recorded via `npm run pattern-discovery:record -- --agent <id>`) with `npm run pattern-discovery:jsonl-to-cast -- --corpus <corpus.jsonl> --out electron/services/__tests__/fixtures/activity-monitor/{agent}-{scenario} --width 120 --height 10`, or redact a real terminal capture with `npm run pattern-discovery:redact-cast -- --in capture.cast`.
2. **Redaction is mandatory for field recordings.** Both tools run `scrubReportText` (user paths, git remotes, tilde/temp paths, all secret sigils in `shared/utils/secretScrubber.ts`) over every event at the write boundary, so converter output is safe by construction; for hand-edited or externally recorded casts, run `redact-cast` before committing and eyeball the result — the scrubbers are a backstop, not a substitute for review. Never commit the `.bak` file the in-place mode leaves behind.
3. **Trim.** Cut events that don't serve the scenario (post-prompt chatter, resume hints) so the fixture ends on the signal you're asserting — a trailing low-byte hint line can re-arm output-activity detection and turn a clean prompt-idle into a timeout-idle.
4. **Calibrate.** The converter writes a stub `.expected.json` with a `STUB_REPLACE_ME` sentinel that always fails. Run `npm run pattern-discovery:eval` (the FSM-tier spec discovers the fixture automatically; adding it to `REPLAY_CASES` in the activity-tier spec is optional), copy the timings from the `Recorded transitions`/`Recorded FSM` blocks in the failure output into real `transitions` entries, and delete the `_stub` field. Re-run to confirm green. A fixture needing custom `pollingMaxBootMs`/`maxWorkingSilenceMs` overrides can declare them in `.expected.json` directly.

### Fixture-authoring gotchas

- **Terminal geometry is load-bearing.** Prompt and visible-tail detection read the bottom rows of the viewport, so size `height` small enough (existing fixtures use `120x10`) that meaningful content lands in the bottom `promptScanLineCount` rows — a 30-row terminal with 14 lines of content leaves the scan window empty and silently downgrades prompt/completion detection to timeout-idle.
- **Line-structured vs raw events.** Synthetic corpora store bare strings with no control characters; the converter auto-prepends `\r\n` to each event (`--line-events`/`--raw` to force) so cursor-line prompt detection works. Raw PTY captures already carry their own line discipline and must convert with `--raw` semantics (the auto-detect handles this).
- **Timing pins.** The harness starts from the production options (`simpleOutputState`, the 8000ms debounce floor); a fixture may still pin `idleDebounceMs`/`promptFastPathMinQuietMs` in its `.expected.json` (aider/goose pin the legacy 6000ms) — stating them explicitly keeps the calibrated `atMs` values self-documenting.
- **OSC 9;4 routing is wired** (#8701): the harness feeds cast output through an `Osc94Parser` into the monitor's progress callbacks, matching production; `claude-osc94-progress-keeps-working` pins the behavior (and `routeOsc94: false` exists to prove the delta).
- **Cast format is v2** (absolute timestamps). The harness also parses v3, but v2 is what the tooling emits and what hand-editing expects.

## Future Work

- Add marker-anchored visible snapshots for structural resize immunity.
- Add transition telemetry that records temperature, heat, changed chars, trigger, and suppression reason.
- Add property tests for decay invariants, dwell impossibility, resize suppression, and external temperature reads.
- Parse OSC 133/633 shell-integration signals when agents provide them, while keeping passive observation as the fallback.
