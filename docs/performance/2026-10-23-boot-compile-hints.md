# Boot chunk compile hints — 23 October 2026

`compileHintsPlugin` in `vite.config.ts` puts `//# allFunctionsCalledOnLoad` on the boot chunks, so V8 compiles every function in them when the chunk loads instead of on first call. #14219 measured the memory side: an idle empty project view holds about 6 MB more compiled code with the hints (about 13 MB of renderer footprint). This investigation measures what the hints buy in latency, and whether a narrower hinted set keeps the latency for less memory (#14238).

**Decision: keep the full hinted set.** The hints are worth about 70 ms on every new project view and about 40 ms on every warm launch, and neither narrowing that was tried keeps that latency while saving a meaningful amount of memory.

## Protocol

Reference source: `f83a95bd1b` (develop). Hardware: Apple M4 Max, 36 GB RAM, macOS 15.7.5, Electron 42.11.18. Nothing else was building or benchmarking during the runs. Raw per-run numbers and bootstrap intervals are in [`2026-10-23-boot-compile-hints.json`](2026-10-23-boot-compile-hints.json).

Four arms, selected at build time with `DAINTREE_COMPILE_HINTS`:

| Arm | Hinted chunks |
| --- | --- |
| `all` | The shipped set: entry, `App`, `boot*` groups, `vendor-react`, `vendor-xterm`, `TerminalInstanceService`, `appThemeStore` (38 files, 5.0 MB raw) |
| `no-vendor` | `all` minus `vendor-react` and `vendor-xterm` (36 files) |
| `no-app` | `all` minus the 1.85 MB `App` chunk (37 files) |
| `none` | No hints |

Every arm shares one `build:e2e` main process; only the renderer bundle differs. Each arm's `dist/` was kept separately and swapped in only while no app was running.

- **Launch.** `npm run perf launch-ab`, interleaving the two arms launch by launch, 20 launches per arm. Cold runs use a fresh profile per launch, so there is no code cache. Warm runs (`--warm`) reuse one profile per arm after a warmup launch. The arms ran unpackaged, because electron-builder cannot package from a worktree whose `node_modules` is a symlink. Unpackaged builds use `v8CacheOptions: "code"` rather than the packaged `"bypassHeatCheck"`. That difference does not apply to a fresh profile, and in a warm profile it only makes the first measured launch produce the cache instead of consuming it, which the median absorbs. The headline metric is `boot → renderer_first_interactive` for the main window. An `all` against `all` run calibrates the noise.
- **New project view.** `npm run perf project-switch` with `PERF_SWITCH_COLD_ROUNDS=5`, in arm order A/B/B/A, giving 28 LRU-evicted switches per run. Each switch creates a new project view against a code cache the boot view has already populated, which is the common case. The metrics are the app's own `projectview.coldstart` `visibleMs` (reveal) and `projectview.coldstart.interactive` `interactiveMs`. Every run had zero renderer crashes and zero paint-gate hard timeouts.
- **Idle memory.** One empty project view, 15 s settle, two forced GCs, then `Runtime.getHeapUsage` and a heap snapshot of the view, three samples per run, two runs per arm. Compiled code is the summed `self_size` of `code` nodes, the same reading #14219 used.

## Results

Launch, `boot → first_interactive` (median of 20 launches per arm; the delta is the candidate minus `all`, with a bootstrap 95% interval):

| Comparison             | Cold profile    | Warm profile         |
| ---------------------- | --------------- | -------------------- |
| `all` vs `all` (noise) | +1 ms (−55…+30) | —                    |
| `none`                 | +28 ms (−1…+55) | **+39 ms (+17…+61)** |
| `no-vendor`            | +25 ms (+1…+46) | −13 ms (−23…+17)     |
| `no-app`               | +17 ms (+8…+26) | +27 ms (0…+55)       |

Warm launches for `all` sit at about 505 ms and cold launches at about 600–630 ms. The warm-profile gain from the hints is the surprising part. It is consistent with V8 serializing only the functions compiled by the time the code cache is written: with the hints, the whole boot chunk is in the cache, and without them each launch still compiles the late callers lazily.

New project view (median of the per-run p50s):

| Arm         | Runs | Reveal `visibleMs` | `interactiveMs` |
| ----------- | ---: | -----------------: | --------------: |
| `all`       |    5 |             189 ms |          340 ms |
| `no-vendor` |    2 |             210 ms |          384 ms |
| `no-app`    |    2 |             251 ms |          387 ms |
| `none`      |    3 |             261 ms |          383 ms |

Idle empty project view (median of all samples):

| Arm         | Compiled code | JS heap used |
| ----------- | ------------: | -----------: |
| `all`       |       21.4 MB |      43.8 MB |
| `no-vendor` |       20.9 MB |      43.2 MB |
| `no-app`    |       19.7 MB |      42.0 MB |
| `none`      |       15.7 MB |      37.8 MB |

The `all` and `none` readings match #14219's 21.7 MB and 16.1 MB.

## Reading

- **Dropping the hints** saves about 5.7 MB of compiled code per idle view (about 13 MB of footprint, per #14219). That would be up to about 52 MB across four cached views. In exchange, every new project view reveals about 70 ms (38%) later, and every warm launch reaches interactive about 40 ms (8%) later. Opening a project that is not cached and relaunching are both everyday paths. The memory returns only while a view sits idle, and #14219 showed it converges once the view does real work.
- **Narrowing to `no-vendor`** saves 0.5 MB, too little to matter. It also costs about 20 ms of reveal and a borderline 25 ms cold launch.
- **Narrowing to `no-app`** saves 1.8 MB and loses the entire new-view reveal gain. The `App` hint is where that gain comes from. Much of `App` is action definitions that a boot never calls, so moving them out of the chunk (#14239) is the way to cut this cost without losing the latency. Re-measure with this protocol after that lands.

## Reproduction

```sh
DAINTREE_COMPILE_HINTS=none npm run build:e2e   # or all | no-vendor | no-app
npm run perf launch-ab -- --a <exeA> --b <exeB> --label-a all --label-b none --runs 20 [--warm] --json
RUN_PERF_SWITCH=1 PERF_SWITCH_COLD_ROUNDS=5 PERF_SWITCH_OUT=<file> \
  npx playwright test --config=playwright.perf.config.ts e2e/perf/project-switch-perf.spec.ts --workers=1
```

For an unpackaged arm, `<exe>` is a two-line shell script that runs `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <arm-dir> "$@"`. The arm directory holds that arm's `dist/` and `dist-electron/`, with every other top-level entry of the checkout symlinked beside them. Use `npm run perf empty-view-memory` for the memory side once #14219 lands.
