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
| `@daintreehq/plugin-sdk/react` | `useHostChannel`, `usePluginEvent`, `usePluginPanelEvent`, `loadDocumentPackage` and `createViewScope` (listeners, timers, observers, workers and WebGL contexts released with the view) for views bundled with `@daintreehq/plugin-vite` |
| `@daintreehq/plugin-sdk/files` | The pure file-tree model — lazy children, expansion, flattening to rows, git-status roll-up, filename classification — fed from `host.fs.readdir(dir, { detail: true })` |
| `@daintreehq/plugin-sdk/testing` | `createMockHost`, a recording `PluginHostApi` for exercising `activate()` and handlers without Electron |

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
