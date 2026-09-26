# Patterns

The reference pages document each host call on its own. This page is how they compose into a plugin that does something: the shapes a real project plugin is built from, each with the exact calls. The worked example throughout is a "Videos" dashboard, the first real project plugin built against this system, which uses every one of them. Read the [agent brief](./agent-brief.md) first; the rules there decide whether any of this loads.

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
  // Polling belongs here, not in the view: the worker is a separate utility
  // process, so it keeps its cadence while the user is in another project.
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

`host.fs.watch` is a plain `fs.watch` by default: non-recursive, best-effort, one callback per changed path. Treat a callback as an invalidation hint that prompts a re-read of the thing that changed, never as an event log. Pass `{ recursive: true }` to watch a whole data tree, including subdirectories created later, and `{ debounceMs }` to collapse an agent's burst of edits into one refresh — but keep a recursive watch to your own data directory rather than a whole worktree (see [`fs` in the host API](./host-api.md#fs--host-mediated-scope-contained-filesystem) for the Linux cost).

```js
const dispose = await host.fs.watch([`${projectRoot}/videos`], (changedPath) => {
  void refreshOne(changedPath); // re-read only what changed, then postToPanel
});

// Surface state on the tab without the panel being open. Badges are keyed by
// (pluginId, panelId) and cleared on unload; pass null to clear one yourself.
await host.setPanelBadge(panelId, { kind: "dot", color: "warning", tooltip: "2 gate errors" });
```

Watchers and badges are both released on unload; `dispose()` the watcher yourself when the panel that needed it is removed (`onDidChangePanelLifecycle`, phase `removed`).

## Refresh when the user comes back

Switching projects leaves your view mounted, its React state intact, and its page visibility unchanged — nothing in the DOM marks the switch. The signal is main's, on `window.electron.app`, and the pull it drives is the one you already wrote for mount.

```js
// view: pull on mount, re-pull when this project is shown again, and keep the
// push subscription from "Pull on mount, then push" — reveal is an extra
// trigger for the same load, not a replacement for it.
useEffect(() => {
  let live = true;
  const load = async () => {
    // `invoke` rejects when the handler throws or the plugin has unloaded.
    const next = await window.electron.plugin.invoke(pluginId, "slate").catch(() => null);
    if (live && next) setSlate(next);
  };
  void load(); // first mount, and the remount after a reclaimed renderer
  const off = window.electron.plugin.on(pluginId, "slate", setSlate);
  const offRevealed = window.electron?.app?.onViewRevealed?.(() => void load());
  return () => {
    live = false;
    off();
    offRevealed?.();
  };
}, [pluginId]);
```

The mount pull is not redundant with the reveal pull: under memory pressure the host destroys a backgrounded project view outright, and the user's next switch back is a cold mount with no reveal to catch. Route both through one function and the two cannot drift.

Periodic work in the view is the other half, and it needs the cache edges rather than the reveal: `onViewRevealed` arrives only for a switch that completes with your project in front. Seed from `isViewCached()` — these are edges, nothing replays, and a mount can land in an already-cached view — and AND it with document visibility, which covers the window being minimised while this project is the active one.

```js
// view: demote while nobody can see this project.
useEffect(() => {
  const app = window.electron?.app;
  // Reconcile rather than start/stop on the edge: the mount itself can land
  // already cached, and the latch is the only thing that can say so.
  const sync = () => {
    const idle = (app?.isViewCached?.() ?? false) || document.hidden;
    if (idle) stopTicking();
    else startTicking();
  };
  sync();
  const offCached = app?.onViewCached?.(sync);
  // Warm activation, not reveal: warm activation is the cached-to-active edge
  // and can arrive without a reveal ever following it — a cold switch that
  // rolls back sends it alone.
  const offActive = app?.onViewWarmActivated?.(sync);
  document.addEventListener("visibilitychange", sync);
  return () => {
    offCached?.();
    offActive?.();
    document.removeEventListener("visibilitychange", sync);
    stopTicking();
  };
}, []);
```

[Views → Project switches and staleness](./views.md#project-switches-and-staleness) has why the DOM cannot do this, what each signal means, and the caveat that this bridge is the host's own rather than part of the plugin API.

## Open files the Daintree way

Don't build a markdown renderer or an audio player before checking what `host.dispatch` already reaches. Markdown that belongs inside your own view — a record's notes, a card's body — renders with [`Markdown` from `@daintreehq/plugin-ui`](./views.md#host-ui-components), Daintree's own renderer. A whole file goes to one of these instead; all are `danger: "safe"` and take a `path` (absolute, or relative to `rootPath` / the project root):

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

## Export a document

Invoices, quotes, reports and contracts share one shape: fill an HTML template, render it to PDF, hand the file to the user. The template step can be yours or an agent's — an agent is good at "draft the quote for Acme from these line items" and can write the HTML straight into your plugin-data folder, which your worker then renders.

```js
const dir = `${dataDir}/invoices`; // declare fs:user-data-read + fs:user-data-write
const htmlPath = `${dir}/${invoice.number}.html`;
await host.fs.writeFile(htmlPath, renderInvoiceHtml(invoice)); // or let an agent write it
const { path } = await host.documents.renderPdf({
  htmlPath,
  outputPath: `${dir}/${invoice.number}.pdf`,
  pageSize: "Letter",
  margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
});
await host.system.showItemInFolder(path); // or host.system.openPath(path)
```

Keep the template self-contained. The render has JavaScript off and no network, so a logo, a web font or a stylesheet has to sit next to the HTML (relative URLs resolve from `htmlPath`, inside the same root) or be inlined as a `data:` URI; a `<link>` to a CDN renders as if it were not there. Put the paper size in `pageSize` rather than CSS `@page size`, and use `page-break-inside: avoid` on table rows so a line item never splits across pages. `renderPdf` needs the same `fs:*-write` capability and consent a `writeFile` does, so a plugin that already writes files asks for nothing new. See [Host API → documents](./host-api.md#documents--render-html-to-pdf).

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

Once loaded, your own commands are also actions — but not MCP tools. The MCP tool lists are fixed per tier and name only Daintree's built-in actions, so an agent cannot call a plugin command back. To give agents an API, serve it from an [agent MCP endpoint](./agent-extensions.md#agent-mcp-endpoints).

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

That surface is visible only while the grid is empty. The moment a terminal opens it gives way. Above it the host draws a thin strip of its own, outside your view's box: a switch between your panel and the stock launcher and, while your surface shows, a "No panels open" label and the launcher's search entry. You never need to reserve space for it, so a top-right toolbar is fine. The first time the surface shows in a project, the user is asked whether to keep it, and the answer is remembered for that project. For a navigation that stays put, the same panel kind is dockable by default; a docked instance survives everything the grid does. Give the user both: the canvas for the cold open, the dock for the working session. Details under [Surfaces](./project-local.md#surfaces).

## Open your own panel from a command

`panel.openPluginPanel` spawns or focuses one of your panel kinds and hands the view an argument bag as `initialArgs`, which is also where `persistState` writes back, so a panel reopens the way it was left:

```js
const panelKindId = host.panelKindId("videos");

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

`kind` is the registered kind id. `host.panelKindId` qualifies your bare panel id for whichever origin you load under (`project:{projectId}/{manifestId}/{kindId}` for a project plugin). A `contextMenus` entry at `location: "file"` dispatches your command with `{ path, worktreePath, status }`, which is how "Show in Video Manager" appears on every file row.

## Look like the app, with Tailwind

Style views with Tailwind utility classes on Daintree's semantic tokens. The host compiles the classes your view uses at runtime, so this needs no build step and works identically in a raw `dist/panel.js` and a bundled view. The tokens are what make a panel follow theme switches for free; a row from the Videos dashboard:

```jsx
<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">
  <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
    <span className="text-xs font-medium">Slate</span>
    <span className="rounded-full bg-surface-inset px-2 py-0.5 text-2xs text-text-muted">
      {videos.length}
    </span>
  </div>
  <div className="flex-1 min-h-0 overflow-y-auto">
    {videos.map((video) => (
      <button
        key={video.path}
        onClick={() => open(video)}
        className={`flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-surface-hover ${
          video.path === selected ? "bg-surface-active" : ""
        }`}
      >
        …
      </button>
    ))}
  </div>
</div>
```

Three things that trip up a first plugin:

- **The stock palette is gone.** `bg-red-500` generates nothing at all — Daintree's theme deletes Tailwind's own colours so plugin panels cannot drift out of the design system. Use `status-danger` for the alarming thing and a `category-<hue>` for the categorical one.
- **A conditional class must be a complete string.** The ternary above works because both branches are whole class names. `` `bg-surface-${tone}` `` never compiles, because that name exists in neither your source nor the DOM.
- **`min-h-0` on every flex ancestor of a scroller.** Without it the panel's own scrollbar takes the overflow instead of your list. This is the single most common reason a plugin panel scrolls wrong.

[views.md](./views.md) has the full vocabulary and the portal rule.

## Keep commands one click

Declaring `shell:exec` raises every command the plugin registers to a confirm dialog. Narrow it per command with `requires`: `"requires": []` on the ones that only open a panel, the real list on the ones that run something. Give each command two or three `keywords` and a shared `category` so the palette groups them.

## What survives what

| State | Project switch (view kept) | Remount (maximise a sibling, leave a dock tab) | Hot reload (`dist/` rebuilt) | Project close |
| --- | --- | --- | --- | --- |
| React state in the view | kept | lost | lost | lost |
| Module-scope state in the worker | kept | kept | lost | lost |
| `persistState` bag on the panel | kept | kept | kept | kept with the layout |
| `host.storage`, `host.settings` | kept | kept | kept | kept |
| Spawned processes, watchers, badges | kept | kept | killed and cleared | killed and cleared |
| Custom element registrations | kept | kept | kept — registration is irreversible | cleared with the document |

The first column is the switch itself: nothing unmounts, so nothing in it is lost. Under memory pressure the host can go further and destroy a backgrounded project view, and that column then reads like a remount — the document goes with it, so custom element registrations clear too — while the worker and everything it owns carries on. [Views → Project switches and staleness](./views.md#project-switches-and-staleness) is how a view learns which of the two happened.

Design for the hot-reload column. A reload is a fresh worker and a fresh view generation; anything the user would be annoyed to lose belongs in `persistState` or `host.storage`.

The last row is the one that surprises people, because it is the only kind of state a reload cannot give you back: a custom element name outlives the module that registered it, so the rebuilt copy is either silently ignored or rejected outright, depending on whether the library guards its own `define`. [Views → Global registration survives reload](./views.md#global-registration-survives-reload) covers what to do about it.
