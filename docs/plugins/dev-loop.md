# Development Loop

The `daintree-plugin` CLI provides the plugin author's tooling. Install it as a dev dependency or use `npx`.

> `daintree-plugin` is not yet published on npm — the `npm install --save-dev daintree-plugin` and `npx daintree-plugin` commands below return E404 today. The CLI lives in-repo at `packages/daintree-plugin` and the publish pipeline exists (`.github/workflows/release-packages.yml`, fired by a `daintree-plugin-v*` tag), so this is waiting on a release rather than on the tooling. Until it ships: run the CLI from a Daintree checkout (`npm run -w daintree-plugin …`), or build plugins by hand (see [Getting started](./getting-started.md)) and sideload them manually (see [Distribution → Sideload](./distribution.md#sideload)).

```bash
npm install --save-dev daintree-plugin
# or
npx daintree-plugin <command>
```

## Commands

### `daintree-plugin new <name>`

Scaffolds a new plugin project. Interactive — prompts for publisher, display name, template.

```bash
npx daintree-plugin new my-plugin [--publisher acme] [--template command|view|mcp|full] [--project] [--yes]
```

Every prompt has a flag, so the whole thing runs unattended: `--yes` skips the prompts and accepts defaults, and requires both a positional name and `--publisher`. That is the form to use from CI or from an agent.

Creates `./my-plugin/` with:

- `plugin.json` — starter manifest
- `package.json` — npm dev deps (`@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite`, Vite, TypeScript). Note: `@daintreehq/plugin-sdk` and `@daintreehq/plugin-vite` are not yet published, so `npm install` against this generated `package.json` will fail today — see the caveat at the top of this page.
- `vite.config.ts` — pre-configured for plugin builds
- `tsconfig.json`
- `src/` — starter code based on template choice
- `.gitignore` — excludes `dist/`, `.dntr` files, `node_modules/`

Templates:

- **`command`** — single command plugin. `src/index.ts` exports `activate(host)` and registers the command imperatively via `host.registerAction(...)`. (The filesystem-convention handler — compiled `src/{id}.js` auto-bound on first dispatch — is also supported by the host; the scaffold just shows the imperative path.)
- **`view`** — panel view + React component (`src/index.ts` + `src/panel.tsx`)
- **`mcp`** — skeleton MCP server plus manifest wiring (`src/index.ts` + `src/server.ts`)
- **`full`** — command + view + MCP example (largest, for experimenting)

#### `--project` — scaffold into a project

`daintree-plugin new <name> --project` scaffolds a **project-local** plugin: one that lives in a project's own repository and loads only while that project is open in Daintree, instead of being installed app-wide. The name is still the positional argument; `--project` only changes where the scaffold lands and what it emits.

The project root is the nearest ancestor of the current directory holding a `.daintree/` or `.git`. Outside one, the command fails rather than guessing a directory. The plugin is written to `<projectRoot>/.daintree/plugins/<publisher.name>/` — the directory is named after the manifest `name`, which is what discovery looks for.

Alongside the usual template files it emits:

- `plugin.json` with `"scope": "project"`
- a `dev` script running `vite build --watch` (plus `dev:server` for the `mcp` and `full` templates, since one `vite build` runs one config at a time)
- `vite.config.ts` with **inline** source maps and absolute `sources`, so DevTools breakpoints land in the real `.tsx` without a sidecar `.map` having to be served over `plugin://`
- a watcher recipe in `<projectRoot>/.daintree/recipes/`, so Daintree can bring the build up with the rest of the project environment
- a `.gitignore` that force-includes `dist/`, and a `README.md` explaining why
- no `.dntrignore` and no `package` script — a project plugin is distributed by being committed, not as a `.dntr`

**`dist/` is the load contract.** Daintree reads `plugin.json` and `dist/`. It never compiles a project plugin, never reads `src/`, and never runs its `package.json` — a project opening must not run a build. So `dist/` is committed, and the generated `.gitignore` force-includes it with `!dist/` and `!dist/**`: most repositories ignore `dist/` at the root, and that pattern would otherwise swallow the plugin's build output, leaving a plugin that silently fails to load on every other checkout. Both negations are needed — `!dist/` re-includes the directory so git descends into it at all, `!dist/**` re-includes the files against a parent rule that matches contents (`dist/*`, `**/dist/**`). Rebuild and commit `dist/` in the same commit as the source change.

The one case the generated file cannot fix is a project that ignores `.daintree/` itself: git never descends far enough to read it. Un-ignore `.daintree/plugins/` at the project root instead. `git check-ignore -v .daintree/plugins/<name>/dist/index.js` answers this in one command — no output means the file is tracked.

### The edit loop

For a live hot-reload loop, use [`daintree-plugin dev`](#daintree-plugin-dev) below. The manual package-and-install loop is still available — it's the right choice when you want to exercise the exact production load path, or whenever the CLI isn't on hand (it's unpublished today; see the caveat at the top of this page — package and install by hand following [Distribution → Sideload](./distribution.md#sideload)). The manual loop:

```bash
cd my-plugin
# edit src/...
npx daintree-plugin package
npx daintree-plugin install ./my-plugin-0.1.0.dntr
```

Each `install` replaces the previously installed copy. Daintree unloads the old version — cleaning up all registered handlers, panels, and MCP subprocesses — before loading the new one, so you don't accumulate stale registrations between iterations.

**State preservation:** reinstalling does not preserve plugin state. If you need persistence across iterations, use `host.settings` or a local file; don't stash it in module-scope variables.

**Error surfacing:** if the plugin throws during activate or render, Daintree shows an inline error boundary with the stack trace. The rest of Daintree continues to work.

### The project-local edit loop

A project-local plugin has no package-and-install step and does not use `daintree-plugin dev` — it already sits where the host reads it, so a rebuilt `dist/` is picked up in place:

```bash
cd .daintree/plugins/acme.dashboard
npm install
npm run dev        # vite build --watch, rebuilding dist/ in place
```

The scaffolded recipe in `.daintree/recipes/` starts the same watcher as a project terminal, so the build comes up with the rest of the environment.

Daintree watches `plugin.json` and `dist/` for every trusted project. **`src/` is never watched** — the host doesn't know how your plugin builds, so a source write says nothing about whether a loadable artifact exists yet. Keep the build watcher running; editing `src/` alone reloads nothing.

Three behaviours shape what you see while iterating:

- A **~200 ms trailing debounce**, so a rebuild that writes a whole `dist/` reloads once rather than per file.
- Reloads **defer while `.git/index.lock` exists**, so a branch switch or a pull reconciles against the settled tree rather than a half-applied one.
- A **half-written `plugin.json` keeps the running version.** The re-read is retried with a short backoff; only a manifest still broken afterwards disables the plugin and leaves an `invalid` row in the plugin manager. A plugin directory that has _vanished_ unloads immediately, which is what a branch switch should do.

Reloads are per plugin directory, not per project — rebuilding one plugin doesn't restart its siblings. Your `settings` values and `host.storage` survive a reload; module-scope state in the worker and React state in your views do not, exactly as for an installed plugin.

Full detail, including the trust gate and the contribution restrictions, is in [Project-local plugins](./project-local.md).

### `daintree-plugin dev`

Starts a hot-reload dev loop against a running Daintree instance:

```bash
npx daintree-plugin dev [--skip-build]
```

What it does, in order:

1. Validates the manifest (the same check as `daintree-plugin validate`); a manifest error aborts before anything is linked.
2. Builds the plugin once (`vite build`) so `dist/<main>` exists before Daintree loads it. `--skip-build` skips this initial build — the watcher in step 5 still rebuilds on every save.
3. Symlinks the plugin directory into `~/.daintree/plugins/{pluginId}` and writes a `.dev-marker` file at the link root. The marker's presence is what routes the plugin through Daintree's hot-reload worker instead of the normal in-process load path. (A real directory already at that path is treated as an installed plugin and left untouched.)
4. Asks the running Daintree to load and activate the plugin (the `plugin.dev.start` IPC).
5. Starts `vite build --watch`. Daintree's dev worker watches the plugin's `dist/` directory; on every rebuild it tears the worker down and re-imports the entry, so a save reloads the live plugin. Dev plugins carry a **DEV** badge on their entry in Preferences so you can tell at a glance which installed plugins are pinned to a local dev folder.

Press Ctrl-C (or send SIGTERM) to stop: the watcher is killed, Daintree is asked to unload the plugin (`plugin.dev.stop`), and the `.dev-marker` plus the symlink Daintree-`dev` created are removed. A second Ctrl-C while teardown is in flight exits immediately.

One host method is a no-op for `dev`-loaded plugins: `registerForgeProvider`. Forge providers require synchronous host methods (`parseRemote`, URL builders) that can't cross the worker's async MessagePort boundary, so a `registerForgeProvider` call logs a warning and is skipped. Everything else — including `host.process.spawn` and `host.fs.watch`, whose handles and subscriptions are proxied over the port and survive a reload — works under `dev`. Note this is **not** a dev-only limitation: every user-installed plugin runs in a worker (see [Architecture → Activation](./architecture.md#activation)), so packaging and installing the plugin doesn't restore forge support either. Only Daintree's built-in plugins run in-process and can register forge providers — a known architectural gap, not something a third-party plugin can work around today.

### `daintree-plugin validate`

Runs the manifest through Daintree's Zod schema and reports any errors. It validates under the origin your manifest declares, so a `"scope": "project"` manifest is checked against the project rules.

```bash
npx daintree-plugin validate [--env]
```

`--env` additionally resolves `${settings:…}` tokens against a `.daintree-plugin-env` file, so you can confirm an MCP server's `command` / `args` / `env` substitute the way you expect before spawning it for real.

Example output:

```
✓ plugin.json is valid
⚠  engines.daintree omitted — consider pinning a range, e.g. >=0.11.0
⚠  commands[0].keywords is empty — 2–3 terms help discoverability in the palette
```

Runs automatically as part of `package`.

### `daintree-plugin package`

Produces a distributable `.dntr` file. See [Distribution → Packaging](./distribution.md#packaging).

```bash
npx daintree-plugin package [--verbose] [--dry-run] [--sourcemaps] [--skip-build]
```

### `daintree-plugin install <path-or-url>`

Installs a `.dntr` file or URL into the running Daintree. Same effect as doing it through the UI.

```bash
npx daintree-plugin install ./my-plugin-0.1.0.dntr
npx daintree-plugin install https://github.com/user/plugin/releases/latest/download/plugin.dntr
```

Useful in CI scripts and setup automation.

### `daintree-plugin uninstall <pluginId>`

```bash
npx daintree-plugin uninstall acme.linear-planner [--delete-settings]
```

Equivalent to Preferences → Plugins → Uninstall. User-scope settings are **kept** by default so an API token survives a reinstall; `--delete-settings` removes them. Project-scope settings under a repository's `.daintree/` are never touched either way. TOFU consent pins are always revoked, so a reinstall re-prompts rather than inheriting prior approvals.

## Debugging

### Logs

Daintree logs plugin lifecycle events prefixed with `[PluginService]`:

- Load, activate, activation errors, unload
- IPC handler registrations
- Action registrations
- Worktree subscription state

These appear in the main-process terminal (the one running `npm run dev` for Daintree) and in `daintree.log` inside the app's userData logs directory (in dev: `<cwd>/logs/daintree.log`). See `getLogFilePath()` in `electron/utils/logger.ts` for resolution.

Plugin code's own `console.log`s go to the main-process terminal for code running in main, and the renderer DevTools console for code running in panel views.

### DevTools

- **Main process:** attach with `--inspect-brk` flag on Daintree. Use Chrome DevTools at `chrome://inspect`.
- **Renderer:** open Daintree's DevTools from View → Toggle Developer Tools, or run the Toggle DevTools command from the command palette. Your panel view shows up in the Sources panel under `daintree-plugin:{pluginId}/...`.
- **MCP subprocess:** the spawn command can be prefixed with `node --inspect` (or Python's `debugpy`, etc.) and you attach however you normally would for that runtime.

### Common issues

**Plugin loads but commands don't appear in palette**

Check:

- `plugin.json` is at the plugin directory root (not inside a subfolder)
- Command `id` fields are unique within the plugin
- No typos in `contributes.commands` (the `s` is easy to drop)
- Dev symlink in `~/.daintree/plugins/` points to the current working directory

**Command runs but handler doesn't execute**

Check:

- Compiled handler file exists at `src/{id}.{js,mjs}` (filesystem convention — `.ts`/`.tsx` are not probed; compile to `.js` first) OR
- `activate()` called `host.registerAction({id: "{id}"}, handler)` (imperative)
- No import errors in the handler file (these show up as toasts on command invocation)

**Plugin fails to activate with timeout**

Default timeout is 5 seconds. Causes:

- Heavy sync work in `activate()` (move it into command handlers)
- Awaiting a network call that's hanging (always add a timeout)
- Importing a large module at the top of the main entry (import it inside command handlers that use it)

**Changes don't show up after editing**

Which loop are you in? Under [`daintree-plugin dev`](#daintree-plugin-dev) a save rebuilds and respawns the plugin's **worker**, so `main`-side changes take effect — but the view-module generation does not advance, so an open panel keeps the bundle already in the renderer's ESM cache. Disable/enable the plugin, or reload the window, to pick up view changes mid-session (see [Contribution points → Worker reload vs. view-module replacement](./contribution-points.md#worker-reload-vs-view-module-replacement)). In the manual loop, re-run `package` then `install`; each install mints a fresh generation, so views do refresh.

If neither explains it:

- A stale `.dntr` got installed — confirm you packaged after your edit, and that the path you installed matches the freshly built file
- A previous `activate()` threw partway through. The host rolls back every registration the plugin made before the throw — channels, imperative actions, and event/forge/worktree subscriptions are all undone automatically, so you don't strand stale registrations. Fix the error and re-run `package` then `install`; no Daintree restart is needed.

**MCP server doesn't spawn**

- Check the `command` and `args` — run them manually from the plugin directory
- Verify `env` values resolve correctly (use `daintree-plugin validate --env`)
- Look for `[PluginService]` (lifecycle) and MCP-specific prefixes like `[PluginMcpAudit]` / `[PluginMcpConsentService]` in Daintree's main-process terminal — supervision lives in `electron/services/PluginMcpSupervisor.ts`

## Testing

> `@daintreehq/plugin-testing` (`packages/plugin-testing`) exists and is workspace-linked, but is not yet published to npm (see [Status](./README.md)) — import it by relative path outside the workspace. It re-exports `createMockHost` and its record types from `shared/testing/createMockHost.ts`. The example below mirrors `plugins/sample/hello-daintree/__tests__/activate.test.ts`.

```ts
// src/plan-from-issue.test.ts
import { describe, it, expect } from "vitest";
import { createMockHost } from "@daintreehq/plugin-testing"; // workspace-linked; not yet on npm
import planFromIssue from "./plan-from-issue";

describe("plan-from-issue", () => {
  it("creates a worktree for the issue", async () => {
    const host = createMockHost({ pluginId: "acme.linear-planner" });
    await planFromIssue({ args: { issueId: "LIN-1" }, host, dispatch: host.dispatch });
    expect(host.dispatchedActions).toContainEqual(
      expect.objectContaining({ actionId: "worktree.create" })
    );
  });
});
```

`createMockHost` implements the `PluginHostApi` surface with in-memory state, mirrors the real host's validation and capability gating, and records every call for assertion — dispatched actions land on `host.dispatchedActions` as `{ actionId, args }` (the `DispatchedActionRecord` type), alongside `registeredActions`, `registeredHandlers`, `postToPanelCalls`, `shownToasts`, and the rest. Good for covering handler logic without spinning up an Electron instance. See [Host API → Testing against a mock host](./host-api.md#testing-against-a-mock-host).

### Testing a raw-ESM project plugin

A hand-written project plugin has no build and no SDK import, and the same mock host tests it. Import `createMockHost` by relative path from a Daintree checkout, import your worker entry by file URL, and drive the handlers exactly the way `PluginService` does: context first, payload second. That last part is the point of the test, because it is the convention a first plugin gets wrong.

```ts
// test/worker.test.ts — run from inside the Daintree checkout, or point the
// relative import at yours.
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { createMockHost } from "../../../shared/testing/createMockHost";

const ctx = { projectId: "p1", worktreeId: "w1", webContentsId: 1, pluginId: "acme.dashboard" };

describe("worker", () => {
  it("answers read-file with the file's text", async () => {
    const host = createMockHost({
      pluginId: "acme.dashboard",
      capabilities: ["fs:project-read", "fs:project-write"],
    });
    await host.fs.writeFile("/proj/notes.md", "# hi"); // seeds the in-memory fs

    const { activate } = await import(pathToFileURL("dist/index.mjs").href);
    await activate(host);

    const { handler } = host.registeredHandlers.find((h) => h.channel === "read-file")!;
    await expect(handler(ctx, { path: "/proj/notes.md" })).resolves.toBe("# hi");
  });
});
```

The view mounts under jsdom with the bridge stubbed. `dist/panel.js` bare-imports `react`, which the app resolves through its import map; under vitest it resolves from `node_modules`, so run the test where `react` is installed (the Daintree checkout, or add it as a devDependency of the plugin).

```ts
// test/panel.test.tsx
// @vitest-environment jsdom
import { pathToFileURL } from "node:url";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import { it, expect, vi } from "vitest";

it("renders the worktree name it pulls on mount", async () => {
  (window as unknown as { electron: unknown }).electron = {
    plugin: {
      invoke: vi.fn(async () => ({ name: "feature-x" })),
      on: () => () => {},
      onPanel: () => () => {},
    },
  };
  const { default: Panel } = await import(pathToFileURL("dist/panel.js").href);
  const root = document.createElement("div");
  await act(async () => {
    createRoot(root).render(
      createElement(Panel, {
        panelId: "panel-1",
        pluginId: "acme.dashboard",
        disposeSignal: new AbortController().signal,
      })
    );
  });
  expect(root.textContent).toContain("feature-x");
});
```

A headless-Daintree Playwright harness for full-lifecycle E2E (contribution registration, MCP spawn) is planned but does not exist yet — there's no `@daintreehq/plugin-testing/electron` entry point today.

## Publishing to npm (optional)

If you publish `@daintreehq/plugin-sdk`-dependent utilities or shared code as npm packages (not the plugin itself, just shared modules), standard npm publish applies. Daintree itself doesn't install plugins via npm — `.dntr` files are the distribution format — but nothing stops you from pulling helper libraries from npm during plugin build.

## CI integration

Recommended CI setup for plugins published to GitHub Releases:

> The `daintree-plugin` commands in this workflow are not yet published on npm and will return E404 today. This YAML shows the intended setup once the CLI ships.
>
> (This is a workflow for **your** plugin's repository. Daintree's own package-publishing workflow is `.github/workflows/release-packages.yml`, which is a different thing.)

```yaml
# .github/workflows/release.yml
name: Release plugin
on:
  push:
    tags: ["v*"]
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "22" }
      - run: npm ci
      - run: npx daintree-plugin validate
      - run: npx daintree-plugin package
      - uses: softprops/action-gh-release@v2
        with:
          files: "*.dntr"
```

Tag the release with `v{version}` matching your `plugin.json` version field. Users install from the `releases/latest/download/...` URL.
