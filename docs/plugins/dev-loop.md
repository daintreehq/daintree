# Development Loop

The `daintree-plugin` CLI provides the plugin author's tooling. Install it as a dev dependency or use `npx`.

> `daintree-plugin` is not yet published on npm — the `npm install --save-dev daintree-plugin` and `npx daintree-plugin` commands below return E404 today. The CLI is tracked for publication; until it ships, build plugins by hand (see [Getting started](./getting-started.md)) and sideload them manually (see [Distribution → Sideload](./distribution.md#sideload)).

```bash
npm install --save-dev daintree-plugin
# or
npx daintree-plugin <command>
```

## Commands

### `daintree-plugin new <name>`

Scaffolds a new plugin project. Interactive — prompts for publisher, display name, template.

```bash
npx daintree-plugin new my-plugin
```

Creates `./my-plugin/` with:

- `plugin.json` — starter manifest
- `package.json` — npm dev deps (`@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite`, Vite, TypeScript). Note: `@daintreehq/plugin-sdk` and `@daintreehq/plugin-vite` are not yet published, so `npm install` against this generated `package.json` will fail today — see the caveat at the top of this page.
- `vite.config.ts` — pre-configured for plugin builds
- `tsconfig.json`
- `src/` — starter code based on template choice
- `.gitignore` — excludes `dist/`, `.dntr` files, `node_modules/`

Templates:

- **`command`** — single command plugin. `src/index.ts` exports `activate(host)` and registers the command imperatively via `host.registerAction(...)`. (The filesystem-convention handler — `src/{id}.ts` auto-bound on first dispatch — is also supported by the host; the scaffold just shows the imperative path.)
- **`view`** — panel view + React component (`src/index.ts` + `src/panel.tsx`)
- **`mcp`** — skeleton MCP server plus manifest wiring (`src/index.ts` + `src/server.ts`)
- **`full`** — command + view + MCP example (largest, for experimenting)

### The edit loop (today)

There's no hot reload yet. The loop below still depends on the unpublished `daintree-plugin` CLI (see the caveat at the top of this page); until it ships, package and install by hand following [Distribution → Sideload](./distribution.md#sideload). The intended manual loop once the CLI is available:

```bash
cd my-plugin
# edit src/...
npx daintree-plugin package
npx daintree-plugin install ./my-plugin-0.1.0.dntr
```

Each `install` replaces the previously installed copy. Daintree unloads the old version — cleaning up all registered handlers, panels, and MCP subprocesses — before loading the new one, so you don't accumulate stale registrations between iterations.

**State preservation:** reinstalling does not preserve plugin state. If you need persistence across iterations, use `host.settings` or a local file; don't stash it in module-scope variables.

**Error surfacing:** if the plugin throws during activate or render, Daintree shows an inline error boundary with the stack trace. The rest of Daintree continues to work.

### `daintree-plugin dev` (planned, F32b)

> Not available yet. Invoking `daintree-plugin dev` currently exits with an error. The hot-reload loop described here is planned for a later release (F32b); until then use the manual edit → package → install loop above.

Once shipped, `dev` will start a hot-reload loop:

1. Symlink the plugin directory into `~/.daintree/plugins/{pluginId}` so Daintree can discover it.
2. Write a marker file so Daintree knows it's a dev plugin (different from a sideloaded prod plugin).
3. Start Vite in watch mode with the plugin-author Vite config.
4. Open a local WebSocket server and wait for a running Daintree instance to connect.

On every successful Vite rebuild Daintree will call `unloadPlugin({pluginId})`, re-import the plugin entry with a cache-busting query parameter, and call `activate` again. Dev plugins will carry a "DEV" badge on the plugin entry in Preferences so you can tell at a glance which installed plugins are pinned to a local dev folder.

### `daintree-plugin validate`

Runs the manifest through Daintree's Zod schema and reports any errors.

```bash
npx daintree-plugin validate
```

Example output:

```
✓ plugin.json is valid
⚠  engines.daintree omitted — consider pinning a range, e.g. ^0.11.0
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
npx daintree-plugin uninstall acme.linear-planner
```

Equivalent to Preferences → Plugins → Uninstall.

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
- **Renderer:** open Daintree's DevTools with Cmd+Opt+I (macOS) or Ctrl+Shift+I (Windows/Linux). Your panel view shows up in the Sources panel under `daintree-plugin:{pluginId}/...`.
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

- Handler file exists at `src/{id}.{ts,tsx,js,mjs}` (filesystem convention) OR
- `activate()` called `host.registerAction({id: "{id}"}, handler)` (imperative)
- No import errors in the handler file (these show up as toasts on command invocation)

**Plugin fails to activate with timeout**

Default timeout is 5 seconds. Causes:

- Heavy sync work in `activate()` (move it into command handlers)
- Awaiting a network call that's hanging (always add a timeout)
- Importing a large module at the top of the main entry (import it inside command handlers that use it)

**Changes don't show up after editing**

There's no hot reload yet (see [The edit loop](#the-edit-loop-today)). Re-run `package` then `install` to load the new build.

- A stale `.dntr` got installed — confirm you packaged after your edit, and that the path you installed matches the freshly built file
- A previous `activate()` threw and left the plugin in a broken state. Restart Daintree.

**MCP server doesn't spawn**

- Check the `command` and `args` — run them manually from the plugin directory
- Verify `env` values resolve correctly (use `daintree-plugin validate --env`)
- Look for `[PluginService]` (lifecycle) and MCP-specific prefixes like `[PluginMcpAudit]` / `[PluginMcpConsentService]` in Daintree's main-process terminal — supervision lives in `electron/services/PluginMcpSupervisor.ts`

## Testing

> The standalone `@daintreehq/plugin-testing` package is not yet published (see [Status](./README.md)). The mock host it will eventually ship currently lives in-repo at `shared/testing/createMockHost.ts`; import it via a relative path for now. The example below mirrors `plugins/sample/hello-daintree/__tests__/activate.test.ts`.

```ts
// src/plan-from-issue.test.ts
import { describe, it, expect } from "vitest";
import { createMockHost } from "../../shared/testing/createMockHost"; // pending @daintreehq/plugin-testing
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

`createMockHost` implements the `PluginHostApi` surface with in-memory state and records dispatched actions as `{ actionId, args }` on `host.dispatchedActions` (see the `DispatchedActionRecord` type in `shared/testing/createMockHost.ts`). Good for covering command handler logic without spinning up an Electron instance.

A headless-Daintree Playwright harness for full-lifecycle E2E (contribution registration, MCP spawn) is planned but does not exist yet — there's no `@daintreehq/plugin-testing/electron` entry point today.

## Publishing to npm (optional)

If you publish `@daintreehq/plugin-sdk`-dependent utilities or shared code as npm packages (not the plugin itself, just shared modules), standard npm publish applies. Daintree itself doesn't install plugins via npm — `.dntr` files are the distribution format — but nothing stops you from pulling helper libraries from npm during plugin build.

## CI integration

Recommended CI setup for plugins published to GitHub Releases:

> The `daintree-plugin` commands in this workflow are not yet published on npm and will return E404 today. This YAML shows the intended setup once the CLI ships.

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
