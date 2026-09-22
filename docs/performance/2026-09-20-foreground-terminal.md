# Foreground agent terminal investigation — 20 September 2026

This investigation targets one or two visible agent terminals. The benchmark uses a real Electron window, WebGL renderer, PTY, toolbar agent launch and host working/waiting detector. The agent is a deterministic local fixture: it performs no inference or network requests and never reads user agent configuration. The scope is app overhead while displaying ordinary agent output, not the cost of Claude or Codex themselves.

## Protocol

Reference source: `c67e86d959b3768fd89d75273906e0f1a2828bbc`. Branch: `perf/single-terminal-foreground`. Original and candidate built bundles are preserved separately and copied into place only while the benchmark app is closed. Hardware: Apple M4 Max, 16 logical CPUs, 64 GiB RAM, macOS 26.3.1. Each comparison uses identical measurement code, a fresh temporary profile and fixture repository, Menlo 12px, a 1728 × 1000 CSS-pixel window at DPR 2, and eight seconds of settling after the required agent state appears. The installed Daintree app remains untouched.

The controlled cases are a quiet waiting agent, a changing composer at 10 Hz, an identical composer redrawn at 10 Hz, a 20-line/second stream, typing at five characters/second, and two visible 10 Hz composers. The final comparison uses two 30-second original windows and two 30-second candidate windows per case, in original/candidate/candidate/original order. No builds or test suites run concurrently. Earlier harness qualification and profiling runs are excluded from the comparison.

CPU means summed app-process CPU time divided by elapsed time, as percent of one core. Electron's process inventory includes the main process, renderers, GPU helper and utility hosts, but excludes shell and agent descendants. GPU means the same processes' AGX accumulated device GPU time divided by elapsed time; it is not percent occupancy of all GPU cores and is not directly interchangeable with Activity Monitor's GPU column. WindowServer and unrelated apps are excluded. Neither counter measures watts or battery life.

Each round rejects changed process/GPU-client topology, absent GPU counters, insufficient output cadence, missing final output, missing input confirmation, or failed working/waiting transitions. Input latency runs from xterm's input event to a render callback whose buffer contains the exact expected input. This is a render confirmation, not a hardware presentation timestamp. The fixture uses real OSC activity heartbeats; this validates the exercised detector path, not every heuristic used by arbitrary agents.

## Investigated changes

The first candidate guards automatic scroll-to-bottom after parsing when the viewport is already at the tail. In the pinned xterm version, even a zero-distance scroll requests a full viewport refresh. A spinner already dirties its changed rows; forcing every row dirty again is unnecessary. The guard preserves selection, scrollback, alternate-screen behavior and following an advancing tail. Parsing and activity notification continue for every chunk. It does not change frame rate.

A retained WebGL drawing buffer with dirty-row scissoring was also prototyped and rejected: its diagnostic GPU reading was unchanged and its CPU reading was slightly worse. No retained-buffer/scissor code remains.

The combined candidate also slows the decorative working spinner from a 1.4-second to a 2.4-second revolution, preserving its 24 visual positions (17.1 → 10 updates/second). The shared epoch still synchronizes indicators, and reduced-motion, hidden-view and power-saving behavior is unchanged. Terminal output, input and activity detection are not throttled. This is a visible reduction in decorative rotation speed, not a change to how quickly an agent's state is recognized.

Diagnostic ablations removed all motion, backdrop filters, layer hints, or replaced the transform with a rotating SVG stroke. They identified animation/compositing cost, but are not product configurations or before/after results. Removing the theme's material effect was rejected as an appearance change; the stroke and layer-hint alternatives did not improve the readings enough to justify shipping. An isolated backdrop pseudo-element was also discarded.

The original stretch target of 25% less CPU was not met by the redundant-scroll guard alone. The combined candidate's separately declared keep criterion is at least 20% less device GPU time on spinner workloads, no CPU regression, and the same correctness and responsiveness guards. CPU and GPU outcomes are reported separately.

## Results

Time-weighted averages of two valid 30-second windows per arm. CPU is percent of one core; GPU is the device-time metric defined above. These are controlled fixture results, not universal application utilization. All 20 accepted windows passed the output, input, process topology, live WebGL, geometry and state checks.

| Case | CPU before | CPU after | CPU reduction | GPU time before | GPU time after | GPU-time reduction |
| --- | --: | --: | --: | --: | --: | --: |
| One waiting agent, no output | 4.69% | 4.76% | -1.3% | 0.134% | 0.135% | -1.4% |
| One working agent, 10 Hz composer | 21.68% | 18.86% | 13.0% | 3.436% | 2.575% | 25.1% |
| One agent, identical 10 Hz redraws | Pending | Pending | — | Pending | Pending | — |
| One agent, 20 output lines/second | 24.56% | 23.40% | 4.7% | 4.255% | 3.570% | 16.1% |
| One agent, 5 typed characters/second | 11.67% | 10.45% | 10.5% | 0.900% | 0.861% | 4.3% |
| Two working agents, 10 Hz each | 25.82% | 22.75% | 11.9% | 4.329% | 3.414% | 21.1% |

Quiet waiting is effectively unchanged. The small streaming CPU difference is within the observed spread and is not claimed as a reliable CPU win. The original 25% CPU stretch target was not reached; the single- and two-spinner GPU reductions meet the separately declared 20% target.

| Case | Original CPU range | Candidate CPU range | Original GPU-time range | Candidate GPU-time range |
| --- | --: | --: | --: | --: |
| One waiting agent, no output | 4.52–4.87% | 4.57–4.94% | 0.12–0.14% | 0.13–0.14% |
| One working agent, 10 Hz composer | 21.20–22.16% | 18.34–19.39% | 3.44–3.44% | 2.56–2.59% |
| One agent, 20 output lines/second | 24.19–24.94% | 22.53–24.26% | 4.21–4.30% | 3.53–3.61% |
| One agent, 5 typed characters/second | 11.54–11.79% | 10.29–10.60% | 0.90–0.90% | 0.85–0.87% |
| Two working agents, 10 Hz each | 25.62–26.02% | 22.75–22.76% | 4.28–4.38% | 3.30–3.53% |

Typing confirmed 294 characters in the original and 294 in the candidate, with no missing or duplicated input. p95 input-to-render confirmation was 5.25 → 5.23 ms; maxima were 36.96 → 34.08 ms. The one-spinner terminal rendered 10.79 → 10.74 times/second while reported dirty rows fell 91.5%. Terminal draw cadence was preserved. Working-to-waiting transitions remained approximately 8–9 seconds in the active spinner/stream cases, reflecting the existing detector; no detection timing setting changed.

The identical-redraw case is pending: macOS loginwindow records screen-saver activation and the lock shield at21:25:25.460 local, after the other five cases finished and before the first identical-redraw sample. Its four readings are excluded. A native screen-lock preflight and endpoint check, plus a renderer power-saving-policy check, were added afterward. This validation-only harness revision has not yet produced a new foreground comparison; the recorded apparatus hash identifies the accepted earlier runs. The desktop must be unlocked to finish that case.

The accompanying [machine-readable evidence](./2026-09-20-foreground-terminal.json) includes sample ranges, geometry, input samples, state latencies and both built-app hashes. Each case uses an identical harness hash in its original and candidate arms. Profiling and ablation numbers are excluded.

## Validation

- Full `npm test`: 2,808 files passed; 63,261 tests passed, nine skipped and one todo. Two test files were skipped.
- Focused scrolling, decorative motion, launch cleanup/telemetry and benchmark registry/class checks: six files and 176 tests passed.
- `npm run check`: passed, including type checking, generated-code guards, lint ratchet and formatting.
- `npm run build:e2e`: passed for the combined candidate. The benchmark uses this built app; no broad E2E suite was run.

## Reproduction

```sh
npm run build:e2e
npm run perf foreground-terminal -- --scenario spinner --seconds 30 --rounds 1 --output .tmp/perf-results/foreground-spinner.json
```

Select one of `idle`, `spinner`, `redundant`, `stream`, `typing`, or `two-spinner`. Re-measure both built revisions with the same harness, geometry and background conditions. Do not build while a test app is running. `--trace` produces diagnostic CPU/Chromium profiles and refresh call stacks; profiling readings are not ordinary benchmark results.

Machine-local raw data, screenshots, bundle copies and the decision ledger are in `.tmp/foreground-terminal/`. Synthetic summary evidence accompanies the final report; user terminal contents are not recorded by this benchmark.
