# Building an app as a plugin

A project plugin can stand in for a small SaaS product: an expense tracker, a CRM, a kanban board, a content calendar. The user asks an agent in a terminal to "track a $42 lunch with a client" or "move K-7 to review", the agent makes the change through the plugin's tools — or edits the data directly when it has none — and a panel shows the result a second later. This guide is how to build one. It assumes you have read the [agent brief](./agent-brief.md), which has the load rules, a zero-build skeleton, and the UI kit and performance defaults, and it links to the reference docs rather than repeating them.

## The shape

Five parts, all in the project's repository:

```
<project>/
├── AGENTS.md                      # names the data and points at the contract
├── CLAUDE.md                      # "@AGENTS.md", so Claude Code reads the same file
├── data/budget.db                 # or board/board.json, crm/contacts/*.md, habits/log/*.jsonl
├── scripts/budget-report.mjs      # optional: numbers agents shouldn't work out by eye
└── .daintree/
    ├── mcp.json                   # turns the plugin's agent tools on for everyone who opens the project
    └── plugins/acme.budget/
        ├── plugin.json
        ├── AGENTS.md              # the data contract
        └── dist/index.mjs, dist/panel.js
```

- **The data store** is the source of truth. Agents and the panel read and write the same files or the same SQLite database.
- **The agent tools** are how agents launched in Daintree reach it: the host's read-only database tools, which a declared database gets with no code, and your own tools for writes that have rules. See [Giving agents tools](#giving-agents-tools).
- **The data contract** (`AGENTS.md` beside the plugin) is what an agent knows about your data beyond the tools' descriptions, and the whole of it for an agent without them. It is the most important file in the plugin.
- **The panel** renders the data with Daintree's UI kit, refreshes live when an agent changes it, and lets the user edit it without clobbering the agent.
- **The plugin** is a thin worker around the store: handlers the view calls, a watch or change subscription, and the actions behind its commands and menus.

A trimmed manifest for a SQLite-backed app, which is valid as written:

```json
{
  "name": "acme.budget",
  "version": "0.1.0",
  "scope": "project",
  "displayName": "Budget",
  "description": "Income and spending over data/budget.db, which agents read and record through the plugin's tools.",
  "main": "dist/index.mjs",
  "engines": { "daintree": ">=0.39.0" },
  "mcpName": "budget",
  "capabilities": [
    "fs:project-read",
    "fs:project-write",
    "agent:read",
    "agent:input",
    "mcp:expose"
  ],
  "contributes": {
    "commands": [
      {
        "id": "open",
        "title": "Open Budget",
        "description": "Open the budget panel.",
        "category": "Budget",
        "kind": "command",
        "danger": "safe",
        "requires": []
      },
      {
        "id": "export-csv",
        "title": "Export transactions as CSV",
        "description": "Write this month's transactions to exports/.",
        "category": "Budget",
        "kind": "command",
        "danger": "safe",
        "requires": ["fs:project-write"]
      }
    ],
    "panels": [
      {
        "id": "main",
        "name": "Budget",
        "iconId": "wallet",
        "color": "var(--theme-category-green)",
        "menu": [{ "actionId": "acme.budget.export-csv", "label": "Export as CSV…" }]
      }
    ],
    "views": [{ "id": "main", "componentPath": "dist/panel.js", "location": "panel" }],
    "databases": [
      {
        "id": "ledger",
        "description": "Transactions, categories and budgets.",
        "path": "data/budget.db"
      }
    ],
    "agentMcp": [
      {
        "id": "budget",
        "name": "Budget",
        "description": "Record transactions in this project's budget, with the category and sign checked.",
        "mode": "tools"
      }
    ],
    "settings": [
      {
        "id": "currency",
        "type": "enum",
        "options": ["USD", "EUR", "GBP"],
        "default": "USD",
        "scope": "project",
        "label": "Currency"
      }
    ]
  }
}
```

Your `open` command dispatches `panel.openPluginPanel` with `{ kind: host.panelKindId("main") }` — see [Patterns → Open your own panel from a command](./patterns.md#open-your-own-panel-from-a-command). `requires` names what each command actually uses: `[]` keeps `open` one click, where the plugin's write and agent capabilities would otherwise put a confirm dialog on every command, and the export declares the write it makes ([Keep commands one click](./patterns.md#keep-commands-one-click)). `mcp:expose` never raises a command to confirm.

## Choosing a store

Pick by the shape of the data and by who needs to read it, not by what is quickest to code.

| Store | Fits | Watch for |
| --- | --- | --- |
| **Markdown with YAML frontmatter**, one file per record | Documents a person reads and diffs: contacts, posts, recipes, wiki pages. Frontmatter for fields, body for prose. | Agents write YAML loosely (an unquoted `title: A: B` is invalid). Parse with [`parseFrontmatter`](./data-helpers.md#frontmatter) and show a bad file as a problem row, never a blank panel. |
| **One JSON file** | A small, whole-document model where order matters: a board, a roadmap, a seating plan. | Every edit rewrites the file, so conflicts are likelier. Fix the canonical formatting (`JSON.stringify(x, null, 2)` plus a newline) and say so in the contract, so rewrites produce no churn. |
| **JSON Lines**, one record per line | Append-only logs: habit check-ins, time entries, votes, events. | An agent's edit tool can leave the last line without its newline, so a blind append joins two records. Check the last byte before appending; [`parseJsonl`](./data-helpers.md#json-lines) reports bad lines instead of throwing. |
| **SQLite via [`host.db`](./host-api.md#db--host-managed-sqlite)** | Anything you query, total or page through: a ledger, stock movements, time sheets, analytics. Agents read through the host's database tools and write through yours, with the `sqlite3` CLI as the fallback. | A binary file does not merge. If several people change the data through git, keep the source of truth in text (CSV imports, Markdown) and treat the database as derived, or keep it out of git. |

Files are the default for a team: they diff, review and merge like code. Reach for SQLite when the panel or an agent needs `GROUP BY`, `SUM` or a date range over hundreds of rows. Mixing is fine: a wiki can keep pages in Markdown and a search index in a `local` database.

**Where the data lives.** A file store lives wherever your contract says, inside the project. A database declares its [location](./contribution-points.md#databases--shipped): `"project"` puts the file in the repository, where it travels with a clone and every agent can also reach it with `sqlite3` (needs `fs:project-write` and a first-use consent); `"local"` keeps it in this machine's plugin data directory, outside the repository, where agents reach it only through the plugin's tools — the database tools read it, and your own tools can write it. Use `local` for caches, indexes, per-user state and data that shouldn't travel with the repository; use `project` for data the team shares or an agent without tools must be able to edit. An installed plugin's `local` database is shared by every project; see [Installed plugins and shared data](./agent-extensions.md#installed-plugins-and-shared-data) before you let agents query it. Whether a project database is committed is the project's choice; gitignore it to keep data out of history.

## Giving agents tools

Agents reach a plugin's data three ways, and a good data plugin offers all three:

- **Reads through the database tools.** Declaring a database puts the host's `database_schema` and `database_query` on the plugin's MCP server, with no code: bounded, read-only SQL that never starts your plugin. Nothing to write.
- **Writes through your own tools.** An `agentMcp` endpoint with a small roster registered by [`host.mcp.registerTools`](./host-api.md#mcpregistertools) — `record_transaction`, `move_card` — puts your validation in front of every write: ids you mint, a split that must balance, a category that must exist, a remote API behind the data. Keep the roster small and specific; the host caps it at 16 tools.
- **Direct editing as the fallback.** Files or `sqlite3` under the rules in the plugin's `AGENTS.md`. Every agent has this, including one launched outside Daintree, before the plugin was turned on, or by a CLI Daintree can't hand servers to, so the contract still has to carry the recipes. A `local` database has no such fallback, since it isn't in the project; keep data an agent without tools must edit in a `project` database or in files.

Agents launched in Daintree see all of this as one server, `daintree-budget`, named by the manifest's [`mcpName`](./manifest.md#mcpname). It is off until the user turns the plugin's agent access to **Read only** (the database tools) or **Read and write** (yours as well) in Project settings → Plugins → Agent tools. Commit `.daintree/mcp.json` so everyone who opens the project, and trusts its plugins, starts with it on:

```json
{ "plugins": { "acme.budget": "read-write" } }
```

The tools reach agents launched from a Daintree terminal after the plugin has access, and a reload that changes what the plugin declares for agents — its capabilities, scopes, `agentMcp` endpoint, databases or `mcpName` — revokes them from running agents; relaunch the agent after either. [Agent extensions → Agent MCP endpoints](./agent-extensions.md#agent-mcp-endpoints) has the naming rule, the access setting, several data plugins side by side, installed-plugin data, and the checklist for [tools that don't show up in `/mcp`](./agent-extensions.md#tools-dont-show-up-in-mcp). `plugins/sample-project/acme.ledger` is a working data plugin with all three routes.

## Writing the data contract

Beyond the tools' own descriptions, the agent learns your data only from `AGENTS.md`, and an agent without the tools learns everything there. Write the plugin's contract as if for a capable new colleague who has never seen the panel:

- **Which tools to use**: the server (`daintree-budget`), which tool does what, and that the `sqlite3` or file recipes below are for an agent that doesn't have them.
- **Where the data is**, as paths relative to the project root, and what the source of truth is ("the database is the source of truth; the plugin's tools and `sqlite3` both write to it").
- **The schema**: every field, its type and format, which are required, and what empty looks like (`null`, `[]`, `""` — never omitted, if that is your rule). Dates as `YYYY-MM-DD` and how to get today's local date. Money as integer cents, with the sign convention spelled out.
- **Ids**: how to mint one (`"K-" + nextId`, then increment `nextId`), and that ids are never reused or renumbered.
- **Invariants and mappings**: which values must reference others, how to map the user's words onto them ("lunch", "dinner", "coffee" → `meals`), when to create a new category and when to ask.
- **Safe editing habits**: re-read right before editing, make targeted edits rather than regenerating the file, keep unknown fields, check it still parses, look before a bulk update or delete and report what changed.
- **Recipes**: a few worked examples. Use values that differ from the requests you will test with, or your test measures copy-paste rather than understanding.
- **How to answer questions**, not just how to make changes. Read-only questions are where agents slip: one asked "who do I follow up with this week?" and silently dropped a contact at the edge of the window. Give the exact query or command for common questions.
- **What the panel shows**, so an agent knows its change is visible and what a warning in the panel means.

The project's root `AGENTS.md` names the data, points at the contract by path, and repeats the three or four rules that matter most, so an agent that never opens the second file still gets them. A `CLAUDE.md` containing `@AGENTS.md` makes Claude Code read the same file.

**Put the rules in the data where you can.** For SQLite, write column comments inside `CREATE TABLE` — `database_schema` and `sqlite3 data/budget.db .schema` both print them, and one of the two is the first thing an agent runs. Enforce invariants with `CHECK` constraints and triggers that `RAISE(ABORT, '<what to do instead>')`, because the `sqlite3` CLI does not enforce foreign keys and the agent reads the message and corrects itself. Tell agents to leave `PRAGMA journal_mode`, `user_version` and the `_daintree_meta` table alone. More in [Host API → db](./host-api.md#db--host-managed-sqlite).

**Ship a script when the answer needs arithmetic.** Streaks, weekly totals, "due this week", stock on hand: agents reading raw data get these wrong. Put the calculation in a plain ESM module that both the worker and `scripts/<name>-report.mjs` import, and tell agents in the contract to run the script for those questions. The panel and the agent then report the same number.

**Worktrees split committed data.** Your plugin reads the project's main checkout (`host.pluginInfo.projectRoot`), and a `"project"` database resolves there too. An agent working in a linked worktree edits that worktree's copy of every committed file, which the panel never sees until it is merged. If agents should always edit the live data, say so and give them the path from the main checkout, which every worktree can compute: `"$(git rev-parse --path-format=absolute --git-common-dir)/.."`. For some apps (a CRM, a wiki) branch-local drafts are the right behaviour; decide, and write the decision down.

## Live refresh

Subscribe, then pull. The view subscribes to the worker's pushes, then asks for a snapshot; when the data changes the worker either pushes what changed or tells the view to pull again ([Subscribe, then pull](./patterns.md#subscribe-then-pull)). Which one depends on the data:

- **A keyed list the worker changes** — cards, contacts, transactions it records itself — is a synced collection: `createSyncedCollection` in the worker, `useSyncedCollection` in the view. Each change sends a delta, not the list ([Push deltas](./patterns.md#push-deltas-not-the-whole-state)).
- **A change the worker only hears about** — an agent's `sqlite3` session, a file an editor rewrote — is an invalidation: push a small "changed" message and have the view refetch with `useCachedHostChannel(…, { invalidateOn })`, which costs one refetch per burst however many pushes arrive.

A board or ledger with hundreds of rows renders in the kit's `DataTable` or `VirtualList`, never as a plain `.map` ([Large lists](./patterns.md#large-lists)).

For files, watch the **directory**, not the file. Agents, editors and `host.fs.writeFile` all save by writing a new file and renaming it over the old one, which a watch on the file itself can miss:

```js
const unwatch = await host.fs.watch([boardDir], reload, {
  debounceMs: 150, // one refresh for an agent's burst of edits
  allowMissing: true, // the folder may not exist yet, or be deleted and recreated by a branch switch
});
```

Add `recursive: true` for a nested data tree (keep it on your own data folder, never a whole worktree). Treat every callback as a hint: re-read, compare the revision with what you last loaded, and skip the push if nothing changed. That also absorbs your own writes, whose watch events can arrive before `writeFile` resolves. The limits, including Linux recursive-watch caveats, are in [What `host.fs` does not do](./host-api.md#what-hostfs-does-not-do).

For SQLite, `onDidChange` does it all. It fires for your own commits (`origin: "self"`) and for everything else (`"external"`): an agent's `sqlite3` session, a `git checkout` that replaces the file, a reset script. Changes that land within one 50 ms window arrive as one callback, and the view's `invalidateOn` collapses what is left into one refetch.

```js
let opening;
const db = () =>
  (opening ??= host.db
    .open("ledger", { migrations: MIGRATIONS, definitions: DEFINITIONS })
    .then((handle) => {
      handle.onDidChange(() => void host.postToPanel("changed", null));
      return handle;
    })
    .catch((err) => {
      opening = undefined; // let the next call ask again after a declined consent
      throw err;
    }));
```

Open it from the first handler that needs it, not inside `activate()`: the first open of a project database asks for consent, and an unanswered prompt would overrun activation. Read with plain `query` and `get` calls rather than a `transaction` — a transaction takes the write lock, and an agent's `sqlite3` write during a panel refresh then fails with "database is locked". Tell agents to retry on that message, or to run `sqlite3 -cmd ".timeout 5000" …` so the CLI waits.

Show errors in the panel rather than hiding them. Agents make mistakes: keep the last good state on screen under a banner saying the file is invalid and where (a kit `Callout` with `severity="error"`), list unreadable records as problem rows, and disable UI edits until the data parses again.

## Editing safely alongside agents

The panel and an agent can change the same data within the same second. Never write blind.

**Files: re-apply the user's intent to what is on disk now.** [`editFile`](./data-helpers.md#conflict-checked-edits) reads the file, runs your transform, writes with `expectedRevision`, and on a conflict re-reads and runs the transform again:

```js
import { editFile, updateFrontmatter } from "@daintreehq/plugin-sdk/data";

// A drag in the panel: change one key, keep everything the agent just wrote.
await editFile(host, contactPath, (text) => text && updateFrontmatter(text, { stage: "won" }));
```

The transform may run more than once, so compute from its argument, never from state it mutates. `updateFrontmatter` rewrites only the keys you name, so an agent's new log line in the body survives a stage change made a moment later. The import works in a zero-build worker with no install ([No install needed in a worker](./data-helpers.md#no-install-needed-in-a-worker)). A bundled worker imports the same entry from the npm SDK, `@daintreehq/plugin-sdk/data`. Not in the 0.1.0 release on npm; it ships in the next one.

**When the edit cannot be re-applied** — the user is editing a note's text in the panel — keep the revision you loaded (`host.fs.readFileWithRevision`), write with `expectedRevision`, and on `REVISION_MISMATCH` stop and show a conflict: "changed on disk — reload, or keep yours". The error's `currentRevision` identifies the version on disk; re-read the file to show its contents. Hand the conflict to the view as a handler result (`{ conflict: true, theirs, yours }`) rather than a thrown error, so the view can offer the choice without parsing an error message. Creating a file uses `expectedRevision: null`, so an agent that created it first wins and you load theirs. Appends to a log go through `host.fs.appendFile`, which adds to the end instead of rewriting the file, so it can't overwrite an agent's lines. It is not a lock: end every record with a newline, and expect a concurrent writer's lines to interleave with yours.

**SQLite:** each `run` is one statement and the handle serialises your calls — the panel's handlers and your agent tools alike, since both run in your worker. Use `transaction` for a multi-row write and keep it short. Integrity lives in the schema, so the same `CHECK` and trigger that stops an agent's bad write stops yours.

## Handing work to agents

The other direction: the user picks up a card, a message or a row and gives it to an agent. Two routes, one destination — the agent's draft, where the user types the instruction and presses Enter. Nothing is ever submitted for them.

- **Drag.** Mark the element draggable and put the `application/x-daintree-agent-context` payload on the drag. No worker code and no capability. [Views → Handing work to an agent by drag](./views.md#handing-work-to-an-agent-by-drag) has the payload and a zero-build example.
- **Send to agent…** from a card menu item or button: it calls a worker handler that calls `host.sendToAgent(text, { title, worktreeId })` (`agent:input`). The user picks an agent from a list grouped by worktree, or starts one here or in a new worktree. `host.agents.list()` (`agent:read`) gives you the panes for your own shortlist. See [`sendToAgent`](./host-api.md#sendtoagent--hand-work-to-an-agents-draft).

Build the text in the worker from the data on disk, not from what the view sends, so it is current. Make it a self-contained brief: the id, the fields that matter, the plugin's tools to use, and the absolute path of the data file and the contract. Leave the instruction out; the user writes that. The block arrives fenced as `daintree-context` and stays literal, so tell agents in the contract what such a block is ("a block headed `Kanban: K-…` is a card handed to you; when the work is done, move it to Review"), rather than packing conventions into every hand-off.

Report the result as it is. `drafted` means the text is in that agent's input box, not that anyone is working on it — there is no signal when the user presses Enter, so don't mark the card in progress. `cancelled` needs nothing. For `refused`, the user has already been told about reasons that concern their agent; tell them yourself about the others (`prompt-open`, `busy`, `project-unavailable`).

## Settings without sprawl

Daintree gives each plugin's settings one home — Project settings → Plugins for a project plugin — and the host draws everything around it. Your job is to declare them well and send the user there, never to build a settings screen into the panel.

- **Declare the scope once.** `project` for choices the team shares (a file in the repository, under `.daintree/plugin-settings/`), `local` for this machine only (the user's own name, a local path). `user` is shared across every project only for an installed plugin; a project plugin's `user` file is per project too, so prefer `local` for its personal values. `host.settings.get`, `set` and `onDidChange` default to the declared scope, and `get` returns the declared `default` while nothing is stored ([contribution points → Settings schema](./contribution-points.md#settings-schema--shipped)).
- **Secrets** are `type: "secret"`: stored in the OS keychain, never in the repository, never with a default. Never put a credential in `host.storage`, a database or a data file.
- **Required** keys drive the host's "<Plugin> needs setup" strip above every panel, with an **Open plugin settings** button. Mark only what the whole plugin can't work without: the strip is plugin-wide, so a key only one feature needs is better left optional, with that feature disabled behind an inline link. `host.settings.missingRequired()` tells you which are unset.
- **Deep links.** `host.settings.open(key)` lands on the field and highlights it — the "Add publishing key" link next to a disabled Publish button. Your panels' ⋯ menu already has **Plugin settings…**.
- **What a field can't edit** — a per-channel table, a sign-in, a connection test — goes in a [`location: "settings"` view](./views.md#a-settings-section), rendered as rows in the same home. Declare the backing setting `editor: "view"` so the generated form doesn't show it twice.
- **Agents read settings, they never write them.** A `project` setting is a JSON file in the repository, so the contract can tell an agent where to read the default channel. Changes go through the settings form, which the user owns: `onDidChange` only fires for writes made through Daintree, and `local` and secret values are not in the repository at all.

## Backup and export

- **Back up data…** is on every panel of a plugin that declares a database, with no code from you. It snapshots each existing database safely and asks the user where to put it ([Databases](./contribution-points.md#databases--shipped)).
- **`db.backup(destPath)`** does the same from code — a copy into a sync folder, a snapshot before a destructive import. Hand a sync folder a copy, never the live file.
- **Your own menu items.** `contributes.panels[].menu` puts up to five of your actions on the panel's ⋯ and right-click menus — Export as CSV…, Import…, Archive done cards — each dispatched with `{ panelId }` ([Panel menu](./contribution-points.md#panel-menu)). There is no save dialog in the plugin API: write exports to a folder your plugin owns (`exports/` in the project, or your plugin data directory) and show it with `host.system.showItemInFolder(path)`.
- **Documents.** `host.documents.renderPdf` turns an HTML template into a PDF — invoices, quotes, reports — with no dependency in the plugin ([Export a document](./patterns.md#export-a-document)). An agent can write the HTML and the worker render it.

A file store is already backed up by git; the menu items are for getting data out in the shape someone else needs.

## Looking native

Link-only, because [Views](./views.md) is the reference:

- Draw with the [UI kit](./views.md#host-ui-components), `@daintreehq/plugin-ui`: `DataTable` for the ledger, `ListRow`s in a `VirtualList` for the contacts, `PaneHeader` and `Toolbar` for the chrome, `Select`, `Input` and `FormField` for the edit form, `ConfirmDialog` before a delete, `formatTimeAgo` and `useNow` for "edited 5m ago". It is served to a zero-build view with no install and draws exactly like the app's own panels.
- An app-shaped panel icon (`wallet`, `kanban`, `calendar`, `users`, `chart-line`, `receipt` and more — the list is under [Panels](./contribution-points.md#panels--shipped)) and a `var(--theme-category-*)` colour.
- Tailwind with Daintree's tokens for the layout and anything the kit doesn't draw ([Styling](./views.md#styling)); stock palette classes compile to nothing.
- Render prose with the host's [`Markdown`](./views.md#host-ui-components) from `@daintreehq/plugin-ui` rather than shipping a renderer; pass the file's path as `basePath` so relative images and links work.
- Design the empty state (no data folder yet — offer to create it; `EmptyState` or `PaneState kind="empty"`), the error state (the last good data plus a `Callout`) and the waiting-for-consent state (`PaneState kind="loading"`), not just the happy path. Don't add a setup warning of your own: a missing `required` setting already puts the host's setup strip on every panel.

## Testing

Test four things: that the plugin loads, that its handlers and tools do the right thing, that an agent in Daintree uses the tools, and that an agent without them can use the data contract.

**It loads.** `npx daintree-plugin validate` in the plugin folder checks the manifest (the 0.1.0 CLI on npm predates `databases` and refuses a manifest that declares them; Not in the 0.1.0 release on npm; it ships in the next one); `npx daintree-plugin doctor <projectRoot>` checks that `main` and every view `componentPath` exist in the working tree, parse as ESM, are in the git index and are not git-ignored, and reports the trust and load state Daintree has recorded ([Development loop](./dev-loop.md#daintree-plugin-doctor-projectroot)). Those are working-tree and index checks, not a check of what was committed: staged-but-uncommitted output passes, and a tracked file whose committed copy is stale is not caught, so commit the rebuilt `dist/` with the source change.

**It is fast and looks native.** `npx daintree-plugin lint` in the plugin folder reads the view and worker source for the patterns that make a panel slow or foreign — whole-list pushes, per-event renders, polling in the view, hand-rolled controls, stock colours — and names the fix for each. Not in the 0.1.0 release on npm; it ships in the next one. Then open the panel over a realistic amount of data (a year of transactions, not five) and read the plugin's Performance section in Project settings → Plugins ([Measuring your plugin](./views.md#measuring-your-plugin)).

**The handlers work.** Drive `activate()` with the mock host from `@daintreehq/plugin-sdk/testing`, and call handlers exactly as the host does, context first: `handler(ctx, args)`. A zero-build plugin can keep a `package.json` beside it for test tooling, minding that an installed SDK takes precedence over the app's copy at runtime ([Testing a raw-ESM project plugin](./dev-loop.md#testing-a-raw-esm-project-plugin)). The mock's `databases` option and agent-pane drivers are Not in the 0.1.0 release on npm; it ships in the next one. Worth covering:

- Seed files with `host.fs.writeFile`, then fire `simulateFsWatch` and assert a push. With `debounceMs`, use fake timers.
- Pass `databases: { directory }` and the mock's `host.db` is real SQLite at `<directory>/<id>.db`, running the host's own handle code, so migrations and triggers run for real. Write to that file from the test with `node:sqlite` or the `sqlite3` CLI to stand in for an agent, then wait for the once-a-second change poll and assert the `changed` push.
- A conflict: change the file between your handler's read and write and check the edit is re-applied, not lost.
- Malformed data: an invalid JSON board, bad frontmatter, a truncated JSONL line. The snapshot should report it, not throw.
- Your agent tools: the mock records each roster in `host.registeredMcpTools`; call a tool's `execute` with the arguments an agent would send and a `caller`, and check a write that breaks a rule is refused with a message saying what to do instead. `plugins/sample-project/acme.ledger/__tests__/` does this for its roster.

[Testing against a mock host](./host-api.md#testing-against-a-mock-host) lists what the mock doesn't model (consent, containment, the manifest gates).

**The tools work, in Daintree.** This is the test that matters most, and only a real agent can run it. Open the project in Daintree, trust its plugins, set the plugin's agent access to **Read and write** (or let `.daintree/mcp.json` do it), and only then start an agent in a Daintree terminal. Check that `/mcp` (or the CLI's own list) shows `daintree-budget` with the database tools and yours, then make requests phrased the way a user would say them — never describing the format or naming a tool:

```text
Track a coffee with Sam this morning, $4.80 on my card
How much have I spent on groceries this month?
```

Check that the agent read through `database_query`, wrote through your tool, and that the panel updated while it did. If the server is missing, work through [Tools don't show up in `/mcp`](./agent-extensions.md#tools-dont-show-up-in-mcp); an agent started before access was on never gets it.

**The fallback works.** Agents launched outside Daintree are never handed the plugin's server, so a headless run tests the contract alone — which is what an agent without the tools relies on. In a scratch clone of the project, run each agent headlessly with the same kind of request, then check the data:

```sh
git clone ~/work/budget /tmp/budget-trial && cd /tmp/budget-trial
claude "Track a coffee with Sam this morning, \$4.80 on my card"
codex "How much have I spent on groceries this month?"
sqlite3 data/budget.db "SELECT * FROM transactions ORDER BY id DESC LIMIT 3;"
```

In both runs, try each agent you expect people to use, since they read tools and contracts differently. Include read-only questions and one arithmetic question (does the agent use your script?), an ambiguous request (does it ask, or guess sensibly?), and a request in a linked worktree if your contract has worktree rules. When an agent gets something wrong, fix the contract or the tool's description, not the prompt. Approve the agent's steps as it goes; that is also how you see what it tried. Run agents unattended (their skip-permission or no-sandbox modes) only inside a disposable VM or container, never on your own machine: a scratch clone isolates the data, not the agent. Agents also read the operator's own global instructions, so a run is not fully hermetic.

## Checklist

- [ ] The store fits the data: files for documents a team diffs, SQLite for queries and totals; `project` for data the team shares, `local` for caches and data that shouldn't travel with the repository.
- [ ] Agents get tools: a declared database for reads, an `agentMcp` endpoint (`mcp:expose`) for writes with rules, a short `mcpName`, and `.daintree/mcp.json` turning the plugin on for the project.
- [ ] An installed plugin with per-project data scopes its own tools by `caller.projectId` rather than relying on the database tools.
- [ ] The plugin's `AGENTS.md` names the tools and when to use them, then covers paths, schema, ids, invariants, safe-editing habits, recipes with non-test values, and how to answer common questions for an agent without them.
- [ ] The root `AGENTS.md` points at it and repeats the key rules; `CLAUDE.md` imports it.
- [ ] Arithmetic answers come from a script that shares the panel's code.
- [ ] The contract says what agents in a linked worktree should do.
- [ ] For SQLite: rules in `CHECK` constraints and triggers, column comments in `CREATE TABLE`, the database opened lazily, reads outside transactions.
- [ ] Live refresh: a debounced directory watch with `allowMissing`, or `db.onDidChange`; revision compare to skip no-op pushes; the view subscribes before it pulls, and gets deltas (`createSyncedCollection`) or one refetch per burst (`invalidateOn`), never the whole list per change.
- [ ] Every UI write goes through `editFile`, `expectedRevision`, `appendFile` or a transaction; a conflict the panel can't re-apply is shown, not overwritten.
- [ ] Invalid or partial data shows as an error row or banner with the last good state.
- [ ] Records can be dragged to an agent and sent with **Send to agent…**; the hand-off is a self-contained brief with no instruction; results are reported honestly.
- [ ] Settings declared with the right scope; secrets as `type: "secret"`; `required` only for what the whole plugin needs; setup reached through `host.settings.open`; no settings UI in the panel.
- [ ] Export paths and menu items in place (`menu`, `renderPdf`, `db.backup` as needed).
- [ ] App-shaped icon; kit components for controls, lists, tables, dialogs and states; token-only styling for the rest; host `Markdown` for prose; designed empty and error states; any long list virtualised.
- [ ] `daintree-plugin lint` is clean (not in the 0.1.0 CLI on npm; skip it until the next release), and the Performance section looked at with realistic data.
- [ ] `open` command opens the panel; commands that don't write declare `"requires": []`.
- [ ] Handlers and tools tested against the mock host; the tools tested with real agents launched in Daintree after access was on; the contract tested headlessly in a scratch clone; the panel watched updating live in Daintree.
