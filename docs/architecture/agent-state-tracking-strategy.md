# Agent State Tracking Strategy

Daintree tracks agent state — whether Claude / Gemini / Codex / etc. is working, waiting, blocked, completed — through **passive PTY observation only**. Vendor telemetry exports, JSON-RPC transports, OpenTelemetry injection, and `--print`-style headless modes have been considered and deliberately rejected.

This document is the strategy companion to [agent-activity-monitoring.md](./agent-activity-monitoring.md), which documents the implementation. This doc explains why we built it the way we did, what we have rejected, and the rubric for evaluating future proposals.

## The position

The PTY-based detection layer is the canonical agent state source. It is not a fallback or a compromise — it is the layer. Three properties make it the right choice:

1. **Universal.** Every agent we support emits something to a PTY. The detection cascade (`AgentPatternDetector`, `ActivityMonitor`, `AgentActivityTemperature`, `WaitingReasonClassifier`, `CompletionDetector`) works the same way for Claude, Gemini, Codex, Aider, OpenCode, Goose, and any agent we add tomorrow. Per-agent tuning happens inside one config file (`shared/config/agentRegistry.ts`) rather than across separate transport implementations.
2. **Stable.** Spinners, prompts, status lines, and the patterns we detect are user-facing UI vendors change slowly and visibly. When they do change, our test suite catches it and we update one file. Vendor stdout drifts on a quarterly cadence; vendor private telemetry formats drift weekly.
3. **Inside the agent-config-boundary.** Reading stdout does not require modifying user-owned config files. The detection layer respects the boundary by construction — there is no way to accidentally violate it from inside the detection pipeline.

The detection layer is also already capable. It distinguishes idle / working / waiting / completed / exited with multi-layer evidence, tolerates backgrounded panes, classifies waiting reasons, extracts cost and token metadata from completion lines, and recovers from spurious activity caused by resize. The bar for adding to it is therefore high.

## What we have rejected

### OpenTelemetry env-var injection at spawn

The proposal: set `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=…` (and the Gemini equivalent) at PTY spawn, embed a local OTel collector in Daintree, and consume token / cost / tool-call events as primary state signal.

Rejected because:

- Per-vendor brittleness. Each agent exposes a different env-var contract; each vendor changes attribute names and span semantics independently. The OpenTelemetry `gen_ai.*` semantic conventions are still in the experimental / incubating modules. Building on a moving target multiplies our maintenance surface by the number of agents we support.
- Coverage is not universal. Gemini and Codex do not expose this consistently. We would end up running the PTY layer anyway for the long tail of agents.
- It creates a parallel state pipeline. Two sources of agent state means reconciliation logic, ordering bugs, and a permanent edge-case backlog (e.g., the OTel event arrives after the PTY layer has already moved the FSM).
- The detection layer already provides what the telemetry would provide. `CompletionDetector` extracts cost and tokens. The waiting / working signal is correct. Adding a parallel extractor does not make the existing one wrong.

### `--print` / `--output-format json` / `stream-json` headless modes

The proposal: spawn agents in headless mode with structured JSON output instead of an interactive PTY for one-shot tasks.

Rejected because:

- Pricing. Anthropic's `-p` flag bills against a separate, lesser API allocation. Users with Claude Pro / Max subscriptions do not get the per-message quota they expect when Daintree spawns headless sessions on their behalf.
- Wrong product. Daintree is a terminal-first product. Users open it to watch their agents run, intervene, and adopt outputs in context. Headless mode turns Claude into a non-terminal background process — that is the opposite of what users open Daintree for.
- Reduced agent capability. Many agents disable features in non-interactive mode: interactive permission prompts, MCP tool approvals, plan steps with user feedback. Daintree's UX depends on those.

### Codex `app-server` as a panel kind

The proposal: spawn Codex via `codex app-server --listen stdio://` to receive `turnCompleted` / `item/agentMessage/delta` JSON-RPC events instead of PTY output.

Rejected because:

- Codex-specific. Solves one agent, leaves every other agent on the PTY layer anyway. Net result: more code paths, not fewer.
- Different panel shape. Codex app-server is not a terminal — it is a JSON-RPC stream. The panel architecture (`shared/types/panel.ts`, `src/panels/registry.tsx`) assumes PTY-shaped panels. Supporting a Codex-app-server panel kind would require new panel data, serializer, defaults factory, renderer component, IPC service, child-process stdio JSON-RPC manager, and resource tracking. That is a structural product change for one transport.
- No UI parity. Users would not see Codex output the way they see Claude and Gemini output. The same product, two visibly different agent experiences.

### ACP (Agent Client Protocol) as state transport

The proposal: speak ACP to every agent that supports it.

Rejected because:

- Wrong protocol layer. ACP is for editor-to-agent UI routing — chat messages, file diffs, terminal output. It is orthogonal to MCP (tool calls) and orthogonal to state detection. Daintree's job is closer to MCP-as-host than ACP-as-client.
- Adds no signal the PTY layer does not already see. ACP would route the same content we already observe through stdout, in a different envelope. Re-parsing the same surface is not a capability lift.

### Heartbeat-style MCP self-reporting tools

The proposal: expose `daintree.session.heartbeat(state, summary)` as an MCP tool the agent calls to report its own working / waiting / completed state.

Rejected because:

- Requires agent cooperation that does not exist by default. Agents would have to be prompted to call the tool. Prompts drift; cooperation degrades; the tool gets called inconsistently across recipes, sessions, and agents.
- The PTY detection layer is already correct. Self-reporting adds no information the existing layer cannot infer from observable behavior.
- Creates two sources of truth. When the agent says "working" but the PTY has been silent for 30 seconds, the fuser has to pick one — and either choice is wrong half the time.

MCP tools that are not state-detection (memory, context queries, fleet coordination, task lists, scheduling) are unaffected by this rejection. Those add capabilities the agent does not otherwise have; they are not bolt-ons to the state layer.

## When to add to the detection layer

Adding to the PTY detection layer is the right move when:

1. A new agent introduces a pattern the existing detectors do not catch. Extend `shared/config/agentRegistry.ts` and `AgentPatternDetector`.
2. A failure mode catalogued in [agent-activity-monitoring.md § Failure Modes](./agent-activity-monitoring.md) is observed in the wild. Tune temperature constants or add a structural detector, guarded by the existing test suite.
3. A new waiting reason can be classified from terminal output (rate-limit messages, network errors, distinct approval flows). Extend `WaitingReasonClassifier`.
4. A structured terminal signal becomes available that does not require modifying user agent config — for example, OSC 133/633 shell integration sequences emitted passively by the agent itself. These should land as a detector tier alongside existing layers, not as a replacement for them.

It is not the right move when:

1. The proposal pipes structured events from the agent vendor's private telemetry channel.
2. The proposal modifies user-owned agent configuration in any way (settings files, hooks, project rule files).
3. The proposal requires headless spawn (`--print`, `--output-format json`) instead of interactive PTY.
4. The proposal adds a second authoritative state source alongside the existing layer.

## Decision rubric

Before accepting a new agent-state source, the proposal must answer yes to all of these:

1. **Does it survive the vendor renaming or removing a flag?** If a Claude release renames an attribute or removes a CLI flag, does the detection still work? If the answer is no, the proposal multiplies our vendor-tracking burden.
2. **Does it work for agents we have not added yet?** Detection mechanisms that require per-vendor integration scale linearly with the number of agents we support. The PTY layer scales sublinearly because new agents inherit existing detection patterns.
3. **Does it stay within the agent-config-boundary?** No mutations to user-owned config files. No `--settings` injection. Env vars at spawn are permitted only when they do not alter behavior the user would experience outside Daintree.
4. **Does it reduce the surface that can break, or expand it?** A new source of state is a new source of bugs. If the existing layer covers the case at acceptable quality, parallel detection makes things worse, not better.

If the proposal fails any of these, it does not belong in the state-tracking layer. Either reshape it as a Daintree-side UX feature that surfaces data the PTY layer already produces, or file it as a vendor feature request.

## Related

- [agent-activity-monitoring.md](./agent-activity-monitoring.md) — the implementation of the detection layer
- [terminal-lifecycle.md](./terminal-lifecycle.md) — PTY lifecycle, pane attachment, hibernation
- [terminal-identity.md](./terminal-identity.md) — `detectedAgentId` vs `launchAgentId`
- [`CLAUDE.md`](../../CLAUDE.md) "Product invariants" — **never modify user-owned agent config**, the principle that gates spawn-time behavior (precedent #4100)
