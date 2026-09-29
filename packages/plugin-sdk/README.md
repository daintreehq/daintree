# @daintreehq/plugin-sdk

The public surface for Daintree plugins: the manifest and host API types your `activate()` is written against, the React hooks a panel view uses to talk to its plugin, the headless file-listing model Daintree's own file browser runs on, and an in-memory mock host for unit tests.

```bash
npm install --save-dev @daintreehq/plugin-sdk
```

`zod` is a peer dependency (for typed `registerHandler` channel schemas); `react` is an optional peer, needed only for the `./react` entry.

## Entry points

| Import | What it gives you |
| --- | --- |
| `@daintreehq/plugin-sdk` | Types: `PluginHostApi`, `PluginManifest`, `PanelViewProps`, the forge and file-decoration provider contracts, and the handful of runtime constants (`PLUGIN_PROCESS_STREAM_CHANNEL`, `PLUGIN_STYLE_ROOT_ATTRIBUTE`, `localAuthStubs`) |
| `@daintreehq/plugin-sdk/react` | `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent`, `loadDocumentPackage`, `createViewScope` (listeners, timers, observers, workers and WebGL contexts released with the view) and the performance hooks below, for views bundled with `@daintreehq/plugin-vite` |
| `@daintreehq/plugin-sdk/files` | The pure file-tree model — lazy children, expansion, flattening to rows, git-status roll-up, filename classification — fed from `host.fs.readdir(dir, { detail: true })` |
| `@daintreehq/plugin-sdk/data` | Helpers for data kept as files: `parseFrontmatter`, `stringifyFrontmatter` and `updateFrontmatter` (changes only the named keys, every other byte preserved), `parseJsonl` / `stringifyJsonlLine`, `contentRevision`, and `editFile` — the conflict-checked read → transform → `host.fs.writeFile({ expectedRevision })` loop with retry |
| `@daintreehq/plugin-sdk/testing` | `createMockHost`, a recording `PluginHostApi` for exercising `activate()` and handlers without Electron |
| `@daintreehq/plugin-sdk/plugin-ui` | Types only: declares the host-served `@daintreehq/plugin-ui` module (`Markdown`). Add it to `compilerOptions.types`; the runtime always comes from the running app |

A plugin worker that is not bundled — a hand-written `dist/index.mjs` with no `node_modules` — can still import `@daintreehq/plugin-sdk`, `/files` and `/data`: Daintree resolves them to a copy of this package that ships with the app whenever the plugin has no copy of its own. An installed or bundled copy always takes precedence. `/react` and `/testing` are not served that way.

`./data` is newer than the 0.1.0 release on npm. Code you bundle against 0.1.0 cannot import it; build against this repository's package or a later release.

### Performance hooks

The patterns behind Daintree's own fast panels, packaged so the fast way is the easy way in a plugin view. All are dependency-free and take `react` from the view's bundle.

| Hook | Use it when |
| --- | --- |
| `lazyWithPreload(load, pick?)` + `usePreloadOnIntent(Component)` | A dialog, tab or heavy editor is split into its own chunk. Preload it on hover or focus and it renders in the first frame instead of flashing a Suspense fallback for 300ms. |
| `useProgressiveList(items, { initial, step, resetKey, minIndex })` | A list of up to a few hundred rows: the first screenful paints at once, the rest arrives in transitions that never block input. |
| `useVirtualList({ count, estimateSize, overscan, getScrollElement })` | Thousands of rows: only the rows in view are mounted. Heights are fixed or known per index; they are not measured from the DOM. |
| `usePluginEventSelector(pluginId, channel, selector, { initial, isEqual, panelId })` | A channel pushes a large snapshot and this component shows one part of it. It re-renders only when `selector(payload)` changes. `useHostStore(subscribe, getSnapshot, selector, isEqual)` is the same idea for any store, and `shallowEqual` pairs with selectors that build objects. |
| `useCachedHostChannel(pluginId, channel, args, { staleMs, cacheKey, signal, enabled })` | A read the view repeats on every open. The cached result paints first and is revalidated in the background; concurrent mounts share one request, and the cache is bounded (least recently used entries beyond 50 are dropped). |
| `useThrottledCallback(callback, { ms })` | Pushes arrive faster than a frame (progress, streamed lines). Wrap the state setter so React commits at most once per frame, or once per `ms`. |

## Usage

```ts
// src/index.ts
import type { PluginHostApi } from "@daintreehq/plugin-sdk";

export async function activate(host: PluginHostApi): Promise<() => void> {
  host.registerAction(
    {
      id: "say-hello",
      title: "Say Hello",
      description: "Show a greeting.",
      category: "Demo",
      kind: "command",
      danger: "safe",
    },
    async () => host.showToast({ message: "Hello from my plugin", type: "success" })
  );
  return () => {};
}
```

```ts
// src/index.test.ts
import { createMockHost } from "@daintreehq/plugin-sdk/testing";
import { activate } from "./index";

const host = createMockHost({ pluginId: "acme.demo" });
await activate(host);
expect(host.registeredActions).toHaveLength(1);
```

The mock validates argument shapes the way the real host does and records what the plugin called; it does not model processes, filesystem containment, git, or the manifest gates. The host API reference lists exactly what it leaves out.

### Migrating: `simulateFsWatch` now matches paths

`host.simulateFsWatch(changedPath)` used to call every registered `fs.watch` callback regardless of the paths it watched. It now calls only the watchers that would see that change: a watcher sees its watched path itself and that path's direct children, and one registered with `{ recursive: true }` sees anything beneath it. A watcher registered with `debounceMs` receives one trailing callback after the delay, so drive it with fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTime`).

A test that simulated a path outside what the plugin watched — `watch(["/a"])` then `simulateFsWatch("/changed")` — no longer fires. Simulate a path under the watched directory instead, or pass `{ recursive: true }` if the plugin really watches a tree.

## Documentation

The full plugin documentation — manifest reference, host API, contribution points, views, and the development loop — lives at [docs/plugins](https://github.com/daintreehq/daintree/tree/develop/docs/plugins).
