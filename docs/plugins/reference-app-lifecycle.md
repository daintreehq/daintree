# Reference app lifecycle matrix

What the Request Desk reference application (`plugins/sample-project/acme.requests`) must survive when it runs in many projects at once, and where each part is proven. The table is kept in code in `e2e/helpers/referenceAppLifecycle.ts`; `e2e/helpers/__tests__/referenceAppLifecycle.test.ts` fails when a row names a test that no longer exists, a metric the benchmark does not document, or a gap with no reason, and when the workload stops exceeding the largest default renderer cache.

Correctness and measurement are separate on purpose. The correctness journey asserts behaviour only and carries no timing; the benchmark reports numbers and gates nothing.

## Workload

- Six fixture repositories (`desk-alpha` … `desk-foxtrot`), each holding the committed reference app at `.daintree/plugins/acme.requests/` (its `dist/` copied intact, since that is what Daintree loads) and a `.daintree/mcp.json` giving agents read and write access to it.
- The renderer cache capped at two views with the low-memory threshold off, so the user cap alone decides eviction. Six is above the largest default cache (five, on 64 GB machines), so a rotation evicts whatever the cap.
- Each project gets its own workspace setting and its own sentinel request; the benchmark adds 100 more requests per project.
- The report provider is the app's synthetic one: offline, about six seconds per report.

## Running it

Neither is part of a correctness bucket, a release gate or any schedule. The journey belongs to the explicitly invoked plugins config, the benchmark to the gated perf config. Run them on request:

```bash
npm run build:e2e && npx playwright test --config=playwright.plugins.config.ts e2e/plugins/reference-app-lifecycle.spec.ts
npm run perf reference-app-lifecycle
```

The benchmark writes `.tmp/perf-results/reference-app-lifecycle/<label>.json` (`PERF_REFERENCE_APP_LABEL`, default `run`) with the raw samples, the hardware (platform, OS release, CPU model, logical cores, RAM), Electron and Chromium versions, the commit, the workload and a digest of the reference build it measured.

## Matrix

| Row | What must hold | Coverage |
| --- | --- | --- |
| `fresh-open` | A fresh project lists the app but never runs it until trusted; trust activates it and its migration seeds the demo records once | Correctness spec |
| `welcome-setup` | The setup step and the welcome answer are observed per project | Correctness spec |
| `agent-tools` | An agent launched in the project is handed the app's server, reaches its tools, writes a request the Home shows, and builds a report | Correctness spec (one recorded agent; the full agent dialect matrix is `agent-data.spec.ts`) |
| `rotation-isolation` | Two rotations through six projects: each sees only its own requests, workspace, setup and welcome; the cache never exceeds two views; every revisit is a new renderer | Correctness spec |
| `credential-isolation` | One project's live agent bearer is refused (403) by another project's endpoint | Correctness spec |
| `draft-eviction` | An unsaved draft on Home holds its view out of the user's cap while a clean project is evicted instead, memory-pressure reclaim takes it anyway, and the draft and its request come back on remount and after a compatible hot reload (a rewritten `dist/`) | Correctness spec |
| `system-sleep` | The app answers after suspend and resume | Correctness spec, simulated only (see limitations) |
| `restart` | After a relaunch on the same profile: trust, setup, welcome, the draft, and a report still building when the app quit, reconciled to one operation that succeeds | Correctness spec |
| `tour-background` | No tour or media plays for a project that is not presented | Gap in the journey; `src/components/Tour/__tests__/TourDialog.test.tsx` covers the pause |
| `switch-timings` | Warm and cold switch timings | Benchmark (`switch.warm`, `switch.cold`) |
| `resources` | Memory by process type, idle and active CPU | Benchmark (`memory`, `cpu.idle`, `cpu.active`) |
| `multi-window` | Multiple windows | Gap; `e2e/full/platform/core-multi-window.spec.ts` covers per-window project identity |
| `large-records` | Large virtualized records and artifacts | Gap; `e2e/full/resilience/core-perf-list-mount-budget.spec.ts` covers virtualization |
| `remote-reconnect` | Remote disconnect and reconnect | Gap; `e2e/remote-hosts/remote-host-plugins-mcp.spec.ts` and `remote-host-ssh.spec.ts` |

## Limitations

- **Platform coverage.** Both specs are written for macOS, Windows and Linux and use no platform-specific path, but no run has been recorded on any platform yet. Record each run's platform and result here before treating a row as verified there.
- **Sleep is simulated.** The spec emits `powerMonitor` `suspend` and `resume` in the main process. That runs Daintree's own suspend and wake handlers, but no timer is frozen, no socket drops and Chromium throttles nothing, so it is wiring coverage, not evidence about a real sleep.
- **The tour is silent.** The reference tour's chapters have `audioUrl: null`, and its pause follows renderer presentation signals that a cached view never surfaces as `visibilitychange`. The pause is covered by the `TourDialog` unit tests, not by this journey.
- **Request Desk is not a large-data app.** Its Home lists at most 100 rows without virtualization and its report is a small SVG, so the large-records row is not exercised with it.
- **One mount of Home.** The journey reads the application's Home beside the grid and never opens the same view as a grid panel, which would be a second editor with its own durable state.
- **Multiple windows and remote hosts** need their own harnesses; the rows point at the specs that cover the host behaviour.
- **Switch timings are an upper bound.** They are measured in the test process from the switch dispatch to the incoming Home showing its own sentinel, so they include Playwright polling and IPC. Compare a reading only with another from the same machine.
- **CPU** is the delta of each process's cumulative CPU time over a fixed window, as a percentage of one core; processes that start or end inside the window are counted, not folded in. **Memory** is working set per process, which counts shared pages once per process. Electron reports no process memory on Linux, so there the reading is null.

## Budgets

There are none yet, by design. The plugin budgets in `shared/config/pluginBudgets.ts` are observations, and this workload has no recorded spread. Before proposing a threshold, record repeated runs of an unchanged tree on named hardware, and set any budget above the spread they show.
