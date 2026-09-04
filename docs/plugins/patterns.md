# Patterns

The reference pages document each host call on its own. This page is how they compose into a plugin that does something: the eight shapes a real project plugin is built from, each with the exact calls. The worked example throughout is a "Videos" dashboard, the first real project plugin built against this system, which uses every one of them. Read the [agent brief](./agent-brief.md) first; the rules there decide whether any of this loads.

Throughout, `host` is the object `activate()` receives in the worker, and "the view" is the React component the renderer mounts. The two talk over channels; nothing else crosses the boundary.

## Pull on mount, then push

The base shape. The view asks for the current state when it mounts, then subscribes for updates. Pushes are not buffered, so a plugin that only pushes will lose everything sent before the view existed.

```js
// worker (dist/index.mjs)
export async function activate(host) {
  let slate = await scanVideos(host); // whatever "current state" means for you

  await host.registerHandler("slate", async () => slate); // the pull

  const refresh = async () => {
    slate = await scanVideos(host);
    await host.postToPanel("slate", slate); // the push, to every open instance
  };
  const timer = setInterval(() => void refresh(), 15_000);
  return () => clearInterval(timer);
}
```

```js
// view (dist/panel.js)
useEffect(() => {
  let live = true;
  void window.electron.plugin.invoke(pluginId, "slate").then((s) => live && setSlate(s));
  const off = window.electron.plugin.on(pluginId, "slate", setSlate);
  return () => {
    live = false;
    off();
  };
}, [pluginId]);
```

Handlers receive `(ctx, ...args)`: the IPC context first, then whatever the view passed to `invoke`. A handler that takes no arguments can ignore both, which is why the bug in an argument-taking one hides behind the ones that work.

## Per-instance pushes

Two open instances of the same panel kind both receive a broadcast. When each instance shows something different (a reader panel per file, say), target the push with the instance's `panelId` and subscribe with `onPanel`:

```js
// worker: the view told us its panelId in the request
await host.registerHandler("open-reader", async (_ctx, { panelId, path }) => {
  const text = await host.fs.readFile(path);
  await host.postToPanel("document", { path, text }, panelId);
});
```

```js
// view
const off = window.electron.plugin.onPanel(pluginId, "document", panelId, setDocument);
```

Broadcast and targeted pushes are disjoint: `on` never receives a targeted push and `onPanel` never receives a broadcast. Subscribe to both if a view needs both.

## Watch a folder, refresh, badge the tab

`host.fs.watch` is a plain `fs.watch`: non-recursive, best-effort, one callback per changed path. Treat a callback as an invalidation hint that prompts a re-read of the thing that changed, never as an event log, and watch the directories you care about explicitly rather than assuming a tree.

```js
const dispose = await host.fs.watch([`${projectRoot}/videos`], (changedPath) => {
  void refreshOne(changedPath); // re-read only what changed, then postToPanel
});

// Surface state on the tab without the panel being open. Badges are keyed by
// (pluginId, panelId) and cleared on unload; pass null to clear one yourself.
await host.setPanelBadge(panelId, { kind: "dot", color: "warning", tooltip: "2 gate errors" });
```

Watchers and badges are both released on unload; `dispose()` the watcher yourself when the panel that needed it is removed (`onDidChangePanelLifecycle`, phase `removed`).

## Open files the Daintree way

Don't build a markdown renderer or an audio player before checking what `host.dispatch` already reaches. All of these are `danger: "safe"` and take a `path` (absolute, or relative to `rootPath` / the project root):

| Action | Args | What it does |
| --- | --- | --- |
| `file.openPanel` | `{ path, rootPath?, viewMode? }` | A persistent read-only panel in the grid. `viewMode: "rendered"` for Markdown and HTML. Audio, video and images get Daintree's own previews. Reuses an open panel for the same file |
| `file.view` | `{ path, rootPath?, line? }` | An ephemeral viewer dialog, never restored on restart |
| `file.openInEditor` | `{ path, line?, col? }` | The user's configured editor |
| `file.openInBrowser` | `{ path }` | The OS default handler for that file type, despite the name; for an `.html` deck that may be an editor rather than a browser |
| `file.showItemInFolder` | `{ path }` | Reveal in Finder / Explorer |
| `worktree.openFileBrowserPanel` | `{ revealPath?, revealKind?: "file" \| "directory", surface?: "grid" \| "dock" }` | Daintree's file browser, opened at your folder |
| `system.openExternal` | `{ url }` | A URL in the default browser |

```js
await host.dispatch("file.openPanel", {
  path: `${videoDir}/final/teleprompter.md`,
  viewMode: "rendered",
});
await host.dispatch("file.openPanel", { path: `${videoDir}/final/teleprompter.mp3` }); // audio preview
```

Check a result: `dispatch` resolves `{ ok: false, error: { code } }` rather than throwing, and `host.actions.canDispatch(id)` tells you in advance whether an action will confirm.

## Launch an agent with a prompt

A plugin can put a button on a piece of work that opens an agent in the right folder with the right first message. `agent.launch` is a safe-tier action:

```js
await host.dispatch("agent.launch", {
  agentId: "claude",
  cwd: videoDir, // the launch directory, not a worktree selector
  prompt: `Write the script for ${title} from 02-outline.md, following CLAUDE.md.`,
  interactive: true, // a conversation the user can continue, rather than one pass
});
```

Once loaded, your own commands are also actions, and the action manifest is the MCP tool surface, so an agent running in the project can call them back. A plugin's commands are its agent-facing API for free.

## Run a command

For a long-lived process (a dev server, a watcher), `host.process.spawn` is the supervised path: it needs the `shell:exec` capability, raises a one-time consent dialog on first use, streams output to your views on the `process` channel keyed by handle id, and is killed with the plugin.

```js
const handle = await host.process.spawn("npm", { args: ["run", "dev"], cwd: projectRoot });
handle.onCrash(() => host.showToast({ message: "Dev server crashed", type: "error" }));
```

For a server that speaks JSON-RPC over stdio, `mode: "duplex"` gives you a writable stdin and separate stdout; see [Host API → Modes](./host-api.md#modes).

One honest caveat for a one-shot command whose final output is the result (a linter, a script that prints JSON): the handle settles on the child's `exit`, so output still in flight can be lost. Until #12216 adds `host.process.exec()`, run those through `node:child_process.execFile` in your worker and declare `shell:exec` anyway, so the capability is disclosed even though the managed path (and its consent prompt) is bypassed.

## Own the canvas, live in the dock

A project plugin can replace what the grid shows when no panels are open, so the project presents as a purpose-built app:

```jsonc
"surfaces": { "emptyCanvas": { "viewId": "main" } }
```

That surface is visible only while the grid is empty. The moment a terminal opens it gives way, and the frame's corner button swaps between your surface and the stock launcher. For a navigation that stays put, the same panel kind is dockable by default; a docked instance survives everything the grid does. Give the user both: the canvas for the cold open, the dock for the working session. Details under [Surfaces](./project-local.md#surfaces).

## Open your own panel from a command

`panel.openPluginPanel` spawns or focuses one of your panel kinds and hands the view an argument bag as `initialArgs`, which is also where `persistState` writes back, so a panel reopens the way it was left:

```js
await host.registerAction(
  {
    id: "open-for-file",
    title: "Show in Video Manager",
    description: "…",
    category: "Videos",
    kind: "command",
    danger: "safe",
    requires: [],
  },
  async ({ path }) => {
    await host.dispatch("panel.openPluginPanel", { kind: panelKindId, initialArgs: { path } });
  }
);
```

`kind` is the registered kind id. For a project plugin that is `project:{projectId}/{manifestId}/{kindId}`, and until #12211 adds `host.pluginInfo()` the parts have to come from `host.pluginId` (the instance key `project__{projectId}__{manifestId}`). A `contextMenus` entry at `location: "file"` dispatches your command with `{ path, worktreePath, status }`, which is how "Show in Video Manager" appears on every file row.

## Keep commands one click

Declaring `shell:exec` raises every command the plugin registers to a confirm dialog. Narrow it per command with `requires`: `"requires": []` on the ones that only open a panel, the real list on the ones that run something. Give each command two or three `keywords` and a shared `category` so the palette groups them.

## What survives what

| State | Remount (maximise a sibling, leave a dock tab) | Hot reload (`dist/` rebuilt) | Project close |
| --- | --- | --- | --- |
| React state in the view | lost | lost | lost |
| Module-scope state in the worker | kept | lost | lost |
| `persistState` bag on the panel | kept | kept | kept with the layout |
| `host.storage`, `host.settings` | kept | kept | kept |
| Spawned processes, watchers, badges | kept | killed and cleared | killed and cleared |

Design for the middle column. A reload is a fresh worker and a fresh view generation; anything the user would be annoyed to lose belongs in `persistState` or `host.storage`.
