# Empty project view memory after #14245, #14246 and #14247, 25 October 2026

A re-run of the [23 October protocol](2026-10-23-empty-project-view-memory.md) on `develop` after three PRs that were meant to move its numbers: #14245 (xterm, closed dialogs and git action bodies off the boot closure), #14246 (trim the renderer history of terminals hidden a long time) and #14247 (keep the boot compile hints). Raw medians and per-run readings are in the companion [`2026-10-25-empty-project-view-memory.json`](2026-10-25-empty-project-view-memory.json) (#14249).

## Protocol

Unchanged from 23 October: `npm run perf empty-view-memory`, three runs per arm, 15 s settle, two terminals with 5,500 lines each, compared with `npm run perf empty-view-memory-compare`. Electron 42.11.18 (Chromium 148.0.7778.280, V8 14.8), Apple M4 Max, macOS 15.7.

The raw results behind the 23 October baseline were not kept, so the before arm was rebuilt rather than read from the doc: `f1cfeef224`, the #14243 merge that recorded it. The after arm is `develop` at `cab5687fd7`. Both were built and run on the same machine on the same day, one after the other. The before arm's `tsc` step fails against today's dev dependencies on a test file, so it was built with its `vite build` and `build-main` steps directly; the shipped bundle does not depend on that step.

The before arm reproduces the recorded baseline within its spread: 160 / 140 / 134 MB here against 158 / 138 / 139 MB recorded.

## Result

| Renderer footprint, median of 3 |     `f1cfeef224` |     `cab5687fd7` | Delta |
| ------------------------------- | ---------------: | ---------------: | ----: |
| Empty                           | 160 MB (159–160) | 157 MB (153–158) | −3 MB |
| Cached                          | 140 MB (137–140) | 143 MB (143–145) | +3 MB |
| After session                   | 134 MB (131–134) | 132 MB (130–136) | −2 MB |

| JS heap used, median of 3 | `f1cfeef224` | `cab5687fd7` |   Delta |
| ------------------------- | -----------: | -----------: | ------: |
| Empty                     |      43.9 MB |      42.1 MB | −1.8 MB |
| Cached                    |      44.4 MB |      50.3 MB | +5.8 MB |
| After session             |      42.6 MB |      42.5 MB | −0.1 MB |

**Empty view.** #14245 moved it. The empty ranges do not overlap, and the drop is in V8 (−1.7 MB in MemoryInfra), the buffer partition that holds script source (−2.5 MB) and Blink's script cache (−2.1 MB): the view no longer loads the xterm and terminal-service chunks it never uses. Compiled code in the heap snapshot went from 21.4 MB to 20.0 MB.

**Cached view.** +3 MB at the 15 s reading, all of it V8 compiled code (heap snapshot: 19.5 MB before, 24.6 MB after). It is not retained. Before #14245 the hinted `vendor-xterm` and `TerminalInstanceService` chunks were compiled at boot, so by the cached reading V8 had already flushed the bytecode the session never ran. Now they load with the first terminal, so their eager-compiled bytecode is younger at the same reading. At a 60 s settle the two arms are identical (123 MB footprint and 43.8 MB JS heap each, one run per arm), and by the after-session reading compiled code has converged (18.8 MB before, 18.5 MB after).

**After session.** Flat within noise.

**#14246** trims the history of terminals hidden for a long time. This harness hides them for 15 s, so it does not exercise that path, and none of these figures should be read as its effect.

**#14247** kept the compile hints, so it changes nothing against the before arm. The hints still apply to `vendor-xterm` and `TerminalInstanceService` now they are lazy; that is the deliberate trade documented in `scripts/lib/vite-boot-preload.ts`, and the 60 s reading shows it costs a cached view nothing once V8 has aged the unused code out.

No regression and no unmoved figure, so no follow-up issue.

## Caveats

- `cc` tile and GPU-process figures are pinned-visible readings under Playwright's focus emulation (#14237). They were also far lower on both arms today (`cc` 17.8 MB empty, 29 MB cached) than on 23 October (68.8 and 105 MB), on identical code for the before arm, so they are display and GPU-state dependent and not comparable across days. Only same-day arms compare.
- The heap snapshot and 60 s settle figures are one run per arm (`EMPTY_VIEW_HEAP_SNAPSHOTS=1`, `EMPTY_VIEW_SETTLE_MS=60000`), not medians.
