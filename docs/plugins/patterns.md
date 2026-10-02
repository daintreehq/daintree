# Patterns

The reference pages document each host call on its own. This page is how they compose into a plugin that does something: the shapes a real project plugin is built from, each with the exact calls. Most examples come from a "Videos" dashboard, the first real project plugin built against this system; the data patterns come from app-shaped plugins — a ledger, a board, a CRM — whose data agents edit as often as the user does. Read the [agent brief](./agent-brief.md) first; the rules there decide whether any of this loads. [Building apps](./building-apps.md) walks through an app end to end.

Throughout, `host` is the object `activate()` receives in the worker, and "the view" is the React component the renderer mounts. The two talk over channels; nothing else crosses the boundary. Views draw with `@daintreehq/plugin-ui` and use the hooks in `@daintreehq/plugin-sdk/react`; both resolve in a zero-build `dist/panel.js` as well as a bundled view.

## Subscribe, then pull

The base shape. The view subscribes for updates first, then asks for the current state. Pushes are not buffered, so a plugin that only pushes loses everything sent before the view existed; and a push and an `invoke` result travel separately, with no ordering between them, so a push can land before the pull's answer or after it. Subscribing first means no change is missed while the pull is in flight, and a revision on both says which of the two is newer.

```js
// worker (dist/index.mjs)
export async function activate(host) {
  // Register first and scan after: activate() has a 5-second budget, and a view
  // that pulls before the first scan lands gets the empty state, then a push.
  let slate = { revision: 0, videos: [] }; // whatever "current state" means for you
  await host.registerHandler("slate", async () => slate); // the pull

  const refresh = async () => {
    const videos = await scanVideos(host);
    if (sameVideos(videos, slate.videos)) return; // nothing changed: push nothing
    slate = { revision: slate.revision + 1, videos };
    await host.postToPanel("slate", slate); // the push, to every open instance
  };
  // Polling belongs here, not in the view: the worker is a separate utility
  // process, so it keeps its cadence while the user is in another project.
  void refresh(); // the first scan, not awaited
  const timer = setInterval(() => void refresh(), 15_000);
  return () => clearInterval(timer);
}
```

```js
// view (dist/panel.js)
useEffect(() => {
  let live = true;
  // Keep whichever arrives with the higher revision, push or pull.
  const accept = (next) =>
    live && setSlate((prev) => (prev && prev.revision >= next.revision ? prev : next));
  const off = window.electron.plugin.on(pluginId, "slate", accept); // subscribe first
  void window.electron.plugin.invoke(pluginId, "slate").then(accept); // then pull
  return () => {
    live = false;
    off();
  };
}, [pluginId]);
```

Handlers receive `(ctx, ...args)`: the IPC context first, then whatever the view passed to `invoke`. A handler that takes no arguments can ignore both, which is why the bug in an argument-taking one hides behind the ones that work.

This shape suits a small value that is replaced whole — a status, a summary, a handful of rows. Once the state is a list that grows, pushing all of it on every change costs the square of its length over the plugin's life; push only what changed instead ([next](#push-deltas-not-the-whole-state)). And when nothing on screen needs the push, don't produce it: `host.hasListeners?.(channel)` says whether any view may be subscribed, and `host.onDidChangeListeners?.(channel, cb)` tells you when that changes, so a worker ticker can stop while every panel is closed. Skip only what a view recovers by pulling on mount, never a one-off event. The host drops a targeted push to a panel that has closed, but a broadcast nobody listens to still crosses to the renderer, so a ticker that ignores this keeps pushing after the last panel closes.

## Push deltas, not the whole state

For a keyed list the worker owns and changes — tool calls, cards, notes, results — use `createSyncedCollection` in the worker and `useSyncedCollection` in the view. The worker keeps the collection; each change sends one delta (`{ epoch, revision, reset?, resync?, removes, upserts }`, where `removes` holds keys and `upserts` holds `[key, item]` pairs) instead of the list, a loop of changes within `flushMs` (default 16) goes out as one message, and a change set too big for one push is split across revisions. The view does the ordering work of the previous pattern for you: it subscribes, pulls a revisioned snapshot, holds pushes that race the pull, drops deltas the snapshot already covers, and pulls again on a revision gap or a worker restart.

```js
// worker (dist/index.mjs) — the root SDK entry is served to a zero-build worker
import { createSyncedCollection } from "@daintreehq/plugin-sdk";

export async function activate(host) {
  // During activate(): it registers the `calls-snapshot` handler.
  const calls = await createSyncedCollection(host, "calls", { key: (call) => call.id });
  // …on every tool call:
  //   calls.upsert(call);        one delta carrying one item
  //   calls.remove(id);  calls.replace(all);  calls.clear();
  return () => calls.dispose();
}
```

```js
// view (dist/panel.js) — `/react` is served to zero-build views too
import { createElement } from "react";
import { useSyncedCollection } from "@daintreehq/plugin-sdk/react";
import { PaneState, VirtualList, ListRow } from "@daintreehq/plugin-ui";

export default function Calls({ pluginId, disposeSignal }) {
  const { items, loading, error, resync } = useSyncedCollection(pluginId, "calls", {
    signal: disposeSignal,
  });
  if (error)
    return createElement(PaneState, {
      kind: "error",
      title: "Couldn't load calls",
      onRetry: resync,
    });
  if (loading) return createElement(PaneState, { kind: "loading", title: "Loading calls" });
  return createElement(VirtualList, {
    items,
    itemKey: (_i, call) => call.id,
    renderItem: (_i, call) => createElement(ListRow, { title: call.tool, meta: call.status }),
    "aria-label": "Tool calls",
  });
}
```

Apart from one empty delta sent at creation to announce the collection's epoch (so a view left over from a previous worker resyncs), nothing is pushed until a view has pulled, so a plugin whose panel was never opened sends no deltas, and on a host that reports listeners, deltas stop while every view is closed; the next view to open pulls a snapshot that carries them. In the lab, an agent-tools panel that re-sent its whole call log on each tool call pushed 1.1 MB in 200 messages for 100 calls; the synced collection sent 23 KB in 13. `syncedCollectionSnapshotChannel(channel)` names the snapshot channel (`<channel>-snapshot`) if something else needs to call it.

A delta names changed items by key but carries each one whole: `upsert(item)` resends every field of `item`, not the one that changed. In the lab, four status flips on a review queue sent about 1.1 KB, because each delta carried its whole item. Keep collection items to what the list renders — ids, titles, status, counts — and fetch a large field (a body, a diff, a log) with its own `invoke` when the row is opened.

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

## Stream progress and logs

A job that reports per item — a build, an import, a crawl — must not push per item. In the lab a loop that called `postToPanel` for each of 20,000 items sent 20,000 pushes, and a view that appended each to state (`[...prev, line]`) ended with 20,000 DOM rows and 300 ms frame gaps. The host now batches pushes into one IPC message per task, but every push still reaches your handler and every line still renders. Fix it on both sides:

- **Worker: gather, then push on a timer.** Collect lines in an array and push the batch every 50–100 ms, plus once at the end. The port of that job sent 7 pushes.
- **View: `useStreamBuffer` for anything appended.** It keeps every item up to `maxItems` (default 1000; older ones are dropped and counted in `dropped`) and commits at most once per frame. Pass `pushMany` (or `push`) straight to the subscription.
- **Render with `LogView`**, the kit's bounded, virtualised log. It keeps only the newest `maxLines` (default 5000) and mounts only the lines in view. Output from a CLI, escape codes and all, goes to `TerminalOutput` instead: pass the growing text (only its new tail is parsed) and it draws the terminal's colours and collapses progress-bar rewrites.
- **A value that replaces the last one** — a percentage, the current file — is not a stream: wrap its setter in `useThrottledCallback`, which keeps only the latest arguments per frame, and show it in a `ProgressBar`. Never use it for lines; it drops all but the last.

```js
// worker
const pending = [];
const flush = () => {
  const batch = pending.splice(0); // take everything gathered so far
  if (batch.length) void host.postToPanel("log", batch);
};
const timer = setInterval(flush, 50);
for (const item of items) pending.push(await process(item));
clearInterval(timer);
flush();
```

```js
// view
import { createElement } from "react";
import { usePluginEvent, useStreamBuffer } from "@daintreehq/plugin-sdk/react";
import { LogView } from "@daintreehq/plugin-ui";

export default function Job({ pluginId }) {
  const log = useStreamBuffer({ maxItems: 5000 });
  usePluginEvent(pluginId, "log", log.pushMany);
  return createElement(LogView, { lines: log.items, "aria-label": "Job output" });
}
```

## Large lists

A list whose length the user controls — search results, a table of records, a file tree — is a list that will one day have ten thousand rows. The naive `rows.map(...)` table in the lab took 1.5 s to first paint at 10,000 rows, held 130,027 DOM nodes and took 1.6 s to re-sort, while fetching the same 1.5 MB of data took 35 ms: the cost was all rendering. The kit's `DataTable` on the same data held 490 nodes and sorted in 19 ms.

| Rows | Use |
| --- | --- |
| A table of records | `DataTable` from `@daintreehq/plugin-ui`: sticky header, a virtualised body by default (`virtualize={false}` for a short ledger that sizes to its rows), controlled sort (`sort` + `onSortChange`; you sort `rows`), keyboard grid with `onRowClick`, `empty` for the zero state |
| A list of any length | `VirtualList` with `ListRow` rows; add `useListNavigation` for a keyboard listbox |
| Up to a few hundred rows you render yourself | `useProgressiveList(items, { initial, step })` from `@daintreehq/plugin-sdk/react`: the first screenful paints at once, the rest arrives in non-blocking transitions |
| Thousands of rows in your own markup | `useVirtualList({ count, estimateSize, getScrollElement })`, the headless windowing hook behind a custom layout |

Both kit lists fill their container's height, so give the container one (`flex-1 min-h-0` inside the panel root, or a fixed height). `onEndReached` on either is where the next page loads. Filter and sort in memory or in the worker, but keep the rendered set windowed.

```js
// DataTable and formatBytes both come from "@daintreehq/plugin-ui"
createElement(DataTable, {
  columns: [
    { id: "name", header: "Name", sortable: true },
    { id: "size", header: "Size", align: "end", width: 96, render: (row) => formatBytes(row.size) },
  ],
  rows: sorted,
  rowKey: "path",
  sort,
  onSortChange: setSort,
  "aria-label": "Files",
});
```

## Write the data contract down

An agent edits your data knowing only what it reads. Put the contract in the plugin's own `AGENTS.md` and point to it from the project's root `AGENTS.md` / `CLAUDE.md`:

```markdown
## Budget data (acme.budget)

- If you have the `daintree-budget` MCP tools, use them: `database_query` for reads, `record_transaction` for every write (it checks the category and the sign). Without them, use `sqlite3` as below.
- Transactions live in `data/budget.db`, table `tx`. Run `sqlite3` from the main checkout, `"$(git rev-parse --path-format=absolute --git-common-dir)/.."`, never a linked worktree's copy.
- `amount_cents` is an integer; spending is negative. `category` is one of the rows in `categories`.
- Totals, balances and "this month": run `node scripts/budget-report.mjs`, never add rows up by hand.
- Leave `_daintree_meta`, `.daintree/plugin-settings/` and `.daintree/plugins/` alone.
- Example: `INSERT INTO tx (date, amount_cents, category, memo) VALUES ('2026-03-14', -1899, 'books', 'Field guide');`
```

`plugins/sample-project/acme.ledger/AGENTS.md` is a complete contract for a working data plugin: where the file is, every column, which rules the triggers enforce and the one they cannot, and when to use the plugin's tools rather than `sqlite3`.

What it needs, learned from the first app plugins agents edited:

- **Which tools to use.** Name the plugin's MCP server and tools and when to use each, with the `sqlite3` or file recipe as the fallback for an agent that doesn't have them — one launched outside Daintree, before the plugin was on, or by a CLI Daintree can't wire ([Agent extensions → Reaching an agent](./agent-extensions.md#reaching-an-agent)).
- **Paths, schema and invariants** — which files or tables, which fields are required, what a valid value looks like.
- **One worked example whose values are not your test prompts.** An example that matches the request turns discovery into copy-paste and proves nothing.
- **Which checkout to write.** The panel reads `host.pluginInfo.projectRoot`, the main checkout. An agent in a linked worktree edits that worktree's copy of every committed file, and the panel never sees it.
- **A script for anything computed.** Agents eyeballing raw data get streaks, weekly totals and "due this week" wrong. Keep the calculation in a pure module with no imports — `dist/core.mjs` — that the worker imports, the view imports (`plugin://` serves `.mjs` as JavaScript), and `scripts/<name>-report.mjs` imports for agents, so the three cannot disagree. For SQLite, a view in `definitions` does the same job.
- **What not to touch.** Settings are the user's; `.daintree/` beyond your data — `mcp.json` included — is Daintree's.
- **Conventions a hand-off relies on** — "move the card to Review when you finish" — belong here, not in each [hand-off](#hand-work-to-an-agent).

## Watch a folder, refresh, badge the tab

`host.fs.watch` is a plain `fs.watch` by default: non-recursive, best-effort, one callback per changed path. Treat a callback as an invalidation hint that prompts a re-read of the thing that changed, never as an event log. Three options make it fit data an agent writes:

- **`allowMissing: true`** accepts a folder that does not exist yet and keeps watching through its deletion and recreation, calling back on each transition. Without it, watching a missing folder rejects and a recreated folder silently stops reporting — the reason early plugins carried retry timers and fallback polls. With it they need neither.
- **`debounceMs`** collapses an agent's burst of edits into one trailing callback with the latest path.
- **`recursive: true`** watches a whole data tree, including subdirectories created later — but keep it to your own data directory rather than a whole worktree (see [`fs` in the host API](./host-api.md#fs--host-mediated-scope-contained-filesystem) for the Linux cost).

Watch the directory, not a file. Editors and agents write by rename and create new files, and only a directory watch sees either.

```js
const dataDir = `${host.pluginInfo.projectRoot}/board`;
const dispose = await host.fs.watch(
  [dataDir],
  (changedPath) => void refreshOne(changedPath), // re-read only what changed, then postToPanel
  { allowMissing: true, debounceMs: 200 }
);

// Surface state on the tab without the panel being open. Badges are keyed by
// (pluginId, panelId) and cleared on unload; pass null to clear one yourself.
await host.setPanelBadge(panelId, { kind: "dot", color: "warning", tooltip: "2 gate errors" });
```

Your own writes come back through the watch too. Keep the revision each write returns and skip a callback whose file still hashes to it, or a refresh that writes can loop.

Watchers and badges are both released on unload; `dispose()` the watcher yourself when the panel that needed it is removed (`onDidChangePanelLifecycle`, phase `removed`).

The host's own bursty subscriptions coalesce without being asked: `onDidChangeWorktrees`, `onDidChangeActiveWorktree` and `onDidChangeAgentState` deliver one trailing callback 100 ms after a burst (and at least every four windows while it lasts), always with the latest state; `onDidChangeWorktrees` also hands you `{ added, removed, changed }` ids for the net change. Pass `{ debounceMs: 0 }` only when you need every event, or a larger window when you need fewer. `host.fs.watch` is the exception, with no debounce unless you pass one.

## Build a file UI

A file browser, a search, an index: the host has calls that do in one round trip what a loop of `readdir` and `readFile` does in hundreds. The naive search in the lab walked 2,045 files with one `readdir` per directory and one `readFile` per file, and took 960 ms per search; with batched reads, a parallel cached walk and a result cap it took 335 ms.

- **`host.fs.walk(root, { include, exclude, maxDepth, limit, respectGitignore, includeSize })`** lists a tree in one call: root-relative `/` paths sorted by path, breadth-first, what git ignores left out by default, symlinks neither followed nor listed, at most `limit` entries (default 10,000, up to 50,000) with `truncated` set when it stopped early.
- **`host.fs.readFiles(paths, { encoding, maxBytesPerFile })`** reads up to 1,024 files in one call (more rejects the call), 8 MiB of content in total, and answers per path in request order: `{ path, ok: true, content }` or `{ path, ok: false, error: { code, message } }`. One unreadable file never fails the batch; `RESULT_TOO_LARGE` marks entries past the budget, to read in a follow-up call.
- **`host.fs.readdir(dir, { detail: true })`** is what a tree view wants per directory: size, mtime, symlink target, and Daintree's own order — directories first, then numeric-aware names, so `churn-2.txt` sorts before `churn-10.txt`. `@daintreehq/plugin-sdk/files` is the headless file-tree model Daintree's file browser runs on, fed from it. It is pure and runs anywhere, but a raw view cannot import it — the host import map does not serve it — so use it in a bundled view, as `plugins/sample/file-tree/` does, or in the worker.
- **Cache the walk behind a watch** (`fs.watch` with `recursive: true` on the tree you walked) rather than walking again on every keystroke, and cap what you send the view.

Both batch calls are optional in the type, for hand-written fakes; Daintree's host, the worker and `createMockHost` always have them.

```js
const { entries } = await host.fs.walk(root, {
  include: ["**/*.md"],
  exclude: ["node_modules", "**/dist"],
});
const paths = entries.filter((e) => e.type === "file").map((e) => `${root}/${e.path}`);
const files = [];
const failed = [];
let queue = paths;
while (queue.length > 0) {
  const batch = await host.fs.readFiles(queue.slice(0, 1024), { maxBytesPerFile: 1024 * 1024 });
  const deferred = batch.filter((f) => !f.ok && f.error.code === "RESULT_TOO_LARGE");
  files.push(...batch.filter((f) => f.ok));
  failed.push(...batch.filter((f) => !f.ok && f.error.code !== "RESULT_TOO_LARGE")); // show these
  // Entries past the call's 8 MiB budget come back unread: send them again.
  queue = [...deferred.map((f) => f.path), ...queue.slice(1024)];
}
const hits = files.filter((f) => f.content.includes(query)).slice(0, 2000);
```

## Edit a file an agent also edits

A panel that reads a card, changes one field and writes the whole file back will, sooner or later, overwrite the line an agent added in between. `editFile` from `@daintreehq/plugin-sdk/data` is the fix, importable from a zero-build worker with no install: it reads the file with its revision, applies your transform, writes only if nothing changed in between, and re-reads and re-applies if something did.

```js
import { editFile, updateFrontmatter } from "@daintreehq/plugin-sdk/data";

await host.registerHandler("set-stage", async (_ctx, { path, stage }) => {
  // A card deleted meanwhile stays deleted: null in, null out.
  const { written } = await editFile(
    host,
    path,
    (text) => text && updateFrontmatter(text, { stage })
  );
  return { written };
});
```

`updateFrontmatter` changes only the keys you name and leaves every other byte — comments, key order, the body — as the agent wrote it, so the diff an agent sees is the one line you meant. For a log, `host.fs.appendFile` with `stringifyJsonlLine` lands each line at the end without a read-modify-write at all. When you manage writes yourself, the pair is `host.fs.readFileWithRevision` and `writeFile(path, text, { expectedRevision })`; a conflict rejects with `err.code === "REVISION_MISMATCH"` and `err.currentRevision`, which survive the worker port. Branch on `code`, not on the message. Details: [Data helpers](./data-helpers.md).

## Keep structured data in SQLite

When the data is rows you query, total or page through — a ledger, stock movements, time entries — declare a database and open it through `host.db`. Never open the file with `node:sqlite` yourself: the host resolves and contains the path, asks consent before creating a project database, reopens a file `git checkout` replaced underneath you, and tells you when an agent's `sqlite3` session commits.

```jsonc
// plugin.json — a project plugin; "location" defaults to "project"
"scope": "project",
"capabilities": ["fs:project-write"],
"contributes": { "databases": [{ "id": "ledger", "description": "Household transactions" }] }
```

A `"project"` database is a file in the repository, so only a `"scope": "project"` plugin may declare one. An installed plugin declares `"location": "local"` instead, which keeps the file in its data directory and needs no capability.

```js
// worker: open lazily and keep the promise — the first open of a project
// database waits on a consent prompt, which must not run inside activate().
let ledger;
const db = () =>
  (ledger ??= host.db
    .open("ledger", { migrations, definitions })
    .then((handle) => {
      handle.onDidChange(() => void host.postToPanel("ledger-changed", null));
      return handle;
    })
    .catch((err) => {
      ledger = undefined; // a declined prompt can be asked again on the next call
      throw err;
    }));

await host.registerHandler("month", async (_ctx, { month }) =>
  (await db()).query("SELECT * FROM month_totals WHERE month = ?", [month])
);
```

The `null` push means "what you showed is stale". Refetch on it with `useCachedHostChannel`'s `invalidateOn` rather than an `invoke` in your own listener: a burst of invalidations costs one refetch after `debounceMs` (default 100) of quiet, shared by every view on the same key, and a push that arrives mid-request queues one follow-up instead of dropping the answer. The cached result also paints first on the next open. `onDidChange` itself already coalesces: changes landing within one 50 ms window arrive as one callback; in the lab 200 sequential creates now produced 4 change pushes rather than 200.

```js
// view
import { useCachedHostChannel } from "@daintreehq/plugin-sdk/react";

const {
  data: rows,
  error,
  revalidate,
} = useCachedHostChannel(
  pluginId,
  "month",
  { month },
  {
    invalidateOn: "ledger-changed",
    signal: disposeSignal,
  }
);
```

When the list is large and changes a row at a time, a synced collection the worker updates from its own writes ([Push deltas](#push-deltas-not-the-whole-state)) avoids the refetch altogether; keep the invalidation for changes the worker didn't make, such as an agent's `sqlite3` session.

- **Rules live in the schema**, because agents write with the `sqlite3` CLI, which does not enforce foreign keys. `CHECK` constraints plus `BEFORE INSERT` / `BEFORE UPDATE` triggers with `RAISE(ABORT, 'category must be one of the rows in categories')` — the agent reads the message and corrects itself. The message must be a string literal, so name the rule rather than the bad value.
- **Arithmetic lives in views**, declared in `definitions` (`DROP VIEW IF EXISTS month_totals; CREATE VIEW month_totals AS …`). The panel, a report script and an agent's `sqlite3` query then read the same numbers. `definitions` re-applies only when its text changes, so opening the panel does not dirty a committed database.
- **A dashboard over agent-written data** opens with `{ readonly: true }`: no consent prompt, nothing created, writes refused with `DB_READONLY`.
- **Money is integer cents**, and an integer past 2^53 comes back as a `bigint`.
- **Branch on the `DB_*` code** (`DB_NOT_FOUND`, `DB_SCHEMA_TOO_NEW`, `DB_MIGRATION_FAILED`, …) on `err.code`. `DB_NOT_DECLARED` is the exception: it has no `err.code`, only the `DB_NOT_DECLARED:` message prefix.

Tell agents in your data contract to leave the host's `_daintree_meta` table alone. The full reference is [Host API → db](./host-api.md#db--host-managed-sqlite).

## Refresh when the user comes back

Switching projects leaves your view mounted, its React state intact, and its page visibility unchanged — nothing in the DOM marks the switch. The signal is main's, on `window.electron.app`, and the pull it drives is the one you already wrote for mount. That bridge is the host's own, not part of the plugin API ([Views → Project switches and staleness](./views.md#project-switches-and-staleness)): `@daintreehq/plugin-sdk/view-globals` deliberately leaves it out, a TypeScript view reads it through its own narrow cast, and every call below is optional-chained so a host without it reads as a view that is never cached or revealed. Where the SDK already covers the case — `useNow`, `useAnimationFrame` — use the hook rather than the bridge.

```js
// view: subscribe and pull on mount, re-pull when this project is shown again —
// reveal is an extra trigger for the same load, not a replacement for it.
useEffect(() => {
  let live = true;
  const accept = (next) =>
    live && setSlate((prev) => (prev && prev.revision >= next.revision ? prev : next));
  const load = async () => {
    // `invoke` rejects when the handler throws or the plugin has unloaded.
    const next = await window.electron.plugin.invoke(pluginId, "slate").catch(() => null);
    if (next) accept(next);
  };
  const off = window.electron.plugin.on(pluginId, "slate", accept); // subscribe first
  void load(); // first mount, and the remount after a reclaimed renderer
  const offRevealed = window.electron?.app?.onViewRevealed?.(() => void load());
  return () => {
    live = false;
    off();
    offRevealed?.();
  };
}, [pluginId]);
```

The mount pull is not redundant with the reveal pull: under memory pressure the host destroys a backgrounded project view outright, and the user's next switch back is a cold mount with no reveal to catch. Route both through one function and the two cannot drift.

Periodic work in the view is the other half. For the two common cases the SDK already does it: `useNow` (a clock) and `useAnimationFrame` (a canvas loop) both pause while the project view is cached or the document hidden — see [Clocks](#clocks-and-relative-times) and [Canvas](#draw-on-a-canvas). Anything else needs the cache edges rather than the reveal: `onViewRevealed` arrives only for a switch that completes with your project in front. Seed from `isViewCached()` — these are edges, nothing replays, and a mount can land in an already-cached view — and AND it with document visibility, which covers the window being minimised while this project is the active one.

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

## Clocks and relative times

"5m ago", "due in 2h", an elapsed timer: text that changes because time passes, not because data did. Don't give each row its own `setInterval` — `daintree-plugin lint` flags a view interval as `interval-polling-in-view` — and don't poll the worker to re-render. `useNow({ intervalMs })` from `@daintreehq/plugin-sdk/react` returns `Date.now()` and re-renders every `intervalMs` (default 60,000, at least 1,000), aligned to whole multiples so every time on screen turns over together. One timer per interval is shared by every component that asks, it pauses while nobody can see the view, and it catches up at once when they can.

```js
import { useNow } from "@daintreehq/plugin-sdk/react";
import { formatTimeAgo } from "@daintreehq/plugin-ui";

function Updated({ at }) {
  const now = useNow(); // once a minute
  return formatTimeAgo(at, now); // "just now", "5m ago", "11d ago"
}
```

The kit's formatters — `formatTimeAgo`, `formatRelativeTime`, `formatDuration`, `formatBytes`, `formatCount` — are the host's own, so a plugin's times and sizes read like the rest of the app.

`formatTimeAgo` is minute-grained: "just now" for the first 60 seconds, then "1m ago". A time that has to move every second — "12s ago" on a feed, the elapsed time of a running job — takes a one-second clock and `formatDuration`, which reads "12s" under a minute, then "3m" and "1h 5m":

```js
import { useNow } from "@daintreehq/plugin-sdk/react";
import { formatDuration } from "@daintreehq/plugin-ui";

function Elapsed({ since }) {
  const now = useNow({ intervalMs: 1000 });
  return `${formatDuration(now - since)} ago`;
}
```

Use the one-second clock only where seconds matter; every component on it re-renders once a second while the view is visible.

## Draw on a canvas

A bar, line or donut chart is the kit's `BarChart`, `LineChart` or `DonutChart`, themed and keyboard-complete with nothing to draw. For anything else — a scatter, a graph of nodes, a simulation — two things go wrong in a hand-rolled canvas view: its `requestAnimationFrame` loop keeps running at full rate in a backgrounded project (the DOM cannot tell it the project was switched away), and the colours it read once from `getComputedStyle` stay wrong after a theme switch — the lab's canvas kept painting a dark background under a light theme.

- **`useAnimationFrame((dt, time) => …, { signal: disposeSignal })`** runs the loop once per frame and pauses while the document is hidden or the project view is cached. `dt` is 0 on the first frame after a resume, so a simulation never jumps by the time it spent paused.
- **`useDaintreeTheme()`** from `@daintreehq/plugin-ui` returns `{ colorMode, themeId, tokens }`, with every token resolved to a concrete sRGB colour (`#rrggbb`, or `rgba(…)` when translucent), and re-renders on a theme change. Outside React, `getDaintreeTheme()` reads it and `onDidChangeDaintreeTheme(listener)` subscribes, returning the unsubscribe. Token keys are the `--theme-*` names without the prefix (`surface-panel`, `text-primary`, `category-blue`, …).

```js
import { useRef } from "react";
import { useAnimationFrame } from "@daintreehq/plugin-sdk/react";
import { useDaintreeTheme } from "@daintreehq/plugin-ui";

function Chart({ disposeSignal, sim }) {
  const canvas = useRef(null);
  const { tokens } = useDaintreeTheme(); // repaints with the new colours on a theme switch
  useAnimationFrame(
    (dt) => {
      const ctx = canvas.current?.getContext("2d");
      if (!ctx) return;
      sim.step(dt / 1000);
      ctx.fillStyle = tokens["surface-panel"];
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      sim.draw(ctx, tokens["category-blue"]);
    },
    { signal: disposeSignal }
  );
  return <canvas ref={canvas} className="h-full w-full" />;
}
```

The core token groups — surfaces, text, borders, accent, `focus-ring`, status — are stable within the kit's major version. The extended groups (`terminal-*` and the ANSI colours, `syntax-*`, `activity-*`, `category-*`) are best effort and may be renamed in a minor, so read those with a fallback. A WebGL context still belongs in `createViewScope`'s `webgl()` so it is released with the mount ([Views → Resources your view owns](./views.md#resources-your-view-owns)).

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

When an agent writes the HTML, the PDF can go stale behind it. Put a fingerprint of what the document was made from in the HTML (`<meta name="source" content="INV-042|paid|12500">`), recompute it when the data changes, and show a stale document as stale rather than trusting that someone re-rendered it.

## Back up and export data

A user's data in an app plugin is worth protecting, and most of it is already covered:

- **Databases back themselves up.** Every panel of a plugin that declares `contributes.databases` has a host-owned **Back up data…** entry on its ⋯ and right-click menus. It snapshots each declared database that exists to a file or folder the user picks, using SQLite's online backup, so a copy taken while an agent is writing is still consistent. You write nothing.
- **A copy your plugin makes** — a nightly snapshot into a Dropbox folder, a "Back up now" button — is `db.backup(destPath)`: the same snapshot, written through `host.fs.writeFile`'s containment and consent, refused over a leftover `-wal` / `-journal` file. The destination has to be inside your declared `scopes.fs.allowedPaths` or your data directory. Never point a sync folder at the live database.
- **Files are already in the repository.** Committed data has git's history; say in your README whether the data is committed or ignored, because that decides whether a clone brings it.
- **An export for another tool** — CSV for a spreadsheet, a PDF report — is an ordinary action: query, format, `host.fs.writeFile` or `renderPdf`, then `host.system.showItemInFolder(path)`. Offer it from the panel's own menu with [`contributes.panels[].menu`](./contribution-points.md#panel-menu), which dispatches your action with `{ panelId }`.

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

## Hand work to an agent

The move that makes a project app agentic: pick up a kanban card, a support message, a calendar entry, and give it to one of the agents working in the project. Two routes, one destination — the agent's draft, where the user adds the instruction ("fix this", "reply to this") and presses Enter. Neither route ever submits.

**Drag it onto an agent.** Make the card draggable and put the agent-context payload on the drag. No worker code, no capability:

```js
onDragStart: (event) => {
  event.dataTransfer.setData(
    "application/x-daintree-agent-context",
    JSON.stringify({ v: 1, title: card.title, text: card.body, source: { label: "Kanban" } })
  );
  event.dataTransfer.setData("text/plain", card.body);
},
```

Dropped on an agent's input bar or its terminal, it lands in that agent's draft and the caret follows it. A shell, a locked agent or anything else that can't take a draft refuses the drag. Details and the SDK helper: [Views → Handing work to an agent by drag](./views.md#handing-work-to-an-agent-by-drag).

**Right-click → "Send to agent…".** For the menu, a button or the keyboard, call `host.sendToAgent` from your worker (it needs `agent:input` and asks the user once). Without a target the user picks the agent, grouped by worktree, or starts a new one — in this worktree or a fresh one named after the card:

```js
// worker — build the brief from what is on disk now, not the view's copy
await host.registerHandler("sendToAgent", async (_ctx, { cardId, worktreeId }) => {
  const card = await loadCard(cardId);
  return host.sendToAgent(card.body, { title: card.title, worktreeId });
});
// view — worktreeId is PanelViewProps.worktreeId, so an agent there is offered first
const result = await window.electron.plugin.invoke(pluginId, "sendToAgent", {
  cardId: card.id,
  worktreeId,
});
if (result.status === "drafted") setNote(card, "Drafted into the agent's input");
```

`result` is `drafted` (with the pane's id), `cancelled`, or `refused` with a reason (the user is shown the ones about their agent). `drafted` means the text is sitting in that agent's input and nothing more: the user may edit it, send it later or delete it, and no event tells you which. Report what happened; never mark the card as in progress on `drafted`. If the card's state should change when the work is done, that is the agent's job, and the convention ("move it to Review when you finish") belongs in your [data contract](#write-the-data-contract-down), where every agent reads it. To offer your own list instead, `host.agents.list()` (`agent:read`) returns the project's agent panes with their worktree and whether each can take a draft; pass the chosen `terminalId` and there is no picker.

What lands, either way: one fenced block holding a heading (your label or plugin name and the card's title) and the card's text, appended after anything the user already typed. The block is tagged `daintree-context` and stays literal: a card that mentions `@diff` does not pull in the user's diff when they submit. Keep `text` to what the agent needs — at most 32,768 characters — and let the agent read the rest from your data through the files or an [agent MCP endpoint](./agent-extensions.md#agent-mcp-endpoints). Never put the instruction in the text: the user writes that. The one exception is housekeeping every hand-off shares, and that belongs in `AGENTS.md` rather than in each draft.

## Gate on setup

A plugin that cannot work until the user supplies something — an API key, a data folder, which calendar to show — declares it `required` and lets the host do the gating:

```jsonc
"settings": [
  { "id": "apiKey", "type": "secret", "label": "API key", "required": true },
  { "id": "dataDir", "type": "directory", "scope": "local", "label": "Data folder", "required": true, "mustExist": true }
]
```

```js
// worker: check before doing work that needs them, and send the user to the field
const missing = await host.settings.missingRequired();
if (missing.length > 0) {
  await host.settings.open(missing[0]);
  return { needsSetup: missing };
}
```

While a required setting is unset, every panel and surface of the plugin shows a "needs setup" strip that opens the field, so a panel only needs to render an empty state (`PaneState kind="empty"` or `EmptyState`) — never its own settings screen, and never a second setup banner. `missingRequired()` is right there to call, which is why plugins draw one; with the host's strip already showing, the user then sees the same warning twice. `host.settings.open(key)` and the panels' **Plugin settings…** entry land on the one home the field lives in. A `default` never satisfies `required`, and a `secret` cannot declare one: it would ship in `plugin.json`.

For a value the generated form edits badly — a per-channel table stored as `json`, a list with its own add and remove — declare a `location: "settings"` view and give the fields it owns `editor: "view"`; the form then leaves them out instead of showing a raw box beside your editor ([Views → A settings section](./views.md#a-settings-section)). Choose scopes by where the value belongs: `project` is committed, `local` stays on this machine for this project, and a secret is never committed. Settings are the user's, so keep them out of the data contract agents follow.

## Run a command

For a long-lived process (a dev server, a watcher), `host.process.spawn` is the supervised path: it needs the `shell:exec` capability, raises a one-time consent dialog on first use, streams output to your views on the `process` channel keyed by handle id, and is killed with the plugin.

```js
const handle = await host.process.spawn("npm", { args: ["run", "dev"], cwd: projectRoot });
handle.onCrash(() => host.showToast({ message: "Dev server crashed", type: "error" }));
```

For a server that speaks JSON-RPC over stdio, `mode: "duplex"` gives you a writable stdin and separate stdout; see [Host API → Modes](./host-api.md#modes).

For a one-shot command whose output is the result (a linter, a script that prints JSON), collect `handle.onData` chunks and read them in `onExit`. In pipe and duplex mode the handle waits for stdout and stderr to close before it reports the exit, up to a two-second drain, so the last line is not lost; a pty reports through its own exit. There is no `host.process.exec()`.

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
    const result = await host.dispatch("panel.openPluginPanel", {
      kind: panelKindId,
      initialArgs: { path },
    });
    if (!result.ok) throw new Error(`Could not open the panel: ${result.error?.message}`);
  }
);
```

`dispatch` resolves `{ ok: false }` instead of throwing, so a command that ignores the result opens nothing and says nothing. `kind` is the registered kind id.

`reuseExisting` defaults to `true`: if a panel of this kind is already open in the target worktree (`worktreeId`, or the active worktree when you pass none) and not in the trash, the action focuses that panel where it is, grid or dock, and resolves with its `panelId`. It does **not** hand it the new `initialArgs` — the open panel keeps the state it has — so "Show in Video Manager" on a second file only brings the manager forward. To act on the new argument, keep it where the view pulls from — worker state the view reads with an `invoke` on mount — and then push a "changed" notice (`host.postToPanel(channel, payload, panelId)`) so an open view pulls again; a push alone can be lost, because the action returns before a view has necessarily subscribed and pushes are not buffered. Or pass `reuseExisting: false`, which always adds a new panel to the grid with these `initialArgs`. A panel in another worktree is never reused. `host.panelKindId` qualifies your bare panel id for whichever origin you load under (`project:{projectId}/{manifestId}/{kindId}` for a project plugin). A `contextMenus` entry at `location: "file"` dispatches your command with `{ path, worktreePath, status }`, which is how "Show in Video Manager" appears on every file row.

## Look like the app: the kit first, Tailwind for the rest

Draw with `@daintreehq/plugin-ui` before writing markup of your own. It is Daintree's own components, served to your view through the import map like `react` — themed with the app, keyboard- and screen-reader-complete, and linted for: `daintree-plugin lint` flags a hand-rolled button, form control, spinner, badge, inline icon or native dialog and names the kit component to use. The Videos dashboard's list, drawn with it:

```jsx
import { Badge, ListRow, PaneHeader, VirtualList } from "@daintreehq/plugin-ui";

<div className="flex flex-col flex-1 min-h-0 bg-surface-panel text-text-primary">
  <PaneHeader icon="monitor-play" title="Slate" subtitle={<Badge>{videos.length}</Badge>} />
  <div className="flex-1 min-h-0">
    <VirtualList
      items={videos}
      itemKey={(_i, video) => video.path}
      renderItem={(_i, video) => (
        <ListRow
          title={video.title}
          selected={video.path === selected}
          onSelect={() => open(video)}
        />
      )}
      aria-label="Videos"
    />
  </div>
</div>;
```

The example is JSX, so it needs a build; a zero-build `dist/panel.js` writes the same tree with `createElement`, importing the same components. Tailwind utility classes on Daintree's semantic tokens do the rest: the layout around the kit, and anything bespoke the kit has no component for. The host compiles the classes your view uses at runtime, so this needs no build step and works identically in a raw `dist/panel.js` and a bundled view, and the tokens are what make a panel follow theme switches for free. Nothing is locked down — the whole token vocabulary is there for UI of your own.

Three things that trip up a first plugin:

- **The stock palette is gone.** `bg-red-500` generates nothing at all — Daintree's theme deletes Tailwind's own colours so plugin panels cannot drift out of the design system. Use `status-danger` for the alarming thing and a `category-<hue>` for the categorical one.
- **A conditional class must be a complete string.** `selected ? "bg-surface-active" : ""` works because both branches are whole class names. `` `bg-surface-${tone}` `` never compiles, because that name exists in neither your source nor the DOM.
- **`min-h-0` on every flex ancestor of a scroller.** Without it the panel's own scrollbar takes the overflow instead of your list. This is the single most common reason a plugin panel scrolls wrong.
- **A container query needs an ancestor container.** `@md:grid-cols-4` answers to the nearest ancestor with `@container`, never to its own element, so `@container @md:grid-cols-4` on one `div` never applies. Put `@container` on the wrapper.

[views.md](./views.md) has the kit's component list, the full vocabulary and the portal rule.

## Keep commands one click

Declaring any of `shell:exec`, `git:write`, `fs:project-write`, `fs:user-data-write`, `agent:input`, `agent:invoke` or `agent:register` raises every command the plugin registers to a confirm dialog — so an app that writes its own data files confirms its Open command. Narrow it per command with `requires`: `"requires": []` on the ones that only open a panel, the real list on the ones that write or run something. Put it on the `contributes.commands` entry and on the `registerAction` descriptor, which replaces the manifest entry once registered. Give each command two or three `keywords` and a shared `category` so the palette groups them.

## What survives what

| State | Project switch (view kept) | Remount (maximise a sibling, leave a dock tab) | Hot reload (`dist/` rebuilt) | Project close |
| --- | --- | --- | --- | --- |
| React state in the view | kept | lost | lost | lost |
| Module-scope state in the worker | kept | kept | lost | lost |
| `persistState` bag on the panel | kept | kept | kept | kept with the layout |
| `host.storage`, `host.settings` | kept | kept | kept | kept |
| Spawned processes, watchers, badges, `host.db` handles | kept | kept | killed, cleared and closed | killed, cleared and closed |
| Your data files and databases | kept | kept | kept | kept |
| Custom element registrations | kept | kept | kept — registration is irreversible | cleared with the document |

The first column is the switch itself: nothing unmounts, so nothing in it is lost. Under memory pressure the host can go further and destroy a backgrounded project view, and that column then reads like a remount — the document goes with it, so custom element registrations clear too — while the worker and everything it owns carries on. [Views → Project switches and staleness](./views.md#project-switches-and-staleness) is how a view learns which of the two happened.

Design for the hot-reload column. A reload is a fresh worker and a fresh view generation; anything the user would be annoyed to lose belongs in `persistState` or `host.storage`.

The last row is the one that surprises people, because it is the only kind of state a reload cannot give you back: a custom element name outlives the module that registered it, so the rebuilt copy is either silently ignored or rejected outright, depending on whether the library guards its own `define`. [Views → Global registration survives reload](./views.md#global-registration-survives-reload) covers what to do about it.
