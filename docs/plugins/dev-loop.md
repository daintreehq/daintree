# Development Loop

The `daintree-plugin` CLI provides the plugin author's tooling. Install it as a dev dependency or use `npx`.

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
- `package.json` — npm dev deps (`@daintreehq/plugin-sdk`, `@daintreehq/plugin-vite`, Vite, TypeScript)
- `vite.config.ts` — pre-configured for plugin builds
- `tsconfig.json`
- `src/` — starter code based on template choice
- `.gitignore` — excludes `dist/`, `.dntr` files, `node_modules/`

Templates:

- **`command`** — single command plugin with a filesystem-bound handler
- **`view`** — panel view + React component
- **`mcp`** — skeleton MCP server plus manifest wiring
- **`full`** — command + view + MCP example (largest, for experimenting)

### `daintree-plugin dev`

Starts the hot-reload dev loop.

```bash
cd my-plugin
npx daintree-plugin dev
```

What happens:

1. Symlinks the plugin directory into `~/.daintree/plugins/{pluginId}` so Daintree can discover it.
2. Writes a marker file to the plugin directory so Daintree knows it's a dev plugin (different from a sideloaded prod plugin).
3. Starts Vite in watch mode with the plugin-author Vite config.
4. Opens a local WebSocket server.
5. Waits for a running Daintree instance to connect.

When Daintree starts (or is already running) and has a matching dev marker, it connects to the WebSocket. On every successful Vite rebuild:

1. The CLI sends a `reload` message with the new bundle hash.
2. Daintree calls `unloadPlugin({pluginId})` — cleaning up all registered handlers, panels, MCP subprocesses, etc.
3. Daintree re-imports the plugin entry with a cache-busting query parameter.
4. Daintree calls `activate` again.

**State preservation:** plugins don't preserve state across reloads. This is intentional — state reuse is the main source of "plugin works on first load but not on reload" bugs in other IDEs. If you need persistent state, use `host.settings` or a local file; don't stash it in module-scope variables.

**Error surfacing:** if the plugin throws during activate or render, Daintree shows an inline error boundary with the stack trace and a Reload button. The rest of Daintree continues to work.

**Dev vs prod detection:** dev plugins are visually marked in Daintree (a "DEV" badge on the plugin entry in Preferences). Users can tell at a glance which of their installed plugins are pinned to a local dev folder.

### `daintree-plugin validate`

Runs the manifest through Daintree's Zod schema and reports any errors.

```bash
npx daintree-plugin validate
```

Example output:

```
✓ plugin.json is valid
⚠  engines.daintree omitted — consider adding ^0.8.0
⚠  commands[0].keywords is empty — helps discoverability to add 2–3 terms
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

These appear in the main-process terminal (the one running `npm run dev` for Daintree) and in `~/.daintree/logs/main.log`.

Plugin code's own `console.log`s go to the main-process terminal for code running in main, and the renderer DevTools console for code running in panel views.

### DevTools

- **Main process:** attach with `--inspect-brk` flag on Daintree. Use Chrome DevTools at `chrome://inspect`.
- **Renderer:** open Daintree's DevTools with Cmd+Opt+I (macOS) or Ctrl+Shift+I (Windows/Linux). Your panel view shows up in the Sources panel under `daintree-plugin:{pluginId}/...`.
- **MCP subprocess:** the spawn command can be prefixed with `node --inspect` (or Python's `debugpy`, etc.) and you attach however you normally would for that runtime.

### Common issues

**Plugin loads but commands don't appear in palette**

Check:

- `plugin.json` is at the plugin directory root (not inside a subfolder)
- Command `name` fields are unique within the plugin
- No typos in `contributes.commands` (the `s` is easy to drop)
- Dev symlink in `~/.daintree/plugins/` points to the current working directory

**Command runs but handler doesn't execute**

Check:

- Handler file exists at `src/{name}.{ts,tsx}` (filesystem convention) OR
- `activate()` called `host.registerAction({id: "{name}"}, handler)` (imperative)
- No import errors in the handler file (these show up as toasts on command invocation)

**Plugin fails to activate with timeout**

Default timeout is 5 seconds. Causes:

- Heavy sync work in `activate()` (move it into command handlers)
- Awaiting a network call that's hanging (always add a timeout)
- Importing a large module at the top of the main entry (import it inside command handlers that use it)

**Hot reload doesn't trigger**

- Vite might not be detecting the change (check `vite.config.ts`)
- Daintree doesn't have an open WebSocket connection (check the `daintree-plugin dev` output — it should say "Connected to Daintree")
- A previous `activate()` threw and left the plugin in a broken state. Restart Daintree.

**MCP server doesn't spawn**

- Check the `command` and `args` — run them manually from the plugin directory
- Verify `env` values resolve correctly (use `daintree-plugin validate --env`)
- Look for `[MCPSupervisor]` log lines in Daintree's main-process terminal

## Testing

Use `@daintreehq/plugin-testing` for unit tests.

```ts
// src/plan-from-issue.test.ts
import { describe, it, expect } from "vitest";
import { createMockHost } from "@daintreehq/plugin-testing";
import planFromIssue from "./plan-from-issue";

describe("plan-from-issue", () => {
  it("creates a worktree for the issue", async () => {
    const host = createMockHost({
      worktrees: [{ id: "wt1", name: "main", isCurrent: true }],
    });
    await planFromIssue({ args: { issueId: "LIN-1" }, host, dispatch: host.dispatch });
    expect(host.dispatchedActions).toContainEqual(
      expect.objectContaining({ id: "worktree.create" })
    );
  });
});
```

The mock host implements the full `PluginHostApi` surface with in-memory state. Good for covering command handler logic without spinning up an Electron instance.

For E2E tests that exercise Daintree integration, use `@daintreehq/plugin-testing/electron` which boots a headless Daintree via Playwright. Slower but verifies the full plugin lifecycle including contribution registration.

## Publishing to npm (optional)

If you publish `@daintreehq/plugin-sdk`-dependent utilities or shared code as npm packages (not the plugin itself, just shared modules), standard npm publish applies. Daintree itself doesn't install plugins via npm — `.dntr` files are the distribution format — but nothing stops you from pulling helper libraries from npm during plugin build.

## CI integration

Recommended CI setup for plugins published to GitHub Releases:

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
