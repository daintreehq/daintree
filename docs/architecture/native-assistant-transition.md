# Native Daintree Assistant — transition strategy

Status: strategy, pre-implementation. Supersedes the runtime half of [`assistant-native-host.md`](./assistant-native-host.md), whose contract is stale in three specific ways documented in §2. The assistant's own side of the boundary is `daintreehq/assistant` `internal/host/` and [`docs/DAINTREE_HOST.md`](https://github.com/daintreehq/assistant/blob/main/docs/DAINTREE_HOST.md).

The goal: the in-app assistant stops being a TUI rendered inside an xterm pane and becomes a native React surface that looks and behaves like Daintree — its theme, its confirm dialogs, its notification tiers, its motion timings — and can reference Daintree's own objects (worktrees, runs, terminals, PRs) as clickable things rather than as text about things. It is the primary monetization surface, so the presentation of account, quota, and upgrade lives here too.

## 1. The decision

**Keep the Go engine. Bundle it as a vendored binary. Replace only the renderer.**

Three options were weighed. The numbers come from the assistant repo at the time of writing.

|  | Rewrite in TypeScript | Rewrite in Rust as an N-API module | **Keep Go, replace the renderer** |
| --- | --- | --- | --- |
| Runtime to re-derive | 78,002 lines | 78,002 lines | 0 |
| Tests to re-earn | 95,962 lines | 95,962 lines | 0 |
| Renderer to write | ~the same | ~the same | ~the same |
| Backend wire contract | second implementation, must track a moving Python service | second implementation | one implementation, already guarded |
| Crash isolation | good (utility process) | **none** — a panic across N-API aborts the host | good (separate process) |
| Distribution | trivial | **worst case** — ABI-pinned to Electron's Node, breaks each Electron major | ABI-free binary, just runs |
| Cross-compile | n/a | **loses** the single-runner story — see §1.4 | one Linux runner, six targets, seconds |
| Perf ceiling | worst (I/O-bound, but single-threaded JS) | no gain (workload is I/O-bound) | no gain needed |
| Standalone CLI / SSH / headless | lost or maintained twice | lost or maintained twice | retained free |

The renderer — `internal/ui` (Bubble Tea cockpit) plus `internal/cli/render` — is **11,046 lines, 12% of the non-test code**. Everything else is renderer-agnostic: the turn engine (`agent`, 7,856), the backend client (`backend`, 5,162), the scheduler and watcher engine (`daemon`, 4,140), durable state (`storage`, 4,006), the workflow ledger (`workflowgraph`, 2,530), the MCP client (`mcp`, 2,234), the tool registry and its twenty families, plus `safety`, `supervisor`, `asyncwork`, `subagent`, `redact`, `costledger`, `ipc`.

### Why the rewrite argument fails specifically here

The runtime is not generic plumbing that an LLM can re-emit. It is a **client of a strict, versioned, independently-deployed contract** — the Python assistant-backend — and that contract is validated with `extra="forbid"`, which means a client that guesses wrong doesn't degrade, it 422s the entire turn. The Go client encodes a long tail of hard-won rules that are invisible from the outside:

- Retry classification keys on `error.code`, **never** HTTP status, because the backend emits `meta` before opening the upstream stream, so most of the failure taxonomy arrives as a terminal SSE event with `HTTPStatus == 0`. A status-based rule reverses its answer depending only on how far the request got.
- Cost `complete: false` means `total` is a **floor**, and an absent cost block means _unknown_, never _free_. Get either wrong and a quota meter silently under-bills.
- Task ids are a frozen wire contract with an **AST-level guard** (`taskcheck_test.go`) because on 2026-07-07 the backend dropped a `.v1` suffix from every task id; the count was unchanged and both sides asserted only a count, so every test stayed green while every task call 404'd mid-turn.
- Proxy bypass and the loopback trust predicate are derived from **one** function so they cannot disagree — otherwise four spellings of localhost would be trusted by one check while being routed through `HTTP_PROXY` in cleartext by the other.

None of that is discoverable from the spec. It was discovered in production. A second implementation means a second place to rediscover it, kept in lockstep with a service that ships independently. **One engine, many renderers** is the only shape where that contract has a single owner.

### 1.4 The Rust option, tested rather than dismissed

Two distinct Rust proposals came up and they fail for different reasons. Both were tested against measurements and external research rather than argued from priors.

**As an in-process N-API native module** — rejected outright, and it is the one option strictly worse than both others:

1. **It defeats its own stated goal.** A napi-rs/neon addon is a `.node` loaded _in-process_. It is not a separate process; it is the opposite. `assistant-native-host.md` already rejected in-process embedding — _"an assistant-SDK crash would take down the main process."_ A Rust panic crossing the N-API boundary aborts the host. A spawned binary gives full OS-level isolation and true parallelism, which is strictly better than addon threads sharing the host heap.
2. **Native modules are the heaviest distribution burden Electron has, and Daintree already pays it.** `postinstall` rebuilds `node-pty` for Electron; `npm run rebuild` exists because it breaks; CLAUDE.md carries the "better-sqlite3 needs a V8 14.8 patch" trap. A Rust addon adds ABI pinning to Electron's Node ABI and a rebuild break on every Electron major. A standalone binary is ABI-free. **The binary is easier to ship than the addon, not harder.**

**As a headless standalone binary replacing the Go one** — the stronger version of the proposal, and the one that deserved real testing. It still loses, on four findings:

**(a) It inverts the bundle-size argument it was meant to solve.** Go reaches all six targets from one runner with `CGO_ENABLED=0` _because_ `modernc.org/sqlite` is pure Go. Rust has **no production-grade pure-Rust SQLite** — `rusqlite`, `sqlx` and `libsql` all link the C amalgamation via `libsqlite3-sys`, whose `build.rs` invokes `cc-rs` and therefore needs a target C toolchain on `PATH`. On top of that, `reqwest`/`rustls` now default to `aws-lc-rs`, which wants CMake and NASM unless you explicitly switch crypto providers. The practical outcome is `cross` (Docker), `cargo-zigbuild`, or a six-runner CI matrix — where Go is one runner and seconds. **The rewrite makes the bundling story worse, which was the argument for it.**

**(b) The size premise doesn't survive measurement.** Measured, not estimated: the default build is 33.3MB; `-ldflags="-s -w"` takes it to **23.9MB**. Against a 410MB installed app that is **5.8%**, recovered by one linker flag. And if the plan is headless-only, the entire TUI stack — bubbletea, lipgloss, glamour, chroma, goldmark, bluemonday and friends — accounts for just **2.13MB of symbols**. Dropping the renderer saves ~2MB, not the double-digit figure the argument assumes. A Rust binary might land near 15MB; the delta is roughly 2% of the app.

**(c) The dependency maturity runs the wrong way on the one axis that matters most.** The Rust MCP SDK (`rmcp`) is at v0.1.x with breaking changes between patch releases; the Go SDK in use is v1.6.x with stable client interfaces. This is the protocol-sensitive dependency in a product whose entire value is protocol conformance. Likewise, Rust's SSE story (`reqwest` + `eventsource-stream`) is a low-level parser: reconnection, backoff, jitter and `Last-Event-ID` tracking are hand-rolled — and the retry policy in `internal/backend/retry.go` is among the most carefully reasoned code in the repo.

**(d) The "an LLM can do it in 6–8 hours" estimate measures the wrong 5%.** Published data on LLM-assisted ports of 50k–100k-line systems puts _agentic code generation_ at 2–4 days and ~5% of total effort, with verification, borrow-checker resolution and silent-behaviour debugging taking 80%+ — a realistic **12–17 weeks end-to-end** for 78k lines. LLMs cut drafting time by an order of magnitude and verification effort by only 30–40%.

The specific hazard in "we just rewrite the tests and do TDD" is a **circular validation loop**: if the model misreads an undocumented edge case in the Go source, it translates the test with the same misreading. The Rust test passes, and the behaviour has diverged. The consensus mitigation is explicit — never validate translated code against translated unit tests; validate differentially against the _original binary_ using recorded I/O. Go→Rust has a well-catalogued set of these: zero-value/`nil` semantics translated as `.unwrap_or_default()` silently taking a fallback branch that the Go original branched on; partially-populated structs abandoned by `?` early-return; goroutine/channel scheduling that does not map onto Tokio tasks; and integer overflow that wraps in Go but panics in debug Rust.

None of this says the rewrite is impossible. It says the honest price is **a quarter of engineering attention for a quarter of a year, on the primary monetization surface, to arrive at feature parity with something that already works** — and to end up with a worse cross-compile story than the thing it replaced.

### 1.5 Where the counter-argument is right

Two of the objections land, and both are answerable without a rewrite.

**"The Go binary bloats the bundle"** is directionally true and worth acting on — just not by changing language. Ship with `-ldflags="-s -w"` (33.3MB → 23.9MB, free), and if the headless-only direction is taken, put the cockpit behind a build tag so the shipped binary drops the TUI stack too (~2MB more). That recovers essentially the whole size delta Rust was being asked for, at zero risk.

**"There's no standalone audience for the CLI, so it's dead weight"** is the sharper objection, and it dissolves once the audience is named correctly. The audience is not end users — it is **development of the assistant itself**. `mcp --stdio` makes the assistant drivable as a sub-agent by Claude Code; `--json --multi-turn` gives a JSONL transcript with `skill:decision` and `selector.degraded`, which is how you tell a bad runbook from a bad selector; `--skill` pins a runbook so a failed turn is unambiguous; assistant-lab calls the binary directly. That is exactly the loop for having a large model iterate on orchestration workflows headlessly — which is a stated goal. Under the "keep Go" plan that loop is retained for free. Under either rewrite it is rebuilt or lost.

The honest concession: this does mean **one more language in the stack, and a cross-repo contract to keep in lockstep**. §2 is what happens when you stop paying that. The mitigation is to make the contract versioned, schema-owned and tested from golden transcripts on both sides (Phase 1) — not to delete the language.

### 1.6 The sharpest criticism is about topology, not language

An adversarial review of this plan landed one hit worth writing down: _"you are preserving too much of the existing topology, not too much Go."_

The supervisor daemon, the flock ownership lease, the control socket and the attach/detach handover all exist for one reason — the cockpit is an **ephemeral terminal process** that dies when the user closes a panel, so supervision has to survive it in some other process. In the native world that premise is gone: the Electron app is the long-lived process, it owns the panel's lifecycle, and it is already running whenever the assistant is. The assistant's own ARCHITECTURE.md names the destination — _"Option C — Daintree-owned watch-sets over MCP … remains the long-term target"_ — and identifies the seams that would be swapped.

That reframes two things:

- **Windows gets easier, not just fixable.** If the host process's lifetime is owned by Electron and there is exactly one owner per project by construction, much of what the flock lease defends against stops being reachable. Phase 0 should still implement `LockFileEx` — the standalone CLI needs it, and the Windows release matrix currently ships only darwin and linux — but the native path should not _depend_ on the lease being the answer.
- **"The CLI is dead weight" justifies retiring the CLI as a product, not discarding the engine beneath it.** Those are separable, and conflating them is what makes the rewrite look necessary. Retire the surface; keep the runtime; move ownership to the IDE where the product actually lives.

One more thing that review surfaced, worth taking as a general warning: `docs/ARCHITECTURE.md` states the storage schema is "currently 7" while the code has moved past it. **The tests and the executable are the specification; the prose drifts.** That is also the single strongest argument against translating this codebase into another language on the strength of reading it.

### Framing that follows from this

The assistant repo stops being "a CLI we also maintain" and becomes **the assistant engine**. Daintree's native panel is its primary renderer. The Bubble Tea cockpit is demoted to the **headless/SSH renderer** — still shipped, still useful (drive your fleet from a box you SSH'd into), but no longer co-equal, and never the thing feature parity is measured against.

## 2. What already exists — and why it doesn't fit together

Both halves of this boundary were built, then stalled, and **they no longer match**. This is the most important finding of the research, because it means the work is not "build a protocol" but "reconcile two that already exist".

**Daintree's half** (protocol version **1**, dead code — `knip.config.ts` lists it as a known-unused entry):

- `shared/types/ipc/assistantHost.ts` — the full typed event/command union, `ASSISTANT_HOST_PROTOCOL_VERSION = 1`
- `electron/schemas/ipc.ts` — Zod validators for it
- `electron/services/assistant-host/AssistantHostProcess.ts` (180 lines) + `resolveHostEntry.ts` (64)
- `docs/architecture/assistant-native-host.md` — the decision record

**The assistant's half** (protocol version **2**, live and wired via `internal/cli/host.go`): `internal/host/` — 2,440 non-test lines plus ~2,000 lines of tests covering the transport, the bridge, interrupts, injection strands, and wake/shutdown.

Three mismatches, each fatal on its own:

|  | Daintree assumes (v1) | Reality (v2) |
| --- | --- | --- |
| **Artifact** | an npm package, `@daintreehq/daintree-assistant`, with a forkable `dist/host.js` | a single self-contained **Go binary** discovered on `PATH` |
| **Mechanism** | `utilityProcess.fork()` | `utilityProcess.fork()` runs a **Node script**. It cannot run a Go binary. |
| **Transport** | structured-clone `postMessage` | **stdio NDJSON line frames** |

The transport change is precisely _why_ the Go side is v2 — `wire.go` says so: _"the transport is stdio NDJSON line frames. The framing is a breaking change for any consumer of an older format, so the version moves in lockstep."_ The version moved; Daintree didn't.

**Conclusion: Daintree's half must be rewritten, not resumed.** `resolveHostEntry.ts` is deleted outright (there is no npm package to resolve). `AssistantHostProcess.ts` is replaced. The _type union_ in `assistantHost.ts` survives largely intact and is the right starting point — it is already audit-vocabulary-aligned with `mcpServer.ts`, which is a property worth keeping.

### What else is already built and reusable

The native panel is not starting from zero on the Daintree side either:

- **`McpActivityTracker`** (`src/controllers/`, ~700 lines) already consumes structured tool-call started/settled events, tier-mismatch prompts, grant lifecycle, and the turn-outcome pip. It is a working native timeline fed by MCP rather than by the host stream — retarget it, don't rebuild it.
- **`FigureRail` / `FigureLightbox`** already render assistant-produced figures natively.
- **Markdown**: `react-markdown` + `remark-gfm` + `refractor` are in the dep tree with `src/components/Markdown/` and a themed `MarkdownDocument.css` prose layer.
- **Packaging**: `electron-builder.config.cjs` already has `extraResources`, an `afterPack.cjs` that validates binary presence and prunes foreign architectures (#11829), an `afterSign` notarize hook, `hardenedRuntime: true` and entitlements. A vendored binary slots into machinery that exists.
- **Process precedent**: `pty-host`, `workspace-host`, `watchdog-host`, `plugin-dev-worker` — four existing `utilityProcess.fork()` children with `parentPort` IPC and a `MessageChannelMain` port to the renderer.

## 3. The protocol is the product — close its gaps first

The current v2 event set is a faithful description of _a terminal session_. It is not yet a description of _what the assistant does_. Build the React panel against today's events and you get a prettier terminal.

Worse than incomplete, it is **lossy by construction**, and this is the finding that changes the plan. `internal/host/transport.go` bounds the outbound writer queue at `outQueueDepth = 1024` with a deliberately **non-blocking** enqueue — the comment is explicit that "a full queue / closed transport drops the frame", chosen so a wedged stdout can never park the command loop. That is the correct trade for a TUI parent. It is the wrong one for a chat transcript, because there is no sequence number, no acknowledgement, no replay, and no snapshot — and `EvTurnEnd` carries only `turnId`, `endedAt` and `outcome`, with **no canonical final text**. So a single dropped `turn:token` frame silently corrupts the transcript with no way for either side to detect it, let alone recover.

`internal/host/bridge.go` then discards several signals on purpose, each with a comment saying so: `Phase` ("live-only UI vocabulary with no host-protocol channel — dropped"), `Interjection`, `SkillLoaded`, and the assistant's reasoning ("reasoning is not forwarded over the host protocol"). Warnings, informational messages, usage and rate-limit state have no channel either.

**Conclusion: do not resume v2 — define v3.** Nothing is bound to v2 today (Daintree is at v1 and dead), so there is no compatibility cost to designing the protocol from the native product's requirements instead of from the TUI bridge's. v3 must add, on top of the gaps below: monotonic sequence numbers with replay or snapshot-on-reconnect, explicit backpressure instead of silent drops, and authoritative final content on `turn:end` so a lost frame is recoverable rather than invisible.

**Today, host → Daintree:** `host:ready`, `turn:start`, `turn:token`, `turn:end`, `tool:started`, `tool:settled`, `approval:requested`, `approval:decided`, `host:error`, `host:shutdown`. **Today, Daintree → host:** `prompt`, `approval:decide`, `interrupt`, `hibernate`, `shutdown`.

Gaps, ranked by product value:

1. **Run and cohort events — the highest-value addition by far.** The assistant's actual job is spawning and supervising visible agents in worktrees. Today `agentTask.spawnForEdits` settles as a generic `tool:settled` carrying a string. Native needs `run:started` / `run:updated` / `run:settled` carrying worktree id, terminal id, agent id, and supervision state — so a **run card** in the transcript is a live object joined against `AgentStateService` and `WorktreeMonitor`, clickable, focusable, killable. This is the single thing a PTY structurally cannot do, and it is the reason to do any of this.
2. **Cost and usage.** `internal/costledger` is process-internal. A monetization surface needs spend, quota, and plan state on the wire. Carry the backend's own figures verbatim, including `complete: false` — never a client-side estimate.
3. **Structured content blocks.** `turn:token` is a raw string, so there is no way to distinguish prose from reasoning, a plan, a table, a code block, or a reference to a Daintree object. Replace it with a block-addressed stream (`block:start` / `block:delta` / `block:end` with a typed block kind) so a reference to worktree `wt_x` arrives as data and renders as a chip.
4. **Attention / inbox.** Background completions land in the durable attention queue and are invisible to the host. The "While you were away" summary (`App.AttachSummaryLines`) has no wire event. Native should route these to Daintree's inbox tier, not into the transcript.
5. **Skill / selector decisions.** `--json` already emits `skill:decision` with `selector.degraded`; the host protocol doesn't. Needed for `/explain` and for debugging a bad turn.
6. **Transcript rehydration.** `host:ready` carries `resumedSessionId` but no history. The panel must be able to ask the engine for the conversation held in `state.db` — otherwise every reveal is a blank panel with a live backend.
7. **Slash-command catalog.** `internal/commands` is a real catalog with handlers. Native needs it enumerable so the composer can offer a command palette rather than hard-coding strings.
8. **Figures on-stream.** Today figures route out-of-band via MCP `help.displayImage`. Fold them into the host stream so ordering is defined.

Missing commands: `interject` (fold a prompt into the running turn — the engine supports it; the wire doesn't say so), `cancelTool`, `clear`, `command` (invoke a slash command), `history` (rehydrate), and **`display`**.

`display` deserves its own note. `BACKEND.md` documents `runtime.display` as `{columns, content_width}` **in terminal cells** — the backend's entire response contract is written against a measured terminal width. A native panel has no cells. Without a native display mode the model keeps formatting prose for a terminal it is no longer rendering into. **This is a backend change, not just a CLI one**, and it needs scheduling into the assistant-backend repo early because it gates how good the native output actually looks.

### Should this be ACP instead?

Considered and declined, with one thing borrowed and one door left open.

[ACP](https://agentclientprotocol.com/) is JSON-RPC 2.0 over stdio with `session/new`, `session/prompt`, `session/update`, and `session/request_permission` — structurally very close to what v2 already does, which is a good sign that v2's shape is right. But ACP's domain is **code-editing agents**: its capability surface is `fs/read_text_file`, `fs/write_text_file`, and diff review. The Daintree assistant _never edits files_ by design; its domain is fleet orchestration, for which ACP has no vocabulary. Everything in gap #1 would have to be smuggled through `_meta` extensions, at which point you have a bespoke protocol wearing a standard's clothes.

Borrow instead: ACP's **block-addressed session update model** is the right answer to gap #3, and its `_meta` extension convention is the right forward-compat escape hatch.

Leave the door open: Daintree orchestrates 15+ agent CLIs, and ACP adoption is now broad — Zed and JetBrains natively, community plugins for VS Code, Neovim and Emacs, with Claude Code and Codex reachable through adapters. A future where **Daintree is an ACP client** and any ACP agent gets a native panel is a genuinely interesting product bet. It costs nothing today to keep the panel's view layer agent-agnostic — model the store around a generic session/turn/block/tool shape rather than around `daintree-assistant` specifics — so that bet stays cheap to take later. Do not build it now.

### Verdict on the Vercel AI SDK

**Don't use it for the model layer, and don't use AI Elements for the view.**

The AI SDK solves three problems: provider abstraction, the tool-call loop, and streaming from an OpenAI-shaped backend. All three are owned elsewhere and better — the Python backend owns model routing, prompt assembly and skill selection; the Go engine owns the tool loop, permissions and audit; and the wire is a bespoke NDJSON event stream, not an AI SDK data stream.

The only piece with any pull is `useChat` with a custom `ChatTransport` mapping NDJSON to `UIMessage` parts. But that makes `UIMessage.parts` your canonical message model, and the domain objects that matter — runs, cohorts, worktrees, approvals, quota — become `data-*` parts fighting an abstraction designed for chat-with-tools. AI Elements is shadcn-flavoured and would fight the design rules in CLAUDE.md on contact: accent restraint, the shared motion tiers, the 400ms Doherty loading gate, the notification routing matrix.

**Instead:** a Zustand store fed by a plain reducer over the host event stream — on the order of 500 lines, and you own the message model. Reuse the `react-markdown` + `remark-gfm` + `refractor` stack that is already in the tree and already themed, adding incremental/throttled rendering (parse only the delta, flush per animation frame) rather than swapping to a new renderer. Streaming markdown is O(n²) if you re-parse the accumulated string per token; that is the one perf trap worth engineering around up front.

## 4. Runtime architecture

### Process shape

Not `utilityProcess.fork` of the binary — that runs a Node script and cannot execute a Go binary. Two viable shapes:

**(a)** main process `child_process.spawn` + bridge to the renderer over `MessagePort`. **(b)** a thin Node `utilityProcess` (`assistant-host`) that spawns the Go binary, parses NDJSON, and forwards validated structured events over a `MessageChannelMain` port to the pinned renderer.

**Choose (b).** NDJSON parsing plus a token stream is a hot path, and main's event loop is already a known pain point in this app — project-switch stalls of 1–1.75s are on record. (b) keeps that work off main, reuses the established four-process pattern rather than inventing a fifth, gets crash supervision from `utilityProcess.on("exit")`, and inherits the bootstrap error-guard rule (#8833: install the guard synchronously before any dynamic `import`, or a failed import hangs the readiness wait silently under Electron 42).

Two mechanics to get right at the seam: **coalesce token deltas per animation frame** before they cross the port, and **honour backpressure** by pausing the child's stdout when the port's queue grows. Per-chunk `setState` will jank a long transcript.

### Bundling

**Bundle it.** The evidence that this is cheap is strong:

- The assistant is **CGO-free**. `modernc.org/sqlite` is pure Go; `creack/pty` is test-only (anchored in the module graph by `internal/e2e/pty_deps_test.go` and never reaching the production binary). A `windows/amd64` build was cross-compiled from macOS during this research in seconds. **One Linux runner can produce all six targets** — darwin arm64/x64, linux x64/arm64, windows x64/arm64. This property is not free and is not portable: it is what §1.4(a) shows a Rust rewrite would give up.
- Daintree's packaging already has every hook needed: `extraResources`, `afterPack.cjs` binary validation and foreign-arch pruning, `afterSign` notarization, hardened runtime with entitlements.
- **Ship stripped.** Measured: 33.3MB default, **23.9MB with `-ldflags="-s -w"`** — 5.8% of the 410MB installed app, one binary per installer. If the cockpit later moves behind a build tag, the whole TUI stack is a further ~2.13MB of symbols.

**Vendor as a git submodule pinned by SHA**, built by a Makefile target the Daintree build calls. Not a release-artifact download: the whole lesson of §2 is that the engine and the host contract must move atomically, and a submodule SHA _is_ that atomicity. A download-and-verify pipeline adds a release cycle between "change the protocol" and "test the protocol", which is exactly the gap that let v1 and v2 drift apart.

Resolution order at runtime, most specific first: `DAINTREE_ASSISTANT_BIN` (local dev, points at `make build` output) → bundled binary under `process.resourcesPath` → `PATH` lookup (so CLI developers can test their own build inside the app). The `PATH` fallback also covers the case where a user has a newer CLI than the app ships.

## 5. Phases

Each phase ends in something shippable or verifiable. Phases 0–2 land no UI at all and are the ones most likely to be skipped and most expensive to skip.

### Phase 0 — Unblock the foundations

No UI. Removes the things that would otherwise be discovered late and force rework.

- **Windows.** `internal/ipc/lock_other.go` is 12 lines returning `errFlockUnsupported`; every stateful mode takes the lease first, so nothing runs on Windows — and `.github/workflows/release.yml` accordingly ships only `darwin/{arm64,amd64}` and `linux/{amd64,arm64}`. Implement the lock with `golang.org/x/sys/windows` `LockFileEx` (`LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY`); the crash-handover property survives, since Windows releases file locks on handle close. Audit `internal/ipc/socket.go` alongside it — the control-socket path is a unix-socket layout built around a 104-byte `sun_path` constraint, and Windows needs AF_UNIX (Windows 10+) or a named pipe. **Cross-compiling is not Windows support**: the binary already builds there, and still cannot run a stateful mode. **If Daintree ships Windows and this is the monetization surface, that is a revenue hole independent of any UI work.**
- **Cross-platform release pipeline in the assistant repo.** Six targets from one runner, stripped and checksummed. Windows is currently absent from the matrix, not merely untested.
- **Vendor the submodule**; wire the build; add the three-step binary resolution and `DAINTREE_ASSISTANT_BIN`.
- **Delete `resolveHostEntry.ts`** and mark `AssistantHostProcess.ts` for replacement. Drop the `knip.config.ts` exclusion once they are gone.

### Phase 1 — Define protocol v3

Not "reconcile to v2". v2 is lossy by construction (§3) and nothing is bound to it — Daintree's v1 is dead code and the Go v2 has exactly one consumer, its own tests. Design the wire from the native product's requirements, once, and make it single-owner and testable from both sides.

- Write `shared/types/ipc/assistantHost.ts` as protocol **3**: stdio NDJSON, sequence numbers with replay-or-snapshot on reconnect, explicit backpressure in place of silent frame drops, authoritative final content on `turn:end`, and the event set from §3. Keep the audit vocabularies shared with `mcpServer.ts`. Regenerate the Zod validators.
- **One source of truth for the schema.** Generate or conformance-test both the Go and TypeScript types against a single definition. Two hand-maintained unions is how v1 and v2 drifted apart, and hand-maintaining a third would be repeating the mistake while writing a document about it.
- Replace `AssistantHostProcess.ts` with the utility-process host from §4: spawn, NDJSON frame, Zod-validate, forward over `MessageChannelMain`, supervise, tear down. Preserve the invariants already written down in `assistant-native-host.md` §Invariants — pinned delivery never broadcast (#7003), secrets via env never messages, one backend per project (#7522), audit-aligned vocabularies, synchronous bootstrap guard (#8833).
- **Golden transcripts as the anti-drift mechanism.** Generate NDJSON fixtures from the assistant's e2e suite; replay them against Daintree's reducer in vitest and against the Bubble Tea view in Go. One schema, two consumers, both pinned to the same recordings. This is what stops the two renderers drifting, and it is cheap only if built now.
- Ship `host --stdio` behind a setting with the PTY path as the default. Nothing renders natively yet — this proves the pipe.

### Phase 2 — Extend the protocol

Close §3's gaps in the engine, still with no native UI. Order: run/cohort events → cost/usage → block-addressed content → transcript rehydration → command catalog → attention → skill decisions → figures. Land the backend's native `display` mode in the same window, since it gates output quality and lives in a third repo.

Each addition is additive and version-gated; the Bubble Tea cockpit keeps working throughout and is the proving ground for every event before a React component depends on it.

### Phase 3 — The native panel, behind a flag

The renderer. Both paths alive; the setting chooses.

- Store and reducer over the event stream. Transcript, composer, tool-call timeline, streaming markdown with incremental parsing.
- **Approvals become Daintree's own `ConfirmDialog`**, honouring the destructive-action tiers in CLAUDE.md rather than a TUI approval sheet. This is the first thing that is unambiguously better than the terminal.
- **Run cards** — the payoff from Phase 2's first item. Live `AgentStateService` state, clickable worktree and terminal references, focus and kill in place.
- Retarget `McpActivityTracker` from MCP events onto the host stream; keep `FigureRail`.
- Theme system throughout: semantic tokens only, the shared motion tiers, the Doherty loading gate, notification routing at the least-restricted tier that conveys the signal.

Exit criterion is **not** parity with the cockpit. It is: everything the cockpit can do that a Daintree user needs, plus the things a terminal cannot do.

### Phase 4 — Native-only surfaces

The reason the transition is worth doing at all. Candidates, in rough value order: run cards joined with the worktree dashboard; inline diff and PR previews from `forge` reads; the attention inbox as a real Daintree inbox surface rather than a digest paragraph; drag-and-drop and paste of files, images and terminal selections into the composer; `@`-referencing worktrees, terminals, issues and PRs with completion; jump-to-source from any object the assistant names.

### Phase 5 — Monetization

Deliberately after the surface is good. The panel presents; **the backend enforces** — never gate in the client.

Today there is no sign-in at all: the backend holds its own upstream credential and funds every turn, and `auth.authenticate` returns an anonymous principal. `BACKEND.md` is explicit that this is _"a stage, not a destination"_, and it keeps three seams alive for exactly this step: the `DAINTREE_API_KEY` → `Authorization: Bearer` path where a caller-supplied bearer already wins over the backend's own credential; `App.Backend` as a `backend.Swappable` so re-authentication is a delegate swap rather than a re-wiring; and `POST /v1/daintree/auth/verify`, which already answers _"can this deployment actually fund a turn"_ with a `reason` of `ok` / `provider_rejected` / `credits_exhausted`.

Native work: account state and sign-in, a quota meter reading the wire cost block (respecting `complete: false` as a floor and absent-means-unknown), plan and model tiering, and the upgrade flow. Most of the backend work is in the third repo, and the CLI's job is mostly to stop being anonymous.

### Phase 6 — Retire the PTY embedding

Only once Phase 3's exit criterion holds and the flag has defaulted to native for a full release cycle.

Remove the help-launch branch in `terminal/lifecycle.ts`, the version gate, the missing-CLI state, the hibernation/resume asymmetry, and most of the 27KB of `DAINTREE_HOST.md` — that document is a contract maintained for a rendering path being abandoned. The Bubble Tea cockpit stays in the assistant repo as the headless/SSH renderer; it just stops being something Daintree embeds.

## 6. Risks

- **Three repos move in lockstep.** `daintree`, `assistant`, `assistant-backend`. The `display` mode change alone touches all three. Golden transcripts (Phase 1) and version gating on capability handshakes are the mitigations; the cross-repo doc rule in CLAUDE.md is the process one.
- **Phase 2 gets skipped under pressure.** Building the panel against today's events yields a prettier terminal and a second migration later. The protocol is the product; the React is comparatively easy.
- **Streaming markdown perf.** Re-parsing accumulated text per token is O(n²) and will visibly degrade a long transcript. Parse the delta; flush per frame.
- **Code signing a second binary.** The hooks exist, but the first notarized build carrying a Go binary is where hardened-runtime and entitlement problems surface. Do it in Phase 0, not the week of a release.
- **The Windows lease is not only a build fix.** The socket layer needs a portable path too, and the supervisor's whole ownership model rests on kernel-released locks.
- **Feature gravity in the cockpit.** As long as it is treated as co-equal, every engine feature pays a TUI tax. Demote it explicitly, in the repo's own docs, when Phase 3 lands.
