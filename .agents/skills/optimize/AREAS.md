# Areas

The 156-scenario matrix, partitioned five ways so a fleet of workers can each take one without colliding.

**An area is a batch of runs, not a run.** `/optimize` works one cluster: one benchmark, or a handful that share a subject and a plausible common fix. Each area below lists its clusters; a worker given an area picks the one with the best evidence, runs it end to end, opens one pull request, and names in its report which clusters it passed over so the next run can take them.

**The partition is by owned source path**, which is what makes parallel workers safe: two areas do not edit the same files, so two pull requests do not conflict. A run that widens outside its area's paths breaks that guarantee. Where an area's paths would overlap another's, the shared file is listed under the area that owns the _mechanism_, and the other area treats it as read-only.

**Evidence dates.** Duration figures below come from `.tmp/perf-results/latest-{ci,nightly}` (2026-08-04, 63 scenarios) and from the findings recorded in `scripts/perf/README.md` by the runs that built each family. `baseline.smoke.json` (2026-08-31) covers 135 scenarios with p95 only. Nothing has been measured since, and roughly 40% of the matrix has never been measured at all. **Every figure here is a reason to look, never a before number** — Phase 3's own baseline is the only number a run may quote.

---

## Area A — Idle and git background tax

22 scenarios: `PERF-092..094`, `100..106`, `130..141`.

The largest measured cost in the matrix, and the one a user feels as a machine that will not go quiet. Idle windows are a fixed observation length by design, so **the p95 is never the target here** — the counts and cycle times are.

**Owned paths:** `electron/services/git/`, `electron/services/worktree/`, `electron/services/ProcessDetector/`, `electron/services/ProcessTreeCache.ts`, `electron/services/ActivityMonitor.ts`, `src/store/worktree*`.

| Cluster | Scenarios | Entry target | Recorded evidence |
| --- | --- | --- | --- |
| Git status pass | `PERF-100`, `103` | `metricStats.gitSpawns.max` | One spawn per pass, clean and dirty; 132 ms and 18 ms in CI |
| Git poll cycle scaling | `PERF-101`, `102`, `104` | `metricStats.spawnsPerWorktreeN50.max` | `cycleMsN50` 580 ms at 50 worktrees, one git process per worktree per cycle, unbatched |
| Git idle spawn rate | `PERF-105`, `106` | `metricStats.gitSpawns.max` | 13.5 s and 13.9 s smoke windows; `106` is the post-fault path that never returns to the cheap one |
| Process-tree idle tax | `PERF-092`, `093`, `094` | `metricStats.spawnObserverMisses`-guarded spawn counts | 19.6–24.0 s idle windows. Durations are not optimisable inside a budget here — target the counts |
| Sidebar watcher latency | `PERF-130`, `131`, `132`, `133`, `134` | `metricStats.gitSpawns.max` | `134` spends 12 spawns on 12 concurrent edits; `132` is pinned at the poll interval (`detectionToIntervalRatio` 1.07) |
| Topology pickup | `PERF-135`..`139` | `metricStats.gitSpawns.max` | `137` spends 12 git spawns and 2 worktree-list spawns to surface 10 adds |
| Store apply fan-out | `PERF-140`, `141` | `metricStats.perApplyUsN200.mean` | The apply that turns watcher output into rows |

**Start with:** the poll-cycle cluster, `PERF-101` on `spawnsPerWorktreeN50`. It is a count — one clean pair settles it, no interleaved A/B, and it travels to the Windows and Linux legs.

---

## Area B — Terminal and PTY hot path

19 scenarios: `PERF-030..035`, `045`, `063`, `110..112`, `193..196`, `370..373`.

Every byte of agent output crosses this. The felt symptom is a terminal that stutters while another one floods.

**Owned paths:** `electron/pty-host/`, `electron/services/pty/`, `src/panels/terminal/`, `shared/utils/agentFsm.ts`, `electron/services/AgentStateService*`.

| Cluster | Scenarios | Entry target | Recorded evidence |
| --- | --- | --- | --- |
| Flow control and the resume sweep | `PERF-370`, `371`, `372`, `373` | `metricStats.sweepAckUsAt48.mean` | The ack crossing the low watermark costs ~38 µs against ~0.06 µs for an ordinary ack — ~600×, superlinear in fleet size |
| Output pipeline | `PERF-030`, `031`, `032`, `045` | `metricStats.forwardedBytes.mean` | The burst and sustained paths, plus the pty-host's own volume |
| Parse isolation | `PERF-033`, `034` | `metricStats.echoDegradationX.mean` | Focused echo degrades **5.76×** under a background flood. `derived-ratio`, so local-only |
| Agent analysis CPU | `PERF-035` | `metricStats.cpuMsPerMb30.mean` | ~190–214 CPU-ms per MB of agent output |
| Reflow and resize | `PERF-110`, `111`, `112` | `metricStats.totalBlockedMs.mean` | 627 ms blocked across one splitter drag |
| Scrollback search and snapshot | `PERF-193`..`196` | `metricStats.searchMisses`-guarded durations | Serialize across a 12-terminal fleet is the real cost of every quit |
| Flush allocation | `PERF-063` | `metricStats.minorGcCountZeroCopy.max` | 400k flushes, 7.3 minor GCs — soak mode |

**Start with:** the flow-control cluster on `PERF-372`. One named mechanism (`sweepAggregateResume`'s fan-out), a six-term predicate, and a cost that grows with fleet size — which is the direction Daintree is going.

---

## Area C — Per-call main-process tax and control surface

34 scenarios: `PERF-200..205`, `225`, `280..285`, `340..343`, `350..353`, `360..364`, `380..384`, `390..392`.

Nothing here is individually slow. All of it is paid on every invoke, every keystroke, every log line, so the multiplier is the point.

**Owned paths:** `electron/setup/security.ts`, `electron/ipc/`, `electron/utils/logger.ts`, `electron/services/mcp-server/`, `electron/services/forge/`, `electron/services/forge*.ts` (the registry, resolver, RPC server and both relays are siblings of that directory, not inside it), `electron/services/CopyTreeService.ts`, `src/services/ActionService.ts`, `src/services/actions/`, `shared/config/agentRegistry.ts`.

| Cluster | Scenarios | Entry target | Recorded evidence |
| --- | --- | --- | --- |
| Log emit path | `PERF-380`, `381`, `382`, `383`, `384` | `metricStats.perEntryUsProbeHit.mean` | A 1 KiB line carrying a `sk-`/`ghp_`/`Bearer` sigil that completes no pattern costs **15.9 µs against 9.6 µs — 1.66× for zero redactions**. Paid by any line holding a git remote or a header dump |
| IPC envelope | `PERF-360`, `361`, `362`, `363`, `364` | `metricStats.perInvokeUsDeep.mean` | A deep object chain costs **13.6×** a flat payload of identical bytes, because `sizeGuardReplacer` stringifies the whole thing to produce a byte count. An error envelope is ~20× a success one |
| MCP tool surface | `PERF-203`, `281` | `metricStats.systemToolPayloadBytes.max` | 229 KB `tools/list` at the system tier — a deterministic size, and a public contract with every external agent |
| Forge and roster | `PERF-225`, `340`..`343`, `350`..`353` | `metricStats.rpcOutcomeMisses`-guarded counts | Registry, resolver, singleflight, both relays. `225` is cold activation, descriptor to bound impl — it lives here rather than with the plugin host because the code it moves is `electron/services/forge/` |
| CopyTree generation | `PERF-390`, `391`, `392` | `metricStats.bundleBytes.max` | Streaming costs **2.03×** the in-memory wall clock at 2,200 files; the worker offload costs ~113 ms on the first request and saves nothing after |

**Start with:** the log-emit cluster on `PERF-382`. Fast-tier, so a round is minutes; the predicate is genuinely two-sided (no planted secret survives, every planted non-secret does); and the tax is paid constantly in production.

---

## Area D — Startup, switching, hosts and persistence

40 scenarios: `PERF-001..004`, `010..013`, `042..044`, `046`, `053..058`, `060..062`, `070..077`, `080`, `220..224`, `260..264`.

The "why did switching projects just stall" cluster, and the subsystems underneath it.

**Owned paths:** `electron/window/`, `electron/services/persistence/`, `electron/services/migrations/`, `electron/store.ts`, `electron/workspace-host/`, `electron/services/plugin/`, `electron/services/CrashRecoveryService.ts`, `src/store/project*`.

| Cluster | Scenarios | Entry target | Recorded evidence |
| --- | --- | --- | --- |
| Project switch phases | `PERF-070`, `071`, `072`, `073` | `metricStats.payloadBytes.max` | A `size` target — what has to cross to hydrate is upstream of every duration in the family |
| Project view lifecycle | `PERF-074`..`077` | `metricStats.viewCreateCount.max` | Warm rotation, LRU eviction, pressure ladder, queued switches |
| Hydration | `PERF-001`, `002`, `003`, `010`, `013` | `metricStats.restoredPanels.max` | Empty, heavy, warm, mixed, 15+ panels |
| Cold start | `PERF-004` | `metricStats.serviceInitMs.mean` | 364 ms service init + 501 ms renderer ready. Nightly, packaged binary — expensive arms |
| Persistence engines | `PERF-053`..`058` | `metricStats.rowMisses`-guarded durations | Per-row vs one transaction; query plans asserted so a dropped index shows as a plan change |
| Utility host respawn | `PERF-046`, `224`, `260`, `261` | `metricStats.respawnReadyMisses`-guarded counts | Boot, round trip, refork readiness, the restart ladder and its give-up boundary |
| Migrations | `PERF-056`, `080` | `metricStats.migrationMisses`-guarded durations | The full v0→v27 chain on a populated database |
| Soak | `PERF-060`, `061`, `062` | `metricStats.memoryGrowthMb.mean` | 11.5% / 31 MB heap growth across a scaled overnight switch loop |

**Start with:** project switch phases on `PERF-071`, targeting `payloadBytes` with `deepEqualCalls` as a guard. Both deterministic; both travel.

---

## Area E — Renderer interaction and panels

41 scenarios: `PERF-020..024`, `150`, `151`, `160..162`, `170`, `171`, `190..192`, `240..246`, `300..305`, `320..325`, `393`, `394`, `400..404`.

Per-keystroke and per-open work. The sharpest single finding in the repo lives here.

**Owned paths:** `src/panels/file-browser/`, `src/panels/review/`, `src/panels/diff/`, `src/panels/file/`, `src/components/`, `src/hooks/`, `src/lib/worktreeFilters.ts`, `src/lib/projectSwitcherSearch.ts`, `src/lib/actionPaletteSearch.ts`, `shared/theme/`, `electron/services/AgentNotificationService.ts`, `electron/services/CliAvailabilityService.ts`, `electron/services/FileSearchService*`.

The three `src/lib/` entries are the actual subjects of this area's sharpest clusters — the sidebar derivation fixture imports `worktreeFilters` directly, and the switcher fixture imports `projectSwitcherSearch`. An earlier draft listed the panels that render those results and not the functions that compute them, which would have left a compliant worker unable to touch the thing it was sent to optimise.

| Cluster | Scenarios | Entry target | Recorded evidence |
| --- | --- | --- | --- |
| Sidebar derivation | `PERF-400`, `401`, `402` | `metricStats.chipCountsMs.mean` | At 200 worktrees `computeChipCounts` is **2.87 ms of the 3.78 ms sweep — 76%, ~6× the row filter beside it**, because it is six more full `matchesFilters` sweeps. The filter bar's live counts cost several times more than the filtering |
| Project switcher ranking | `PERF-403`, `404` | `metricStats.worstKeystrokeMsLarge.mean` | ⌘P re-ranks the whole workspace list per keystroke; `404` is the one-edit correction path. Kept apart from `PERF-170/171`, which score a different catalog with a different scorer — one fix does not move both |
| File picker | `PERF-190`, `191`, `192` | `metricStats.lsFilesSpawns.max` | `192` is the wait between pressing `@` and the picker showing anything — 114 ms cold |
| File browser and review hub | `PERF-240`..`246` | `metricStats.flattenMs.mean` | `242` is aimed at the known staleness bug; `246` is a 131 ms viewer load |
| Diff tokenize | `PERF-160`, `161`, `162` | `metricStats.tokensProduced.max` | Representative, oversized fallback, multi-file review open |
| CLI availability storm | `PERF-393`, `394` | `metricStats.windowSpawns.max` | `useAgentSetupPoll` re-probes all 18 CLIs every 3 s — 37 process starts per refresh, 111 across a wizard window |
| Themes | `PERF-300`..`305` | `metricStats.resolveMisses`-guarded durations | 15 palettes, oracles anchored on values absent from the subject |
| Notifications | `PERF-320`..`325` | `metricStats.gateDecisionCount.max` | 24-row gate battery, every gate present twice — suppressing and passing |
| DevPreview detection | `PERF-020`..`024` | `metricStats.maxChunksBeforeUrlCount.max` | URL detection, dual startup, restart loop, exit classification |

**Start with:** sidebar derivation on `PERF-402`, targeting `chipCountsMs`. One named function, a four-way predicate that catches skipping any of them, and a mechanism already diagnosed.

---

## Running a fleet

One area per worker, one machine per worker, one worktree per worker.

```bash
# studio-01
/optimize --area A
# studio-02
/optimize --area C
```

Each worker picks its own cluster, runs the full pipeline, and opens one pull request against `develop`. Workers never coordinate and never read each other's branches. Because the areas own disjoint paths, the pull requests merge independently.

A second pass against the same area picks the next cluster — the previous run's report names which ones it passed over and why.
