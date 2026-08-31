# Performance Harness

This directory measures what Daintree's performance currently **is**, on each operating system, so that improvements can be found and proven. It is not a gate.

## Measurement, not gating

**The perf suite never fails a run because a number is worse.** Not on a schedule, not anywhere. A run fails only when the measurement apparatus itself is broken:

| Condition                                  | Fails the run? |
| ------------------------------------------ | -------------- |
| A number is worse than its reference value | **No**         |
| A number is worse than yesterday           | **No**         |
| No reference value exists for a scenario   | **No**         |
| A scenario threw                           | Yes            |
| `assertMatrixCoverage` violated            | Yes            |
| An unknown flag, mode or scenario id       | Yes            |
| A metric emitted a non-finite value        | Yes            |
| Results could not be written               | Yes            |
| A configured metric stopped being emitted  | Loud warning   |

This is deliberate, and the reasoning is recorded so nobody re-arms the gate by accident. The gate that existed was providing nothing: it ran on a cron, blocked no pull request, and was red for fifteen consecutive days over ~2% overshoots without anyone noticing. A permanently red suite trains everyone to ignore it. A suite that is always green and always publishes numbers keeps the numbers legible.

**What this costs:** nothing catches a regression automatically. A regression is found when someone next runs a benchmark, or when a user reports it. That is an accepted trade.

**The consequence for anyone reading a run:** green means nothing threw. It is not evidence that the measurement still means anything. A metric that stopped being emitted is reported as a _measurement issue_ and still exits 0 — read that section of the report, not just the exit code.

## Reading a number

Two things decide whether a number can be compared with another number, and `lib/comparability.ts` is the authority on both.

- **Machine-independent** — `count`, `size`, and `ratio`. Compare these freely across machines and operating systems: "Windows 34, macOS 0" is a finding.
- **Machine-dependent** — `duration`, `memory`, `derived-ratio`, and `unknown`. Only meaningful against another run on the _same_ machine. Across two machines the difference is mostly the two machines.

`derived-ratio` is the class worth knowing about, because it is the one that looks portable and is not. A percentage is only machine-independent when both of its terms are: `spawnsPerWorktree` divides two tallies and travels, but `memoryGrowthPct`, `cpuPct` and event-loop utilization divide by the machine's own behaviour. Normalising a runtime number by another runtime number does not remove the machine from the figure, it changes the units it is wrong in. The report marks each number `≡` (compare freely) or `~` (compare only against itself) — two markers, not four, because the question the marker answers is binary.

Counts are also the class that catches the bug latency benchmarks are blind to: a recovery state machine that takes a wrong turn under a transient fault and never returns to the cheap path keeps every individual operation fast. Only a count over a fixed idle window sees it. PERF-105/106 exist for exactly that shape.

**Every count needs a paired correctness reading.** A dead watcher spawns nothing and scores perfectly — it is the best result the harness has ever recorded. So a scenario reporting a count-class metric declares `correctness: [...]` naming its miss counts, and the runner flags any scenario that does not. PERF-105's zero idle spawns is only meaningful beside `detectionMisses: 0`, which proves the edit was still detected.

**The question to ask of a new scenario is narrower than "could a no-op pass".** It is: _which operation inside the timed bracket has no term in the predicate?_ That one found three defects a stub experiment did not, because a stub experiment catches a subject that stopped working and this catches a subject that is still doing most of its work. PERF-302 paid for five colour operations and graded four, so stubbing the fifth was 23% faster at zero misses. PERF-305 timed an APCA floor and a 9×9 crossfade search while grading only endpoint contrast. PERF-340 scaled a registry to 126 providers to price the table build and graded six of them, so dropping 120 rows was 1.45× faster and invisible. Every one of those is a real optimisation the harness would have called free.

Two rules make the predicate worth having. Only the first can be checked mechanically:

- **It is emitted on every iteration, including healthy ones, and every sample is zero.** `MetricStat.count` tallies the iterations that emitted a metric, not the run count, so a predicate present in one iteration of fifteen still aggregates to `max: 0` — a clean pass from a scenario that mostly did not run. The runner compares `count` against `runs`, and reads `min` as well as `max`, because several predicates are signed subtractions where a negative means the subject produced more than it was asked to. **Enforced.**
- **It is an independent oracle.** The test to apply is whether a no-op implementation of the subject could satisfy it. A count of its own spawns cannot; a read-back of the state the subject was supposed to produce can. **Not enforced, and not enforceable** — nothing outside the scenario can tell a real oracle from a decorative one that returns 0 unconditionally. This is a review obligation when a predicate is written, and the reason each one names what it actually read.

Every scenario declares a predicate. The exemption list in `__tests__/scenarioMatrix.test.ts` is empty and stays enforced, so a new scenario must either declare `correctness` or be exempted deliberately. The fifteen that once sat on it reported only durations, a `checksum` or retained heap; a checksum nothing compares against an expected value is not an oracle, and the fixtures now report what each subject produced — panels restored, chunks consumed, FSM flips observed, boot marks emitted — for the predicates to read.

The spawn counter validates itself before a scenario trusts it: it confirms its `child_process` hook is still the wrapper it installed, and that starting a real child increments the counter through that hook — reporting `spawnObserverMisses` when either fails. Read that claim narrowly. It proves the funnel is intact, not that the count is complete: the probe cannot see what never reaches the funnel. The counter stays blind to starts made from C++ inside native addons (`@parcel/watcher`'s watchman, better-sqlite3, node-pty), to grandchildren (Windows `exec` → `cmd.exe` → PowerShell), and to `spawnSync`. A zero means "nothing started through Node in this process", never "nothing started". Closing that gap needs an OS-level observer, which this harness does not have.

## Type checking

`scripts/perf` is covered by `tsconfig.perf.json`, wired into `typecheck:projects`, so `npm run typecheck` checks the harness and everything it reaches in `src/` and `electron/`.

It needs its own project because the harness spans both halves of the app. It uses bundler resolution and the renderer path aliases (its relative imports are extensionless or carry `.ts`, which the NodeNext configs would reject), and it leaves `noUncheckedIndexedAccess` off to match `electron/` and `shared/`, which supply most of the transitive graph — turning it on fails ~250 product files their own configs pass.

This closed a real hole rather than a theoretical one. Before it existed, vitest transpiled without checking types, so a rename could silently break a fixture with every test still green: `scenarios/ipc.ts` called a function that had been renamed out from under it, and `lib/worktreeSidebarFixture.ts` called `svc.loadProject(requestId, repoPath)` against a 3-6 argument signature, so `projectId` arrived `undefined` and the fixture measured a load the product never performs. Neither was caught by CI.

## Entry point

Every benchmark runs through one dispatcher, `scripts/perf/index.ts`, exposed as the `perf` npm script. `npm run perf list` prints the full command table; each command spawns its benchmark in its own process, so behavior matches invoking the underlying script directly. Add a benchmark by adding one entry to the `REGISTRY` in `index.ts` — nothing else changes.

```bash
npm run perf list
```

## One scenario at a time

**`--scenario` is required and takes exactly one id. There is no whole-matrix run, and nothing schedules a run at all.** Both are deliberate.

The harness exists for targeted optimisation work, driven a benchmark at a time by `.agents/skills/optimize`. A sweep of 112 scenarios produces a wall of figures nobody reads, while taking the machine away from the one measurement somebody actually wanted — and since nothing gates on these numbers, a sweep has no audience. There is no perf workflow: `performance.yml` is gone, and no cron, no pull request and no branch push runs a benchmark.

Requiring the filter is also what makes results comparable. A scenario measured alone and the same scenario measured beside 111 others ran under different heap, JIT and thermal conditions; `perf compare` refuses a pair whose selections differ, so a matrix run's numbers could never be compared against a targeted one. With the filter mandatory, every result this harness produces is comparable with every other result for that scenario.

```bash
npm run perf smoke -- --scenario PERF-105
```

## Modes

Modes set sampling depth and which scenarios are eligible. Each still needs `--scenario`.

- `smoke`: fast sampling — the one to use while iterating
- `ci`: more iterations (the name is historical; nothing in CI runs it)
- `nightly`: heaviest sampling, plus the packaged-binary scenario
- `soak`: long-run stress focus

A scenario declares which modes it runs in, and an id outside the chosen mode is a usage error — `--mode smoke --scenario PERF-002` fails, because PERF-002 is `ci`/`nightly` only.

## Commands

Every one of these needs `--scenario` with a single id — a bare `npm run perf smoke` exits 1 and tells you so.

```bash
npm run perf smoke -- --scenario PERF-105
npm run perf ci -- --scenario PERF-105
npm run perf nightly -- --scenario PERF-105
npm run perf soak -- --scenario PERF-062
```

### Running one benchmark

The flags that make the local optimisation loop work:

```bash
npm run perf smoke -- --scenario PERF-105 --iterations 5 --label before --json .tmp/opt/before.json
```

| Flag | Effect |
| --- | --- |
| `--scenario <id>` | **Required, exactly one.** Unknown id → error listing the available ones |
| `--iterations <n>` | Overrides the per-tier default for every scenario in the run |
| `--warmups <n>` | Overrides each scenario's own warmup count |
| `--label <name>` | Stamped into the summary — `before`, `after`, `pin-backend` |
| `--json <path>` | Writes the summary somewhere you chose, for `perf compare` |
| `--machine <label>` | Overrides the machine identity (or set `PERF_MACHINE_LABEL`) |
| `--update-baseline` | Merges this scenario's reference into the mode's baseline, re-dating only it |

Argument parsing is strict: an unknown flag, a missing value or a stray positional is an error rather than being ignored. The previous parser silently dropped what it did not recognise, so a typo'd `--secnario` ran the whole matrix and looked like it had worked. Every run ends by printing the exact invocation to reproduce it.

### Comparing two runs

```bash
npm run perf compare .tmp/opt/before.json .tmp/opt/after.json
```

Diffs every scenario and metric into a delta table, leading with the median — at these iteration counts a p95 is effectively one of the two largest samples, not a stable tail estimate.

It **refuses** machine-dependent rows when the two runs are not comparable, and prints `REFUSED` in each affected cell:

- different machine, platform or architecture
- different `--warmups` or `--iterations` (a `--warmups 0` run still carries cold-start cost a warmed run has already paid, and both sides can report the same iteration count, so nothing else would reveal it)
- a summary written before the protocol block existed

Counts still compare through a refusal — that cross-machine comparison is the point. Note the command exits 0 even when it refuses: read the output, not the exit code.

### Results history

Every run that does not override sampling writes `scripts/perf/history/<mode>.<machineLabel>.json` — a small **tracked** file, so `git log -p scripts/perf/history/` answers "when did this get slower" months later. It records p50, p95 and each metric's max, sum and own sample count, and **merges**: a run touches only its own scenario's entry and leaves every other one alone.

A run with `--iterations` or `--warmups` is excluded, because a spot check at three iterations is not comparable with the eight the mode normally takes. The scenario filter is no longer part of that test — every run is filtered now.

## Outputs

Artifacts are written to `.tmp/perf-results/`:

- `*.raw.jsonl` - per-iteration raw samples
- `*.summary.json` - aggregate stats + budget results
- `*.report.md` - human-readable report
- `latest-<mode>.summary.json` / `latest-<mode>.report.md`

The cold recipe fanout benchmark writes its versioned, atomically updated result to `.tmp/perf-results/recipe-fanout.json` by default.

## Control-surface scenarios (PERF-200..205, 220..225, 240..246)

Three families cover the parts of the app every other family runs _through_: the dispatch layer behind menus, keystrokes and MCP tool calls; the plugin system; and the panels that were not already measured. Each drives real product code in a plain Node process, so read the scope limits — none of these has a renderer, and the fixture headers say precisely what that costs.

- **Action dispatch and the MCP tool surface (PERF-200..205)** — the real `ActionService` with all 495 shipped action definitions. PERF-200 times catalog construction and registration; PERF-201 walks the `dispatch()` gate chain through every outcome an MCP call or a keystroke can produce (NOT_FOUND, VALIDATION_ERROR against real zod schemas, DISABLED, CONFIRMATION_REQUIRED, and a success), which costs ~3.4µs; PERF-202 measures the palette's per-context re-projection over the whole catalog; PERF-204 resolves keystrokes against the real 135-binding table including chords. **PERF-203 is the one to watch**: it prices the zod→JSON-Schema compile on first MCP connection and reports the `tools/list` payload per tier — **229 KB at the system tier, 104 KB at workbench, 51 KB external**. Those are deterministic byte counts, so they travel across machines, and they are a public contract with every external agent that connects. No real action's `run()` is entered — the gate chain is the subject, and the bodies need a renderer.
- **The plugin system (PERF-220..225)** — the real `plugin-dev-worker` forked into its own process, and the whole of `PluginService`: scan, the real zod manifest schema, contribution registration, `createHost`, activation. PERF-221 walks 29 manifests and reads the contribution counts back out of the product's own registries rather than out of the scan's self-report, so a loader that registers nothing scores 164 misses. PERF-222 grades 364 capability decisions in **both** directions — allow-everything trips a fail-open counter, deny-everything trips fail-closed — across the static capability check, path containment, and the real JIT consent ladder including a persisted grant. PERF-225 is shaped by the shipped cold-start bug: forge descriptors register eagerly from the manifest while impls bind only in `activate()`, so it asserts zero impls bound before and one after. The product supervisor (`PluginDevWorkerHost`) is deliberately out of the loop; PERF-224 answers how fast a killed worker comes back and whether it serves, not whether Daintree would have restarted it.
- **Panel surfaces (PERF-240..246)** — the file browser, the Review Hub and the file viewer, none of which had coverage. PERF-240/241 build the real tree and scale it, checking the produced row set by symmetric difference against what the fixture actually wrote, so a filter that silently over-hides is caught rather than rewarded. PERF-242 is the one aimed at the known staleness bug: it prices a refresh sweep after a visible write, an ignored-only write and an in-place edit, and requires the new file present and the junk file both absent from rows and counted as hidden. It can prove the sweep accounts for an ignored-only write; it **cannot** prove the sweep was triggered, because that lives in a React hook over a git-derived signal. PERF-244/245 measure Review Hub open across 48 and 423 changed files, where the churn cache is worth ~4,500× warm over cold. PERF-246 reports viewer parse cost, explicitly not first paint.

## Recovery and session scenarios (PERF-260..264, 280..285)

The last two families cover what the rest of the harness explicitly left out. PERF-046 and PERF-224 both measure how fast a killed host comes back and say plainly that the supervisor is not in the loop; PERF-203 measures the MCP tool-surface projection and says plainly that no server is. These close both halves.

- **Supervision and recovery (PERF-260..264)** — the real `WorkspaceHostProcess`, `PtyHostLifecycle`, `PtyClient`, `PluginDevWorkerHost` and `MainProcessWatchdogClient`, driven through their public entry points. The trap this family is built against: **a supervisor that gives up immediately is the fastest supervisor there is**, so `firstCrashMisses` is a policy floor asserted by the probe rather than read from the code — one crash after a healthy start must be survived — and "survived" means the fresh child answered a nonce round trip, not that a `ready` message arrived. PERF-261 deep-compares each of six replayed items against what main cached before the crash, because a host that comes back holding none of its state still serves. PERF-262 grades crash classification against a 12-case spec table in which five cases have a deferred `child-process-gone` reason that disagrees with the exit code, so an exit-code-only classifier — which answers _faster_ — scores misses; one case puts a sibling shard's reason on the bus, which is how a supervisor ends up rewriting one host's verdict with another host's facts. PERF-263 grades the watchdog in both directions on a single run: never firing fails `undetectedFreezeMisses`, firing eagerly fails `spuriousKillMisses` across healthy beats, a suspend, a wake burst and post-kill disarmed ticks. **Backoff is recorded as a schedule, not a latency** — sleeping through a crash ladder measures Node's timer accuracy, so the jitter bounds are recovered by pinning `Math.random` to each end of the range and reading what the product actually scheduled.
- **MCP session and transport (PERF-280..285)** — the real `createSessionServer`, the real SDK on both ends including the client's AJV validation of `structuredContent`, the real `SessionStore`, `GrantCache`, ownership ledger and `AbusePolicy`. **PERF-281 settles what PERF-203's projection number was worth**: on the transport the system tier is 229,321 B against the projection's 229,287 — the entire difference is the 34-byte JSON-RPC result envelope, so the projection figure was the payload almost exactly. Session-ready cost is 231,087 B once the 1,766-byte handshake is counted. PERF-283 grades 109 authorization decisions in both directions across the tier floor, the ownership ledger, the help-session gate, the bound-confirm ceiling and a real `AbusePolicy` driven to a trip, because **a server that authorizes everything is fast and catastrophic**. PERF-285 runs twelve concurrent sessions and treats an external session seeing a workbench tool as a leak.

Both families run in plain Node with Electron stubbed, so neither prices the OS fork, `MessagePortMain`, the real `child-process-gone` vocabulary, or HTTP framing. The fixture headers state the limits in full; the durations are supervisor and handler work, and the counts and byte totals are the readings that travel.

## Theme, notification and registry scenarios (PERF-300..305, 320..325, 340..343, 350..353)

The last three families close the coverage audit. Each is graded against an oracle derived from something the subject does not contain, because the cheap wrong answers here are all fast: a resolver that returns its input, a validator that approves everything, a contrast function returning a constant, a router that notifies nothing, and a router that notifies about everything.

- **Themes (PERF-300..305)** — the real `shared/theme` entry points over all 15 shipped palettes. **The oracles do their own colour maths**, anchored on values that appear nowhere in the subject: WCAG's exact 21:1 for white-on-black, APCA-W3's published 106.04 / −107.88 pair, and the identity that a neutral grey's OKLab L is the cube root of its linearised channel. PERF-300 resolves palette → 155 tokens → 3,111 CSS variables; PERF-301 runs the audit `ThemeBrowser` recomputes on every accent change, with a planted theme whose text sits ~1.01:1 from its own surfaces so the failing direction is exercised on the same pass; PERF-303 grades the import boundary in both directions across 15 valid and 7 deliberately invalid files. **PERF-305 is the one to watch**: `resolveBrandMarkInk` across 18 brand colours × 15 themes × 6 surfaces is 1,620 resolutions at ~72 ms, the heaviest real APCA/OKLCH consumer, and it runs per mark on every theme change.
- **Notifications (PERF-320..325)** — the real `AgentNotificationService` → `NotificationService` path, graded from a table that declares, per transition, both what must fire and what must be suppressed. Every gate in PERF-322's 24-row battery appears twice, once suppressing and once in the configuration where the same signal must get through, so suppress-everything and fail-open are both caught. PERF-323 collapses 91 events into 5 notifications and reads the dedup evidence out of the grouped copy itself ("24 agents waiting for approval"). **PERF-321 found something worth acting on**: per-decision routing cost goes from 12.6 µs at 8 panels to 79 µs at 96 — a ~6× overhead ratio, superlinear in fleet size. Timers run on a virtual clock, so every duration is decision cost with the waiting removed; nothing here measures how long a user waits, and **no OS notification is ever sent**.
- **Forge and the agent roster (PERF-340..343, 350..353)** — the real provider registry, resolver, RPC server and both relays, plus the 18-agent roster. PERF-341's routing table requires 7 of 20 rows to resolve to **nothing**, so a resolver returning the first provider for everything scores 60. PERF-342 grades singleflight with a **signed** counter, so under-coalescing and over-coalescing are distinguishable. PERF-350 grades the roster merge against the filesystem — `shared/config/agents/*.ts` — which a registry cannot satisfy from its own tables. Two findings fell out: `compilePatterns` is not memoized, so 24 panes on one agent recompile the same 26 regexes 24 times (`repeatCompiledPatternCount 624`), and binding a forge impl fires a registry-changed fan-out that re-serializes and re-pushes the entire hostname table even though binding an impl cannot change it.

## Main-process IPC envelope (PERF-360..364)

The wrapper every `ipcMain.invoke` in the app crosses, and the last uncovered hot path. `enforceIpcSenderValidation()` monkeypatches `ipcMain.handle` before any handler registers, so all ~600 invoke channels pay the same tax: a sender-frame trust check, an argument-count cap, and a full `JSON.stringify(args, sizeGuardReplacer)` whose only product is a byte count. Roughly sixty channels add a zod `safeParse` on top. PERF-042..046 measure the utility-host **fork** boundary and say so; this layer sits upstream of every one of those numbers and had no coverage at all.

The real `electron/setup/security.ts` and `electron/ipc/utils.ts` are loaded unmodified in a plain Node process behind an in-memory `ipcMain`, with only `electron` and `TelemetryService` stubbed. One measured channel is the shipped `terminal:spawn`, so the category lookup and its real 256 KiB budget are production's own rather than numbers the fixture chose. **These are wrapper durations, not IPC latency** — Electron's structured clone happens before the wrapper is entered and is outside every reading. `lib/ipcEnvelopeFixture.ts` states the rest of the limits.

Every scenario declares the same five core predicates — one accumulator per operation the wrapper performs on every invoke (the monkeypatch, the frame check, the arg cap, the byte measurement, the handler round trip), because a single aggregate cannot see one of them deleted. Each is graded in **both** directions, so a wrapper stubbed to return immediately scores on the rejecting terms and one stubbed to throw scores on the accepting terms. The byte term is pinned to the byte: a payload of exactly the real budget must be accepted, one byte more must be rejected, and the count the wrapper reports must equal the fixture's own `Buffer.byteLength(JSON.stringify(args))`.

- **PERF-360 (size) / PERF-361 (shape)** — the sweep is 1.4 µs at 128 B and ~380 µs at 512 KiB, so the envelope is free on small payloads and is the dominant cost on large ones. PERF-361 answers the question the comment at `security.ts:115-125` raises, holding bytes constant at 64 KiB: **a 2,000-level plain-object chain costs ~13.6× a flat payload of identical size** (650 µs against 48 µs), and 1,500 shallow keys cost ~3×. The old `containsBinary` pre-walk bailed past depth 32 and skipped the byte gate entirely; folding detection into `sizeGuardReplacer` means deep objects are now measured, and this is what that costs.
- **PERF-362 (validated vs unvalidated)** — the same 2 KiB payload with and without a 12-field zod schema: `safeParse` adds ~1.5-2× on top of the envelope. Graded in both directions on one pass, plus an unvalidated control that must **accept** the same planted-invalid payload, so the delta is provably the schema and not the wrapper.
- **PERF-363 (success vs error)** — a success envelope is ~1.8 µs; **a packaged error envelope is ~20× that** (`serializeError` over the stack, context and cause, then `sanitizeErrorForRenderer` over the message and userMessage, then the field strip). The sanitizer is graded two ways on the same run: the packaged message must not carry the planted path or github token and must carry `<path>` / `[REDACTED]` instead, while the development message **must** still carry both — so a sanitizer wired onto every build and a sanitizer that does nothing are separately caught.
- **PERF-364 (fail-open bail)** — the documented skip path, priced across eight deliberately over-budget classes on `terminal:spawn`. Acceptance is the proof the gate was skipped. **Six of the eight reach the handler unmeasured**: a `Uint8Array`, a `Map`, a `Set`, a cycle and a deep chain, against a plain payload and a BigInt-bearing one which are measured and rejected. Two numbers to read. A buffer on the **last** key costs ~46-62× one on the first (142 µs against 2.1 µs) — the single-traversal design still pays a full traversal when the buffer is at the end. And a 60,000-level chain costs **~5.8 ms per invoke** to fail, then passes 360 KB through a 256 KiB budget unmeasured: a replacer — any replacer — moves `JSON.stringify` off V8's iterative serializer onto the recursive one, so the recursion ceiling that `security.ts` fails open at is a few thousand levels rather than the hundreds of thousands a bare `JSON.stringify` handles.

## Main-process log emit (PERF-380..384)

The path `electron/utils/logger.ts` names in its own comment as the dominant main-thread stall before #10769, and which had no coverage. Every line crosses `redactSensitiveData` (key gate, depth clamp, array cap) → `clampLogString` → `scrubSecrets` → `safe-stable-stringify` at indent 2 → a second `scrubSecrets` over the whole serialized context → the batched append, and a busy multi-agent session issues hundreds of them a second. The real module graph loads in a plain Node process with **nothing stubbed** — no part of it imports `electron` — writing into a temp directory this fixture owns and removes. Two limits to carry into every reading, both stated in full in `lib/loggingFixture.ts`: **the renderer broadcast is not in the frame** (no transport is registered, so `sendLogToRenderer` returns immediately, exactly as in a utility process or pre-window main), and **the console transport is a counting sink**, so its `util.format` and stream write are outside the numbers while its argument construction is inside.

Every scenario declares the same nine core predicates — one accumulator per operation the path performs on every line (the level gate, the key gate, the string clamp, the `LogBuffer` ring, the serializer, secret survival, marker survival, the entry tally, the console mirror). The pair that matters is two-sided by construction: **zero planted secrets may survive to disk, AND every planted non-secret marker must**. A scrubber stubbed to redact everything clears the first alone (`markerSurvivalMisses` 1,628); one stubbed to redact nothing clears the second alone (`secretSurvivalMisses` 1,909). Every planted secret is **synthetic** — a shipped sigil followed by a run of the literal `PERFFAKE0` — and the unit test asserts each one is still matched by a distinct shipped pattern, because a plant that stopped matching would make the survival predicate read zero forever.

- **PERF-380 (line length)** — a secret-free sweep: 2.9 µs per 64 B entry, 6.2 µs at 512 B, 32.6 µs at 4 KiB and **244 µs at 32 KiB**, an 84× spread, so the cost is essentially linear in line length and a stack trace or command tail in a log line is not free. `flushMs` reports the deferred write separately: the batched `appendFile` adds ~0.17× the emit cost, which is the part #10769 moved off the synchronous path rather than removed.
- **PERF-381 (context shape)** — 13 µs for 12 flat keys, **98 µs for 200** (7.5×), and 4.8 µs for a 6-level chain: the depth clamp makes a deep context the _cheapest_ shape because the walk refuses it at level five, while width is paid in full. `prettyToCompactByteRatio` is 1.18 — the serializer runs at indent 2, so every context field costs ~18% more bytes on disk than the same object compact. The two clamps are graded in both directions from the file: the depth marker and the array-cap marker must each appear exactly once per entry of their own shape and not at all for the other two.
- **PERF-382 (secret density) is the one to read.** Four arms at byte-identical 1 KiB lines: a line with no sigil (the pre-scan probe **miss**) is 9.6 µs; a line carrying probe sigils that complete no pattern is **15.9 µs, 1.66×**, for zero redactions. That gap is the ~60 replace passes, and it is paid by any log line that happens to contain `sk-`, `ghp_`, `AIza` or `Bearer ` — a `git remote -v`, an npm error, a stack frame under a `sk-`-prefixed directory. Eight real secrets cost **less** than the probe hit (1.46×), because each replacement shortens the string for every later pass. Graded with a **signed** redaction count, so under-redaction and over-redaction are distinguishable.
- **PERF-383 (rotation)** — each round seeds a real 5 MB `daintree.log` and a real four-deep ladder in a fresh temp directory, then emits one line on the synchronous ERROR path so the rotation lands inside the bracket: **417 µs against 33 µs**, ~12.7×. Graded structurally against the ladder the product documents — `.1` must be exactly the 5 MB file that was there, each seeded marker must have moved down exactly one slot, the oldest must be **gone**, and `daintree.log.5` must never exist — so a logger that never rotates and one that rotates the ladder away both score.
- **PERF-384 (batched vs synchronous)** — a batched INFO entry is 5.9 µs; the same line on the ERROR path is **28.5 µs (4.9×)** because it takes an `appendFileSync` of its own, and carrying a real `Error` adds another 1.5× for `getErrorDetails` plus the `serializeErrorForLog` flattening. Durability is graded in both directions on one pass: an INFO entry must **not** be on disk before a flush, an ERROR entry must be there without one, and the buffered INFO entry must have been drained ahead of it.

`lib/loggingFixture.ts` ships an opt-in stub seam (`DAINTREE_PERF_LOGGER_STUB`) that replaces one real dependency at the loader boundary — `scrub-nothing`, `scrub-everything`, `suppress-writes`, `flatten-nothing`, `buffer-nothing`, `stringify-empty`, `no-rename`, and `gate-off` for the level gate, which has no module boundary. It exists so each predicate can be watched failing rather than assumed to work: under `gate-off` PERF-380 finishes in **0.16 ms instead of 44 ms** — the best result the harness has ever recorded — and eight of the nine core terms fire.

## pty-host flow control (PERF-063, 370..373)

The hottest path in the app, and the one that decides who gets paused under a flood. Every chunk of PTY output crosses `PortBatcher` → `PortQueueManager` → `PtyPauseCoordinator` on its way to a renderer, once per window, and `ResourceGovernor` sweeps the whole fleet above it every two seconds. The real modules load unmodified in a plain Node process — they take `Deps` interfaces and reach no Electron API, so nothing is stubbed at all; `lib/ptyFlowControlFixture.ts` states the limits. The headline one: **these are decision durations, not delivery latency.** There is no MessagePort and no node-pty, so the transfer a real flush ends in and the read suspension a real pause performs are outside every number, and the governor's `FORCE_RESUME_MS` / `REENGAGE_COOLDOWN_MS` wall-clock gates are never tripped by back-to-back ticks.

The trap this family is built against is that **a flow controller that pauses nothing is the fastest one there is** — and so is one that pauses everything, which is also the one that makes the app feel dead under load. So no scenario here reports a pause tally: every decision is graded as a SET, by symmetric difference against a victim set the fixture computes from its own byte ledger and the shipped 3 MiB / 67% / 16 MiB constants, with the two directions named separately. Alongside it sit one accumulator per operation on the path — bytes delivered downstream against bytes written in, the manager's depth against the ledger, the token really held, the raw PTY handle really suspended, and the renderer really told — because a pause that is booked but never reaches the handle keeps every other term clean.

- **PERF-370 (per-terminal watermark)** — per-chunk decision cost across 4, 12, 24 and 48 terminals with one flooder over its own 67% watermark, one focused quiet terminal, and background agents under every gate: **~0.28 µs per chunk at 4 terminals and ~0.40 µs at 48**. Deleting the flush is 2.3× faster and scores `deliveryMisses`; pausing nothing and pausing everything both score `victimSetMisses`.
- **PERF-371 (window aggregate and the focus exemption)** — 18 MiB across 12 terminals against the 16 MiB window watermark, in three arms on one pass: the port path with a focused pane (11 victims, focused exempt), the same flood with nothing focused (12 victims — the control that makes the exemption attributable to the focus), and the IPC fallback with the same focus. **The third arm records a real asymmetry: `IpcQueueDeps` has no focused-terminal member at all**, so on the fallback path the pane the user is watching is paused with everything else.
- **PERF-372 (drain and the resume sweep)** — the ack that takes the aggregate below its 8 MiB low watermark is timed on its own, because that ack and no other pays for `sweepAggregateResume`'s fan-out. It costs **~15 µs at 12 terminals and ~38 µs at 48, against ~0.06 µs for an ordinary ack** — roughly 600×, and superlinear in fleet size. Every resume is stamped with the fixture's own depth at the instant it fired, so a manager that released the fleet on the first ack drains faster and scores `prematureResumeMisses`.
- **PERF-373 (governor sweep and triage)** — one sweep over 48 loaded terminals costs **~40 µs** with all five gated gauges on (`DAINTREE_TERMINAL_METRICS` is forced on, so that is an upper bound). The whole schedule is predicted by arithmetic before the ladder runs: the EMA the governor must reach on every tick, the tick its smoothed signal first clears the 85% limit (17 of 23, where the raw reading crossed on tick 5), the one-shot trim that must precede the pause by exactly one tick, and the release tick. A governor stubbed to pause on tick one is 26× faster and scores; one stubbed to do nothing is 237× faster and scores on every term.
- **PERF-063 (flush allocation)** — repointed. It used to flood a local imitation of the allocate-and-copy that `PortBatcher`'s fast path retired, which measured a cost the product had deliberately stopped paying. It now drives the real batcher in both shapes production produces: `pty-host.ts` sets `owned = targets.length === 1`, so a one-window app takes the zero-copy path on every single-chunk flush and a **second window costs 2.4× the minor GCs over the same 400 MiB**. Graded on the merge branch in both directions, which is also the PR #4639 invariant — a batcher that hands a shared chunk on for transfer is 22% faster and would detach a node-pty slab under its sibling window.

## CopyTree context generation (PERF-390..392)

The multi-second wait behind the Copy Context menu action and the `copyTree.generate` MCP tool — ~31 MB of bundle on this repository, a 256 MB ceiling, and five calls per ten seconds available to any external agent. It had no coverage at all. Unlike the other main-process families here nothing needs stubbing: `copytree` is an ordinary npm dependency, the offload is `worker_threads`, and there is no `electron` import anywhere on the path. `lib/copyTreeFixture.ts` states the limits; the two to carry are that the worker is loaded from TypeScript source through `tsx` rather than the compiled `dist-electron` bundle, so its cold figure is an upper bound, and that the workspace-host fork and its structured clones (PERF-042..046) are not in the frame.

The expensive middle is graded from the **artifact**, not the result object. Every planted source file carries a distinct sentinel token, and the bundle on disk must contain every one of them: a generator that walks the tree, counts correctly and emits empty `<ct:file>` elements scores the full planted count on `sentinelContentMisses` while every other term stays zero. That case was run — stubbing `CopyTreeService` to produce a right-count, right-byte-count, no-bodies bundle scores 3,220 on the sentinel term and 0 on all five others, which is precisely the "still doing most of its work" defect the count-only version of this predicate would have called free.

- **PERF-390 (scale sweep)** — 120 / 700 / 2200 files streamed to a file, plus a `scopePaths`-narrowed run over 8 of the large tree's directories. Roughly linear at **~90 ms per 1,000 files** (13.8 ms / 65 ms / 198 ms), and the scoped 200-file run costs 22 ms against the whole tree's 198 ms.
- **PERF-391 (worker A/B)** — the same 700-file generation three ways on one pass, using the shipped `DAINTREE_DISABLE_COPYTREE_WORKER=1` kill switch for the in-thread arm. In-thread is ~72 ms, a **cold worker is ~188 ms** and the same worker warm is ~74 ms, so the offload costs roughly **113 ms on the first request and saves nothing on wall clock afterwards** — what it buys is the workspace-host event loop, which this process cannot show. Routing is graded in both directions from a creation counter incremented at the factory call site, so a client that ignored the kill switch and one that never reached its worker are separately caught: stubbing the client to run everything in-thread produces perfect bundles, runs faster, and scores 4 on `workerRoutingMisses`.
- **PERF-392 (streaming vs in-memory)** — the finding to read. #11528 moved `generate` off `copy()` (whole document as one string) onto `copyStream()` → `pipeline()` → `.part` → `rename()` to keep a multi-MB bundle out of memory, and at 2,200 files that costs **2.03× the wall clock** (198 ms against 97 ms) at ~9 MB/s. The real `reserveContextFilePath` (including its `pruneContextDir` sweep) is 0.2 ms, `readContentPreview` 0.13 ms and `fitContentToResultBudget` 0.04 ms, so the MCP-facing read-back is free beside the generation itself.

## CLI availability probe storm (PERF-393/394)

`useAgentSetupPoll` calls `cliAvailabilityClient.refresh()` on a **3-second interval** for as long as the agent setup wizard is open, and `refresh()` is the cache-**bypassing** entry point: it awaits a PATH refresh, bumps `checkId`, drops any in-flight check and re-probes all 18 agents from scratch. The numbers say what that costs, and they are counts, so they travel. **A first-run miss on POSIX costs two subprocess starts, not one** — `which -a <cmd>` exiting non-zero cannot be told apart from a `which` that rejects `-a`, so the service runs the probe again — which makes the all-miss case **37 starts per refresh, or ~740 per minute while a brand-new user watches the wizard**. The spread across hit ratio is the rest of the story: 37 (0% hit) → 29 (~50%) → 19 (100%) → **2 with `DAINTREE_CLI_PATH_PREPEND` set**, because a prepended-path hit is an `access()` that returns before any subprocess.

Everything is hermetic by construction, and `lib/cliAvailabilityFixture.ts` says how. `electron/setup/environment.ts` is stubbed at the module boundary — the real `refreshPath()` spawns the user's login shell and **replaces `process.env.PATH` with what it exports**, which would put the developer's own installed agent CLIs into the found set — and `HOME` is repointed at an empty temp directory so `probeNativePaths`, the synthesised PyPI paths and `checkAuth` cannot reach real credentials. The consequence is stated rather than hidden: that login-shell probe is **counted but not timed**, and `pathRefreshCalls` records the product's real behaviour of running it **twice on the first refresh** (once in `refresh()`, once inside `checkAvailability()` while `availability` is still null) and once on every one after. Both scenarios are `diagnostic` on win32: two agents declare `supportsWsl` and their miss path reaches the user's real WSL installation, so on Windows those two are planted in every arm.

The predicate is two-sided and every term was driven non-zero by a module-boundary stub. `foundSetMisses` is a symmetric difference, so "everything missing" and "everything ready" both score (76 and 32 on PERF-394); `absentAgentMisses` covers the all-miss arm where a no-op's empty found set trivially matches; `stateCoverageMisses` catches a fan-out that lost map entries (90); and `spawnCountMisses` is **signed** against arithmetic the fixture does over its own planting decisions — hits × 1 + misses × 2 + one `npm config get prefix` — so a probe ladder that stopped running scores +125 while one that over-probes goes negative. `pathHermeticityMisses` is the apparatus check that keeps the rest honest: it fails if PATH is no longer the arm's own, or if any system directory on it holds a real agent CLI.

- **PERF-393 (first-run storm)** — three back-to-back refreshes, one wizard poll window with the waiting removed: 111 starts, 37 per refresh, ~13 ms each.
- **PERF-394 (cost by hit ratio)** — the four arms above plus a plain `checkAvailability()`, which re-probes identically (19 starts) and differs only in skipping the PATH refresh. The 100% arm plants a second install of one agent in a second PATH directory, so the real `which -a` duplicate detection, `dedupePathsByDirectory` and the `notifyDuplicateInstalls` milestone write are on the measured path and carry their own two-directional predicate.

## Subsystem scenarios (PERF-043..046, 053..058, 074..077, 092..094)

Four families drive the real production subsystem in a real process rather than a stand-in. Each one grew out of replacing a simulation that had drifted from what the code does, so the scope limits below are the point, not boilerplate — several of these measure a floor with a named piece of production deliberately out of frame.

- **Cross-process IPC hosts (PERF-043/044/045/046)** — the actual `workspace-host` and `pty-host` forked into their own processes with `serialization: "advanced"`, so structured-clone cost is real. The host code is real; the transport is Node's `child_process` channel, **not** Electron's — so Electron's pipe, the main-process lifecycle, the renderer MessagePort, crash backoff and state replay are all outside the frame. `lib/ipcFixture.ts` states the limits. PERF-043 times boot-to-ready, proves the host serves a health check, and confirms it exits on a clean dispose. PERF-044 runs 100 correlated round trips and reports messages and serialized bytes each way, with a 64-character nonce per request that must come back intact. PERF-045 streams 2000 indexed lines from one real PTY and prices the parent-IPC **fallback** channel — production's visual path is the renderer MessagePort, which a forked child's channel cannot carry, so this is a volume figure, not the paint path. PERF-046 SIGKILLs the workspace host three times and measures respawn-to-ready; `WorkspaceHostProcess` (crash classification, restart backoff, state replay) is not in the loop, so it answers how fast a killed host comes back, not whether Daintree would have restarted it.
- **Persistence engines (PERF-053..058)** — better-sqlite3 and electron-store at engine level, against a migrated and populated database opened with production's pragmas. PERF-053 contrasts 200 autocommit upserts with the same 200 in one transaction; PERF-054 asserts the query plans so an index that stops being used shows up as a plan change and not just a slower number; PERF-055 adds a concurrent reader, a bounded write-lock contention probe and a TRUNCATE checkpoint; PERF-056 walks the real drizzle migration chain over 4,000 seeded rows so the O(rows) table rewrites are priced. On the JSON side, PERF-057 writes a 400-panel `appState` snapshot and then twelve ordinary settings writes against the now-large file — the whole-file rewrite amplification is the number to read, and it is large. PERF-058 pairs `initializeStore()` through the real corrupt-config preflight with 200 uncached `conf` reads against 200 through the product's cached store proxy.
- **Project view lifecycle (PERF-074/075/076/077)** — a real `ProjectViewManager`, switch controller, eviction controller, lifecycle controller and paint gate, imported unmodified and driven through their public entry points. **Chromium is not real and cannot be** in a plain Node process: `WebContentsView`, `BrowserWindow` and the `electron` module are inert stand-ins, so there is no renderer, no navigation, no paint, no GPU and no RSS. Every headline here is a count or a structural cardinality, and the wall-clock the runner records is harness time, not switch latency — read the counts. The stand-in also decides that every load succeeds, so renderer-side failure modes are not exercised. `lib/projectViewFixture.ts` states the full limits. PERF-074 rotates inside the cache limit and counts warm reactivations against cold starts, checking the wake signal each warm switch must emit. PERF-075 forces an eviction on every switch and validates LRU order and teardown against the manager's own state. PERF-076 drives the graduated pressure ladder and the forced tier-2 reclaim with one view holding an active agent and one a live assistant backend, checking the per-pass budget, the soft agent tier's ordering and the hard assistant floor. PERF-077 queues A-B-C-A-D onto the switch chain in a single tick without draining between them, then reads the settled active view, resident set and window child stack — the manager queues switches and never supersedes one, so this is where that shows.
- **Idle subsystems (PERF-092/093/094)** — the idle-tax counterpart to PERF-105/106, on the process-tree poller instead of the git watcher. The services are real but the process is not the app: CPU here is in-process only, so this is the idle cost of the subsystems, not the idle cost of a packaged Daintree with a renderer and a GPU process attached. PERF-092 idles a real `ProcessTreeCache` with a real subscriber at the pty-host's own 1500ms cadence for 15s, reporting subprocess starts, refresh callbacks, in-process CPU per idle second and event-loop utilization, paired with the discovery latency of a child spawned after the window closes. PERF-093 is the #12042 shape generalised: a PATH shim breaks the `ps`/`powershell` probe for 8s and then heals, and the run reports the cost of idling while broken, the recovery latency, and whether the poller returned to the cheap path over an identical window afterwards. PERF-094 stacks twenty watcher-less `WorktreeMonitor`s — the poll-fallback population beyond the background watcher budget — at the performance profile's 5000ms cadence alongside the process tree, paired with per-monitor poll-tick liveness, a staged file change that must still be detected, and a child that must still be discovered.

## Everyday-interaction scenarios (PERF-190..196)

Three families in the in-process matrix measure interactions a user hits many times a day, driving real production code rather than a simulation. Read each scenario's scope limits below before trusting a delta — PERF-196 in particular measures a parser floor, not wall-clock restore.

- **File picker (PERF-190/191/192)** — the `@`-mention completion and file palette, driven through the real `FileSearchService` against synthetic git repos (~3,200 and ~12,000 files). PERF-192 is the one to watch: it drops the cached path list and times `git ls-files` plus the directory-set build — the wait between pressing `@` and the picker showing anything. That list is rebuilt whenever its 10s TTL lapses and dropped outright when a worktree is created or deleted, so a session pays this repeatedly. Because `FileSearchService` silently falls back to a filesystem walk when git fails, PERF-192 asserts a git subprocess spawned and that the results contain a file only `git ls-files` can return. PERF-190/191 measure the warm per-keystroke re-scan.
- **Terminal search (PERF-193/194)** — find-in-scrollback via the real `@xterm/addon-search` and the app's own `buildSearchOptions`. The search bar debounces at 150ms, so the gated number is a single post-debounce search over a full scrollback, not a per-keystroke cost. The addon memoizes its buffer-to-string translation for 15s and drops it on any line feed, so a terminal still streaming output re-translates on every search where a quiet one does not — worth ~1.3x across the mixed-term sweep, reported per run as `coldToWarmRatio`. PERF-193 gates that cold path, because it is what a live agent terminal actually pays, and reports the warm one alongside. Sizes come from `shared/config/scrollback.ts`, so the benchmark tracks the real configurable range. Fidelity gap (documented in `lib/terminalSearchFixture.ts`): headless has no render service, so decorations are shimmed — the buffer walk, the capped match collection and marker lifecycle are real, the highlight painting is not.
- **Session snapshot/reparse (PERF-195/196)** — `SerializeAddon.serialize()` across a 12-terminal fleet at maximum scrollback (the real teardown cost on every quit), and feeding those payloads back through the xterm parser. PERF-196 is a PARSER FLOOR, not wall-clock restore: production sends payloads this size (~600 KiB) through `TerminalRestoreController`, which chunks at 32 KiB with UI yields and schedules fleet restores independently, and that controller cannot run in-process. A regression in chunking, yielding or scheduling is invisible to PERF-196 and needs a Playwright benchmark. The corpus is SGR-dense because real agent output is, and colour dominates payload size.

Every scenario inherits `maxRegressionPct` from `defaultBudget`. A scenario with no baseline entry is a note, not a problem — normal for a new scenario, and normal for any scenario on a machine or OS being measured for the first time.

The `calibrating` flag is gone. It existed to suppress the regression gate until a runner-generated baseline landed; with no gate left to suppress it did nothing but hide the coverage note for the scenarios it was applied to.

## Sidebar list derivation (PERF-400..402)

The four pure functions `SidebarContent` re-runs over the WHOLE worktree set on every render and every filter keystroke: `matchesFilters` per row, `sortWorktreesByRelevance`, `groupByType`, and `computeChipCounts`. PERF-140/141 cover the store apply that produces that set; nothing covered what the component then does with it. All four load with a plain import — they are pure and reach nothing renderer-only, so no esbuild bundle and no stubs are involved, unlike `lib/worktreeSidebarFixture.ts` next door.

Each iteration is 18 derivation passes: progressive typing of a planted needle (0 to 5 characters) crossed with three facet levels (0, 2 and 5 active filter groups). `groupByType` runs only on the browse passes, because grouped mode is skipped while a query is active. **PERF-400** is 50 worktrees, **PERF-401** is 200, and **PERF-402** is the same 200-worktree sweep reported per operation rather than per pass.

**The number PERF-402 exists for**: at 200 worktrees `computeChipCounts` is **3.3 ms of a 4.3 ms pass — 77% of the derivation, and ~6.8× the row filter it sits beside** (0.49 ms), because it is six more full `matchesFilters` sweeps, one per facet group with that group's own filters lifted. The sort is 0.37 ms and the grouping 0.11 ms. The filter bar's live counts cost several times more than the list they sit above.

Four predicates, one per operation — a single aggregate could not tell which of the four went missing, and three of the four are cheaper to skip than to perform. Every expectation is arithmetic over the generator's own plant records; no oracle calls a `worktreeFilters` export. The corpus is built so that the needle's first character appears nowhere else in any name, branch, issue title or PR title, which is what makes "which rows must survive this query" knowable without scoring anything. `chipCountMisses` grades all 39 chip keys against the six group-excluded base sets separately, so the cheap wrong answer — count one fully-filtered set six times, ~6× faster — scores rather than passing. Scope limit: the component's own quick-state filter and always-show bypasses are outside the bracket.

## Project switcher ranking (PERF-403/404)

⌘P re-ranks the whole workspace list on every keystroke. PERF-170/171 measure `actionPaletteSearch` — a different scorer over the action catalog, with no typo tier, no activity keys and no two-kind row model — so this is new coverage rather than a second reading of the same code. Four subjects, four accumulators: `rankSwitcherMatches` (the re-rank), `scoreProjectQuery` (its inner per-row scoring loop, priced directly), `isFilterMatch` (the same module's filter-only matcher, whose production caller is `filterPilotGroups` in the Pilot overview), and `computeSearchActivityKey` (the palette session's activity freeze, taken once per open). Plain imports again — the module's only value import is `classifyAssistantActivity`, which is pure.

**PERF-403** types a planted needle one character at a time against 60 projects + 20 scratches and again against 240 + 60. **PERF-404** is the one-edit correction path (#11924): type an adjacent transposition, notice, backspace to the last good prefix, then type the rest correctly. The middle of that sequence lands in the terminal typo tier where every clean scorer returns 0, and the reading to take from it is `degradedResultRowCount` against `cleanResultRowCount` — at 300 rows a single fat-fingered character takes the list from 159 rows to 111 rather than to nothing, which is what the tier exists for.

The rank predicate is deliberately two-sided in the way the brief demands. A ranker that returns nothing fails "every planted substring match is present"; one that returns everything fails "no planted non-match is present"; one that returns everything in an arbitrary order fails "the exact-name match ranks first" and "name matches precede path-only matches". `activityMisses` grades the freeze against a planted demand ladder by ORDER rather than against the module's private class constants — blocked ahead of waiting ahead of review ahead of working ahead of quiet, with each row's volume equal to the count the generator planted — so a classifier returning a constant and one that kept its tiers but dropped its volumes are separately caught. Scope: ranking cost with the renderer removed; a regression in how the palette re-renders its rows is invisible here.

## Reference values

`scripts/perf/config/budgets.json` holds reference values, not thresholds. A measurement outside one is annotated in the report and in the console as `[outside]`, and the run still exits 0. Metric ceilings are compared against each metric's **max** across iterations, never its mean: a ceiling of `gitSpawns: 1.5` must not pass when one iteration in sixteen spawned twenty.

`criticalScenarios` is gone with the gate. It only ever decided which scenarios could fail a run, and while it remained it silently exempted those scenarios from the baseline-coverage note.

## Baselines

Baselines are read from `scripts/perf/config/baseline.<mode>.json` and are the reference the drift annotation compares against.

Regenerate after accepted optimisation work:

```bash
npm run perf smoke -- --scenario PERF-105 --update-baseline
npm run perf ci -- --scenario PERF-105 --update-baseline
```

Baselines are **machine-specific, and that is now the point**. The old rule — regenerate on the runner class, never commit one from a laptop — existed because a baseline was a shared gate, and a laptop number would have become the threshold every platform was judged against. Nothing gates now, and there is no CI to harvest from. A reference value is context for reading one number, so the right reference for your machine is one measured on your machine.

**Every entry carries its own provenance**, because the merge below made a file-wide date a lie:

```json
{
  "generatedAt": "…",
  "mode": "smoke",
  "scenarios": {
    "PERF-105": {
      "p95Ms": 13.4,
      "measuredAt": "…",
      "machine": { "machineLabel": "…", "platform": "darwin", "arch": "arm64" }
    }
  }
}
```

`generatedAt` is now only when the file was last written and dates nothing in it. Freshness is judged per entry against a 30-day threshold and stays advisory: a stale reference for the scenario you are running is named on its own line, the rest collapse into a count.

`--update-baseline` **merges, and re-dates only the scenario it measured**. Every run measures one scenario, so writing the file wholesale would leave a baseline holding a single reference and looking complete — and stamping the whole file with today's date would make forty six-month-old references read as measured this morning. Inherited entries keep their original date and machine, including entries for a scenario that is `diagnostic` or `unsupported` here: regenerating where a scenario cannot be measured must not delete, or re-date, the reference from a platform where it can. The results history under `history/` merges on the same rule.

**A reference from another machine is reported but not compared.** A p95 is a `duration`, so a drift verdict against a number measured on a different laptop is a claim about two laptops. The value is still shown — it is often the only reference a scenario has — and the verdict is replaced with `reference 5.5ms not compared: different machines (greg-thinkpad vs gregs-mac-studio-2)`. Without this guard a Windows reference against a Mac run produced a fabricated 2200% regression.

The four committed baselines are still in the **pre-provenance** shape (`p95ByScenario`, a bare number per scenario). They are read, not migrated: each entry is lifted with the file's own date, which is honest for that shape because the whole-matrix writer that produced it wrote every entry in one pass — and with a **null machine**, which is treated as "measured elsewhere". Unknown resolved in the convenient direction is exactly how another machine's number ends up annotating your run. The practical consequence: **until you re-measure a scenario here, its drift verdict is withheld and the row says why.** One `--update-baseline` for that scenario fixes it and rewrites the file into the new shape.

`npm run perf verify-baselines` asserts the committed files are **usable** — parseable, correctly moded, well-formed entries, provenance complete where present, no zero or non-finite reference (the `durationMs: 0` sentinel trap). It no longer asserts fresh-and-complete, because neither claim has a whole-matrix run behind it any more; coverage, age, machine mix and orphaned ids are reported as notes that cannot fail it. It remains the one script here that exits non-zero.

## Manual cold-start

`npm run perf cold-start` is a manual, one-shot cold-start sampler. It launches the packaged binary N times from a fresh profile, parses the NDJSON marks (`DAINTREE_PERF_METRICS_FILE`) after each run, and prints an aggregated p50/p95 table covering key phase durations, individual marks, and IPC round-trip timings per channel. No thresholds, no baselines, no CI gating.

Requires a packaged binary under `release/` — build one first with `npm run package` (or `npm run package:local` on macOS for an unsigned dev build).

```bash
npm run perf cold-start                   # 5 runs, text table
npm run perf cold-start -- --runs 10      # custom run count
npm run perf cold-start -- --json         # structured JSON for diffing
npm run perf cold-start -- --trace        # capture GPU/compositor traces
```

IPC sampling is forced to 100% for this command so per-channel stats are meaningful across a small number of runs.

The `main_window_shown` mark records the moment `win.show()` is called (when the OS is asked to map the window). It surfaces as the `boot → main_window_shown` and `main_window_created → main_window_shown` phase pairs, exposing the dom-ready-gated window-reveal wait the harness was previously blind to. A mark carries `meta: { fallback: true }` when the 5s dom-ready fallback timer fired instead of the normal dom-ready signal.

## Manual launch A/B (`perf launch-ab`)

`npm run perf launch-ab` is a direct-spawn launch benchmark: it spawns the packaged binary (no Playwright, no debugger attach, no CDP handshake) and reads the app's own NDJSON perf marks, so each sample matches what a user actually experiences. With `--a <exeA> --b <exeB>` it alternates launches between two binaries (A, B, A, B, ...) so machine-state drift lands on both variants equally, then prints per-variant p50/mean/stdDev for the key launch phases plus the delta table. `--warm` gives each variant a persisted profile dir and one unmeasured warmup boot so measured runs are compile-cache/code-cache warm (steady-state boots); the default is a fresh profile per run (first-launch boots).

```bash
npm run perf launch-ab -- --runs 15                       # current release/ build
npm run perf launch-ab -- --a <exeA> --b <exeB> --runs 15 # interleaved A/B
npm run perf launch-ab -- --warm --json ...               # steady-state, machine-readable
```

Prefer this over `perf cold-start` for before/after comparisons across branches: build each branch with `npm run package:local`, move each `release/mac-<arch>` bundle aside, and point `--a`/`--b` at the two executables. (`electron-builder` wipes `release/` on every package run — never leave the only copy of a comparison build there.)

## Keystroke-to-paint and TUI scroll (`perf interactivity`, `perf scroll`)

Two opt-in Playwright benchmarks for the interactions that historically regressed silently — a focused terminal going dead under fleet load, and full-screen TUI scrolling stalling.

`npm run perf interactivity` measures keydown → paint (PERF-120/121/122) across a `cat` floor, a hermetic composer-sim, and the sim under 12 background terminals plus a saturation tier. `npm run perf scroll` measures wheel-notch → paint for mouse-reporting TUIs (PERF-125/126/127), ending in the concurrent cell where six TUIs scroll at once with a bystander keystroke-echo probe.

Both rebuild the e2e bundle, run multi-minute, and gate nothing in CI — they report invariants and ratios, with absolute budgets left until a calibration soak has run. They are opt-in commands, not part of any matrix mode.

```bash
npm run perf interactivity
npm run perf scroll
```

## Cold recipe fanout (`perf recipe-fanout`)

`npm run perf recipe-fanout` rebuilds the E2E benchmark bundle, launches the `full-worktree` Playwright project with one worker, and measures cold PTY fanout at N=1, 5, and 10 for both an existing worktree (PERF-180) and a newly created real worktree (PERF-181). The default fixture is a hermetic `claude` executable placed on a temporary `PATH`; it crosses the normal recipe, panel, PTY host, process, MessagePort, xterm, and DOM-paint paths without using user agent configuration or network access.

```bash
npm run perf recipe-fanout
PERF_RECIPE_FANOUT_SIZES=1,10 PERF_RECIPE_FANOUT_ROUNDS=1 npm run perf recipe-fanout
PERF_RECIPE_FANOUT_OUTPUT=.tmp/perf-results/recipe-fanout-before.json npm run perf recipe-fanout
```

Controls: `PERF_RECIPE_FANOUT_SIZES` (default `1,5,10`, maximum 10), `PERF_RECIPE_FANOUT_ROUNDS` (default `5`), `PERF_RECIPE_FANOUT_WARMUPS` (default `1`), `PERF_RECIPE_FANOUT_AGENT=fixture|vendor` (default `fixture`), `PERF_RECIPE_FANOUT_OUTPUT`, and `PERF_RECIPE_FANOUT_SEED` (default `180`). Vendor mode is diagnostic only and must not be used for regression comparisons because authentication, updates, network latency, and rate limits are not reproducible.

The benchmark has reliability gates but no latency budget: every expected panel, cold PTY spawn, xterm attachment, panel-scoped token paint, worktree assignment, and cleanup must succeed, while timing summaries remain observational until platform baselines are reviewed.

## Bulk issue worktrees (`perf bulk-issue-worktrees`)

`npm run perf bulk-issue-worktrees` measures the full bulk workflow represented by PERF-182: open the forge issue list, select every fixture issue, click Create worktrees, choose a starting-layout recipe, confirm, create one fake worktree per issue, and run the recipe in each worktree. Forge responses, branch/path resolution, and worktree creation are hermetic in-memory IPC handlers, so the benchmark never contacts GitHub or executes `git worktree`; terminal startup continues through the production renderer queue, IPC admission limiter, PTY host, and child-process path.

The default matrix runs N=1, 6, and 10 across three fresh-app rounds with one warmup. Results are written atomically to `.tmp/perf-results/bulk-issue-worktrees.json` and include selection/dialog latency, first and last fake-worktree completion, dialog completion, first and last real terminal spawn, whole-flow latency, renderer frame gaps, terminal-admission pauses, and the number of terminals admitted before the first pause.

```bash
npm run perf bulk-issue-worktrees
PERF_BULK_ISSUE_SCALES=1,10 PERF_BULK_ISSUE_ROUNDS=1 npm run perf bulk-issue-worktrees
PERF_BULK_ISSUE_OUTPUT=.tmp/perf-results/bulk-issue-worktrees-before.json npm run perf bulk-issue-worktrees
```

Controls: `PERF_BULK_ISSUE_SCALES` (default `1,6,10`, maximum 20), `PERF_BULK_ISSUE_ROUNDS` (default `3`), `PERF_BULK_ISSUE_WARMUPS` (default `1`), and `PERF_BULK_ISSUE_OUTPUT`.

## Memory-pressure responsiveness (`perf memory-pressure`)

`npm run perf memory-pressure` builds the E2E benchmark bundle, launches five real PTYs/xterms with seeded scrollback and continuous output, injects a hermetic critical system-memory reading, and measures renderer frame gaps, timer gaps, Long Animation Frames, active-renderer reclaim events, and renderer memory. It is observational rather than CI-gated; use identical controls for before/after comparisons and write each arm to a separate output path.

```bash
PERF_MEMORY_PRESSURE_LABEL=before PERF_MEMORY_PRESSURE_OUTPUT=.tmp/perf-results/memory-pressure-before.json npm run perf memory-pressure
PERF_MEMORY_PRESSURE_LABEL=after PERF_MEMORY_PRESSURE_OUTPUT=.tmp/perf-results/memory-pressure-after.json npm run perf memory-pressure
```

Controls: `PERF_MEMORY_PRESSURE_TERMINALS` (default `5`), `PERF_MEMORY_PRESSURE_SCROLLBACK_LINES` (default `1500`), `PERF_MEMORY_PRESSURE_SAMPLE_MS` (default `12000`), `PERF_MEMORY_PRESSURE_POLL_INTERVAL_MS` (default `1000`, fault-mode only), `PERF_MEMORY_PRESSURE_AVAILABLE_MB` (default `512`, fault-mode only), `PERF_MEMORY_PRESSURE_LABEL`, and `PERF_MEMORY_PRESSURE_OUTPUT`.

## Long-session memory growth (`perf memory-growth`)

`npm run perf memory-growth` builds the E2E benchmark bundle and keeps one Daintree process tree alive while repeatedly switching between two cached projects, streaming output through four stable PTYs/xterms, opening and closing transient terminals, and updating watched files. It seeds each terminal past the analysis and visible scrollback limits before cycle zero, performs warmup cycles, samples both natural and forced-GC retained state, and records app/process RSS, macOS physical footprint, main and renderer heaps, per-utility memory, PTY-host descriptors and PTMX handles, renderer frame gaps, and whole-cycle duration. The stable panel and project-view counts are asserted after every measured cycle so topology growth cannot masquerade as a memory leak.

```bash
MEM_GROWTH_LABEL=before MEM_GROWTH_OUTPUT=.tmp/perf-results/memory-growth/before.json npm run perf memory-growth
MEM_GROWTH_LABEL=after MEM_GROWTH_OUTPUT=.tmp/perf-results/memory-growth/after.json npm run perf memory-growth
npm run perf memory-growth-compare -- .tmp/perf-results/memory-growth/before.json .tmp/perf-results/memory-growth/after.json
```

Controls: `MEM_GROWTH_PROJECTS` (default `2`), `MEM_GROWTH_TERMINALS` (default `2` per project), `MEM_GROWTH_WARMUPS` (default `3`), `MEM_GROWTH_CYCLES` (default `10`), `MEM_GROWTH_SEED_OUTPUT_LINES` (default `5500` per terminal), `MEM_GROWTH_OUTPUT_LINES` (default `750` per terminal per cycle), `MEM_GROWTH_SETTLE_MS` (default `4000`), `MEM_GROWTH_EPHEMERAL` (`0` disables transient-terminal churn for diagnosis), `MEM_GROWTH_LABEL`, `MEM_GROWTH_OUTPUT`, and `MEM_GROWTH_TIMEOUT_MS`.

## GPU/compositor traces (`--trace`)

`--trace` makes the packaged app self-start Electron's `contentTracing` (categories `viz,gpu,cc,blink,toplevel,startup`) for the full startup-to-quit window, writing one trace per run to `.tmp/perf-results/trace-run-N.json`. This is the way to see why the compositor takes time between `main_window_shown` and the first painted frame.

The output is Chromium's JSON Trace Event Format — open it directly at https://ui.perfetto.dev (drag-and-drop the `.json` file, no conversion needed).

Tracing adds measurable overhead to the traced process, so `--trace` is opt-in and gated behind a second env flag (`DAINTREE_PERF_TRACE`) that normal runs never set. **Do not mix `--trace` runs into baseline timing numbers** — capture traces in a separate session. Trace files can be large (tens of MB) and are transient build artifacts under `.tmp/`.
