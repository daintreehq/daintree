# Boot chunk compile hints — 23 October 2026

`compileHintsPlugin` in `vite.config.ts` puts `//# allFunctionsCalledOnLoad` on the boot chunks, so V8 compiles every function in them when the chunk loads instead of on first call. #14219 measured the memory side: an idle empty project view holds about 6 MB more compiled code with the hints, about 13 MB of renderer footprint. This investigation measures what the hints buy in latency, and whether a narrower hinted set keeps that latency for less memory (#14238).

**Decision: keep the full hinted set.** In these measurements the hints made a new project view reveal 72 ms sooner (median) and a warm launch reach interactive 39 ms sooner. Neither narrowing that was tried kept that latency while saving a meaningful amount of memory.

## Protocol

Reference source: `f83a95bd1b` (develop), before #14219's ASCII chunk emission and cached-view cache clear landed; neither changes which functions the hints compile. Hardware: Apple M4 Max, 36 GB RAM, macOS 15.7.5, Electron 42.11.18. Nothing else was building or benchmarking during the runs. The evidence file [`2026-10-23-boot-compile-hints.json`](2026-10-23-boot-compile-hints.json) holds every launch and memory observation, every project-switch run summary, the bootstrap intervals and the hinted chunk sizes.

Four arms, selected at build time with `DAINTREE_COMPILE_HINTS`:

| Arm | Hinted chunks |
| --- | --- |
| `all` | The shipped set: entry, `App`, `boot*` groups, `vendor-react`, `vendor-xterm`, `TerminalInstanceService`, `appThemeStore`. 38 files, 5,003,685 bytes |
| `no-vendor` | `all` minus `vendor-react` and `vendor-xterm`. 36 files, 4,421,365 bytes |
| `no-app` | `all` minus the `App` chunk (1,853,276 bytes). 37 files, 3,150,441 bytes |
| `none` | No hints |

Every arm shares one `build:e2e` main process; only the renderer bundle differs. Each arm's `dist/` was kept separately and swapped in only while no app was running.

- **Launch.** `npm run perf launch-ab`, interleaving the two arms launch by launch, 20 launches per arm. Cold runs use a fresh profile per launch. Warm runs (`--warm`) reuse one profile per arm after a single warmup launch. The headline metric is `boot → renderer_first_interactive` for the main window, and an `all` against `all` run calibrates the noise.
  - **Unpackaged arms.** electron-builder cannot package from a worktree whose `node_modules` is a symlink, so the arms ran unpackaged. Unpackaged builds use `v8CacheOptions: "code"` instead of the packaged `"bypassHeatCheck"`. A fresh profile has no cache to consume under either policy, but the policies differ in when a cache is produced, so the cold numbers are unpackaged measurements. Under `"code"`, a cache is produced on the second load and consumed from the third. So with one warmup, the first measured warm launch produces the cache rather than consuming it. Dropping that launch moves the `none` warm delta from +39 ms to +36 ms.
- **New project view.** `npm run perf project-switch` with `PERF_SWITCH_COLD_ROUNDS=5`, in arm order A/B/B/A, giving 28 LRU-evicted switches per run. Before measuring, the harness opens one project and seeds terminals in two more, so the measured views load against a populated code cache. That is the steady state, not the first views after an install or update. The metrics are the app's own `projectview.coldstart` `visibleMs` (reveal) and `projectview.coldstart.interactive` `interactiveMs`. Every run had zero renderer crashes and zero paint-gate hard timeouts.
- **Idle memory.** One empty project view, 15 s settle, two forced GCs, then `Runtime.getHeapUsage` and a heap snapshot of the view, with three samples per run. `all` ran four times (it was the baseline in both rounds) and every other arm ran twice. Compiled code is the summed `self_size` of `code` nodes, the same reading #14219 used.

## Results

Launch, `boot → first_interactive`. Each delta is the candidate minus `all`, comparing medians of 20 launches per arm, with a bootstrap 95% interval:

| Comparison             | Cold profile    | Warm profile         |
| ---------------------- | --------------- | -------------------- |
| `all` vs `all` (noise) | +1 ms (−55…+30) | —                    |
| `none`                 | +28 ms (−1…+55) | **+39 ms (+17…+61)** |
| `no-vendor`            | +25 ms (+1…+46) | −13 ms (−23…+17)     |
| `no-app`               | +17 ms (+8…+25) | +27 ms (−0.4…+55)    |

`all` reaches interactive in about 590–630 ms cold and about 500–525 ms warm. Only the `none` warm delta clears zero comfortably.

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
| `all`       |      21.4 MiB |     43.8 MiB |
| `no-vendor` |      20.9 MiB |     43.2 MiB |
| `no-app`    |      19.7 MiB |     42.0 MiB |
| `none`      |      15.7 MiB |     37.8 MiB |

The `all` against `none` gap agrees with #14219, which read 21.7 MB against 16.1 MB.

## Reading

- **Dropping the hints** saves 5.8 MiB of compiled code per idle view. That is about 13 MB of footprint per #14219, and extrapolating that figure gives roughly 52 MB across four cached views. In exchange, in these runs a new project view revealed 72 ms (38%) later and a warm launch reached interactive 39 ms (8%) later. Opening a project that isn't cached and relaunching are both everyday paths. The memory comes back only while a view sits idle, and #14219 showed the two converge once a view does real work.
- **The warm-launch gain** is consistent with the hints putting more of each boot chunk's bytecode into the code cache. Blink serializes the cache after the module evaluates, so a function that is still uncompiled at that point has no cached bytecode. Cache coverage and later lazy-compilation costs were not traced.
- **Narrowing to `no-vendor`** saves 0.6 MiB, too little to matter. It also costs about 20 ms of reveal and a borderline 25 ms cold launch.
- **Narrowing to `no-app`** saves 1.8 MiB, but gives back 62 ms of the 72 ms reveal gain over two runs. Most of the new-view win therefore rides on the `App` hint. Much of `App` is action definitions that a boot never calls, so the promising way to cut this memory is to move them out of the chunk (#14239) rather than drop the hint. That is untested; re-measure with this protocol after it lands.

## Reproduction

```sh
DAINTREE_COMPILE_HINTS=none npm run build:e2e   # or all | no-vendor | no-app
npm run perf launch-ab -- --a <exeA> --b <exeB> --label-a all --label-b none --runs 20 [--warm] --json
RUN_PERF_SWITCH=1 PERF_SWITCH_COLD_ROUNDS=5 PERF_SWITCH_OUT=<file> \
  npx playwright test --config=playwright.perf.config.ts e2e/perf/project-switch-perf.spec.ts --workers=1
```

For an unpackaged arm, `<exe>` is a two-line shell script that runs `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <arm-dir> "$@"`. The arm directory holds that arm's `dist/` and `dist-electron/`, with every other top-level entry of the checkout symlinked beside them. For the memory side, `npm run perf empty-view-memory` (from #14219) now measures the same reading, with `EMPTY_VIEW_HEAP_SNAPSHOTS=1` for the compiled-code split.
