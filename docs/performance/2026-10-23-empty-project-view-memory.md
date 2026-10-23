# Empty project view memory, 23 October 2026

What one project view's renderer costs on its own, where that memory sits, and two cuts that took a cached view from 183 MB to 138 MB (#14219). Raw medians, per-run readings and the experiments are in the companion [`2026-10-23-empty-project-view-memory.json`](2026-10-23-empty-project-view-memory.json).

## Protocol

Harness: `e2e/perf/empty-project-view-memory-perf.spec.ts`, run with `npm run perf empty-view-memory` (macOS only). Compare result sets with `npm run perf empty-view-memory-compare -- <before> <after>`.

Electron 42.11.18 (Chromium 148.0.7778.280, V8 14.8), Apple M4 Max, macOS 15.7. A fresh profile and fixture repositories each run, headed, WebGL on, a 1600 × 1000 window at DPR 1. Three runs per arm, nothing else building or testing alongside.

One project view, identified by its renderer pid, is read at three points:

- **empty**: the project freshly opened, no panels, 15 s settled.
- **cached**: two terminals opened in it and 5,500 lines written to each, then a second project opened in front, 15 s settled. This is the state the view sits in for most of its life. Playwright's focus emulation keeps every page it attaches to visible, so the cached view is never hidden from Chromium here. Blink's own cache and the JS heap don't depend on that; compositor tiles do.
- **after-session**: switched back, both terminals removed (Alt-close, so not held in trash), 15 s settled.

Every reading follows two `HeapProfiler.collectGarbage` calls on that view, the one reclaim command safe on a hidden view in Electron 42. The harness asserts each view has its own renderer pid and that the target keeps its pid throughout.

What each reading records:

- **Footprint**: macOS physical footprint of that pid from `top`, five readings, median. Never summed RSS. GPU-process footprint is recorded beside it and never added, because it is shared by every view and moves by hundreds of MB between identical runs.
- **Regions**: `vmmap -summary` dirty size per region. Chromium tags PartitionAlloc pages 253 and V8 pages 255.
- **Categories**: a detailed Chromium MemoryInfra dump of that pid (`contentTracing`, `disabled-by-default-memory-infra`). Providers overlap (Blink's caches allocate from PartitionAlloc, which reports through malloc), so they are read side by side and never summed.
- **V8 and Blink**: CDP `Runtime.getHeapUsage`, `Performance.getMetrics`, `Memory.getDOMCounters` and `document.visibilityState`.
- **Heap snapshot**: a separate diagnostic run (`EMPTY_VIEW_HEAP_SNAPSHOTS=1`), because taking a snapshot leaves the renderer larger for the phases after it.

## Where an empty view's memory goes

The baseline arm is `develop` at `d81e81ac1a`. Footprint across the three runs was 165 to 167 MB, median 166 MB.

| Category (MemoryInfra) | MB | What it is |
| --- | --: | --- |
| `malloc` (PartitionAlloc-Everywhere) | 75.5 | Blink and Chromium native allocations, including the Blink caches below |
| `cc` tile memory | 68.8 | Rasterised tiles; they live in GPU shared images, so they show in the GPU process, not in this footprint |
| `v8` | 47.8 | The JS heap, 43.5 MB used |
| `partition_alloc` buffer partition | 42.3 | Strings and buffers, chiefly script source |
| `web_cache` (script resources) | 31.8 | Blink's memory cache holding the source of every script the view loaded |
| `blink_gc` | 13.2 | Oilpan: DOM and other Blink objects (1,169 nodes, 477 listeners) |
| Images, fonts, canvas, Skia | < 1.5 | Negligible in an empty view |

The JS heap is a quarter of the footprint. The rest is native: Blink's copies of script source, its caches, and Oilpan.

Heap snapshot of the empty view, after both cuts:

| V8 node type                                              |   MB |
| --------------------------------------------------------- | ---: |
| Compiled code (bytecode, feedback, function metadata)     | 21.7 |
| External string data (script source V8 shares with Blink) |  8.9 |
| Objects                                                   |  5.2 |
| Arrays                                                    |  5.1 |
| Closures                                                  |  4.4 |
| Strings                                                   |  3.2 |

Compiled code is the largest single V8 item. No application object type reaches 1 MB of self size; the largest named groups are plain `Object` (2.5 MB over 94k instances) and bound functions (1.1 MB over 47k). The heap is many small things built by eager code, not one large retained structure.

## Cuts

**1. Renderer chunks are emitted as ASCII.** One character above U+00FF makes Blink decode a whole script as UTF-16, and V8 compiles from that two-byte source. Em dashes and ellipses in UI copy put 15.7M of the bundle's 21.2M characters into such chunks, including `App` (1.86M characters, 410 of them above U+00FF). The Vite build now re-prints those chunks with non-ASCII escaped (`scripts/lib/ascii-only-chunks.mjs`). This uses Rolldown 1.2's Oxc printer with compress and mangle off, because the Rolldown inside Vite 8.0 predates `codegen.asciiOnly`. Tagged template quasis stay as written, since a tag can read `raw`. Runtime strings are unchanged. Eager first-render JS goes from 6,399,027 to 6,403,448 raw bytes, and gzip is flat.

**2. A cached view drops Blink's memory cache.** Nothing re-reads it: loaded modules live in the module map, and live images and fonts are held by their elements. Preload calls `webFrame.clearCache()` 2 s after `app:view-cached`, and skips it if the view is active again by then: the call also raises critical memory pressure in that renderer, which a view coming back to the front should not pay. The saving carries over when the view comes back to the front, because nothing refills the cache.

| Renderer footprint, median of 3 | develop | + ASCII | + cache clear |
| ------------------------------- | ------: | ------: | ------------: |
| Empty                           |  166 MB |  157 MB |        158 MB |
| Cached                          |  183 MB |  174 MB |    **138 MB** |
| After session                   |  167 MB |  160 MB |    **139 MB** |

The ranges do not overlap. Empty went from 165 to 167 MB down to 156 to 159 MB, and cached from 179 to 187 MB down to 136 to 139 MB. The cached drop is in the categories the cuts address: `web_cache` −32.5 MB, `partition_alloc` −24.1 MB and V8 −6 MB. GPU-process footprint did not move outside its usual spread.

## Not cut here

- **Cached views may keep their tiles.** Under this harness a cached view reports `document.visibilityState === "visible"` and holds 99.8 MB of `cc` tile memory, more than the 68.8 MB it held in front. Calling `setVisible(false)` before `removeChildView` instead of after changed nothing. Playwright enables focus emulation on every page it attaches to, though, and that keeps a page visible, so this reading may be the harness rather than the shipped app. If the app behaves the same, Chromium never learns a cached view is hidden, its tile manager keeps a foreground budget, and the GPU process carries about 100 MB per cached view. Confirming that outside Playwright comes first: #14237.
- **Compile hints trade idle memory for boot time.** `//# allFunctionsCalledOnLoad` on the boot chunks compiles every function in them up front. Without the hints, the empty view measured 144 MB against 157 MB in the same build, with 16.1 MB of compiled code against 21.7 MB. After a session the two converge (17.7 MB against 18.6 MB), because used functions get compiled anyway. The cost lands on views that sit idle. Whether that is worth the boot-time gain needs a boot-latency measurement beside it, so it is tracked in #14238.
- **Eager code.** The first-render closure is 6.4 MB raw, against 4.48 MB in the checked-in baseline, which has not been regenerated since the boot payload changed. Its largest parts are the 1.87 MB `App` chunk (the action definitions alone are about 700 KB of source) and `vendor-xterm` (362 KB), which an empty view never uses. Moving either behind first use is a structural change, so it is tracked in #14239.
