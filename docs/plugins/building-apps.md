# Building an app as a plugin

A project plugin can stand in for a small SaaS product: an expense tracker, a CRM, a kanban board, a content calendar. The user asks an agent in a terminal to "track a $42 lunch with a client" or "move K-7 to review", the agent edits the data directly, and a panel shows the result a second later. This guide is how to build one. It assumes you have read the [agent brief](./agent-brief.md), which has the load rules and a zero-build skeleton, and it links to the reference docs rather than repeating them.

## The shape

Four parts, all in the project's repository:

```
<project>/
├── AGENTS.md                      # names the data and points at the contract
├── CLAUDE.md                      # "@AGENTS.md", so Claude Code reads the same file
├── data/budget.db                 # or board/board.json, crm/contacts/*.md, habits/log/*.jsonl
├── scripts/budget-report.mjs      # optional: numbers agents shouldn't work out by eye
└── .daintree/plugins/acme.budget/
    ├── plugin.json
    ├── AGENTS.md                  # the data contract
    └── dist/index.mjs, dist/panel.js
```

- **The data store** is the source of truth. Agents and the panel read and write the same files or the same SQLite database. There is no API in between unless you choose to add one.
- **The data contract** (`AGENTS.md` beside the plugin) is the only thing an agent knows about your data. It is the most important file in the plugin.
- **The panel** renders the data, refreshes live when an agent changes it, and lets the user edit it without clobbering the agent.
- **The plugin** is a thin worker around the store: handlers the view calls, a watch or change subscription, and the actions behind its commands and menus.

A trimmed manifest for a SQLite-backed app, which is valid as written:

```json
{
  "name": "acme.budget",
  "version": "0.1.0",
  "scope": "project",
  "displayName": "Budget",
  "description": "Income and spending over data/budget.db, which agents edit with the sqlite3 CLI.",
  "main": "dist/index.mjs",
  "engines": { "daintree": ">=0.39.0" },
  "capabilities": ["fs:project-read", "fs:project-write", "agent:read", "agent:input"],
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

Your `open` command dispatches `panel.openPluginPanel` with `{ kind: host.panelKindId("main") }` — see [Patterns → Open your own panel from a command](./patterns.md#open-your-own-panel-from-a-command). `requires` names what each command actually uses: `[]` keeps `open` one click, where the plugin's write and agent capabilities would otherwise put a confirm dialog on every command, and the export declares the write it makes ([Keep commands one click](./patterns.md#keep-commands-one-click)).

## Choosing a store

Pick by the shape of the data and by who needs to read it, not by what is quickest to code.

| Store | Fits | Watch for |
| --- | --- | --- |
| **Markdown with YAML frontmatter**, one file per record | Documents a person reads and diffs: contacts, posts, recipes, wiki pages. Frontmatter for fields, body for prose. | Agents write YAML loosely (an unquoted `title: A: B` is invalid). Parse with [`parseFrontmatter`](./data-helpers.md#frontmatter) and show a bad file as a problem row, never a blank panel. |
| **One JSON file** | A small, whole-document model where order matters: a board, a roadmap, a seating plan. | Every edit rewrites the file, so conflicts are likelier. Fix the canonical formatting (`JSON.stringify(x, null, 2)` plus a newline) and say so in the contract, so rewrites produce no churn. |
| **JSON Lines**, one record per line | Append-only logs: habit check-ins, time entries, votes, events. | An agent's edit tool can leave the last line without its newline, so a blind append joins two records. Check the last byte before appending; [`parseJsonl`](./data-helpers.md#json-lines) reports bad lines instead of throwing. |
| **SQLite via [`host.db`](./host-api.md#db--host-managed-sqlite)** | Anything you query, total or page through: a ledger, stock movements, time sheets, analytics. Agents use the `sqlite3` CLI. | A binary file does not merge. If several people change the data through git, keep the source of truth in text (CSV imports, Markdown) and treat the database as derived, or keep it out of git. |

Files are the default for a team: they diff, review and merge like code. Reach for SQLite when the panel or an agent needs `GROUP BY`, `SUM` or a date range over hundreds of rows. Mixing is fine: a wiki can keep pages in Markdown and a search index in a `local` database.

**Where the data lives.** A file store lives wherever your contract says, inside the project. A database declares its [location](./contribution-points.md#databases--shipped): `"project"` puts the file in the repository, where agents can reach it with `sqlite3` and it travels with a clone (needs `fs:project-write` and a first-use consent); `"local"` keeps it in this machine's plugin data directory, outside the repository, so agents working in the project won't find it. Use `local` for caches, indexes and per-user state; use `project` for anything an agent edits. Whether a project database is committed is the project's choice; gitignore it to keep data out of history.

**When not to let agents touch the data directly.** If a write needs validation you cannot express in a schema, or the data is really behind a remote API, serve agents a small tool set from an [agent MCP endpoint](./agent-extensions.md#agent-mcp-endpoints) instead. Direct editing is simpler and agents are good at it, so make that the default.

## Writing the data contract

The agent learns your data only from `AGENTS.md`. Write the plugin's contract as if for a capable new colleague who has never seen the panel:

- **Where the data is**, as paths relative to the project root, and what the source of truth is ("the database is the source of truth; there is no API").
- **The schema**: every field, its type and format, which are required, and what empty looks like (`null`, `[]`, `""` — never omitted, if that is your rule). Dates as `YYYY-MM-DD` and how to get today's local date. Money as integer cents, with the sign convention spelled out.
- **Ids**: how to mint one (`"K-" + nextId`, then increment `nextId`), and that ids are never reused or renumbered.
- **Invariants and mappings**: which values must reference others, how to map the user's words onto them ("lunch", "dinner", "coffee" → `meals`), when to create a new category and when to ask.
- **Safe editing habits**: re-read right before editing, make targeted edits rather than regenerating the file, keep unknown fields, check it still parses, look before a bulk update or delete and report what changed.
- **Recipes**: a few worked examples. Use values that differ from the requests you will test with, or your test measures copy-paste rather than understanding.
- **How to answer questions**, not just how to make changes. Read-only questions are where agents slip: one asked "who do I follow up with this week?" and silently dropped a contact at the edge of the window. Give the exact query or command for common questions.
- **What the panel shows**, so an agent knows its change is visible and what a warning in the panel means.

The project's root `AGENTS.md` names the data, points at the contract by path, and repeats the three or four rules that matter most, so an agent that never opens the second file still gets them. A `CLAUDE.md` containing `@AGENTS.md` makes Claude Code read the same file.

**Put the rules in the data where you can.** For SQLite, write column comments inside `CREATE TABLE` — `sqlite3 data/budget.db .schema` prints them, and it is the first thing an agent runs. Enforce invariants with `CHECK` constraints and triggers that `RAISE(ABORT, '<what to do instead>')`, because the `sqlite3` CLI does not enforce foreign keys and the agent reads the message and corrects itself. Tell agents to leave `PRAGMA journal_mode`, `user_version` and the `_daintree_meta` table alone. More in [Host API → db](./host-api.md#db--host-managed-sqlite).

**Ship a script when the answer needs arithmetic.** Streaks, weekly totals, "due this week", stock on hand: agents reading raw data get these wrong. Put the calculation in a plain ESM module that both the worker and `scripts/<name>-report.mjs` import, and tell agents in the contract to run the script for those questions. The panel and the agent then report the same number.

**Worktrees split committed data.** Your plugin reads the project's main checkout (`host.pluginInfo.projectRoot`), and a `"project"` database resolves there too. An agent working in a linked worktree edits that worktree's copy of every committed file, which the panel never sees until it is merged. If agents should always edit the live data, say so and give them the path from the main checkout, which every worktree can compute: `"$(git rev-parse --path-format=absolute --git-common-dir)/.."`. For some apps (a CRM, a wiki) branch-local drafts are the right behaviour; decide, and write the decision down.

## Live refresh

Pull on mount, then push. The view asks the worker for a snapshot when it mounts, and the worker tells it to pull again when the data changes ([Pull on mount, then push](./patterns.md#pull-on-mount-then-push)).

For files, watch the **directory**, not the file. Agents, editors and `host.fs.writeFile` all save by writing a new file and renaming it over the old one, which a watch on the file itself can miss:

```js
const unwatch = await host.fs.watch([boardDir], reload, {
  debounceMs: 150, // one refresh for an agent's burst of edits
  allowMissing: true, // the folder may not exist yet, or be deleted and recreated by a branch switch
});
```

Add `recursive: true` for a nested data tree (keep it on your own data folder, never a whole worktree). Treat every callback as a hint: re-read, compare the revision with what you last loaded, and skip the push if nothing changed. That also absorbs your own writes, whose watch events can arrive before `writeFile` resolves. The limits, including Linux recursive-watch caveats, are in [What `host.fs` does not do](./host-api.md#what-hostfs-does-not-do).

For SQLite, `onDidChange` does it all. It fires for your own commits (`origin: "self"`) and for everything else (`"external"`): an agent's `sqlite3` session, a `git checkout` that replaces the file, a reset script.

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

Show errors in the panel rather than hiding them. Agents make mistakes: keep the last good state on screen under a banner saying the file is invalid and where, list unreadable records as problem rows, and disable UI edits until the data parses again.

## Editing safely alongside agents

The panel and an agent can change the same data within the same second. Never write blind.

**Files: re-apply the user's intent to what is on disk now.** [`editFile`](./data-helpers.md#conflict-checked-edits) reads the file, runs your transform, writes with `expectedRevision`, and on a conflict re-reads and runs the transform again:

```js
import { editFile, updateFrontmatter } from "@daintreehq/plugin-sdk/data";

// A drag in the panel: change one key, keep everything the agent just wrote.
await editFile(host, contactPath, (text) => text && updateFrontmatter(text, { stage: "won" }));
```

The transform may run more than once, so compute from its argument, never from state it mutates. `updateFrontmatter` rewrites only the keys you name, so an agent's new log line in the body survives a stage change made a moment later. The import works in a zero-build worker with no install ([No install needed in a worker](./data-helpers.md#no-install-needed-in-a-worker)).

**When the edit cannot be re-applied** — the user is editing a note's text in the panel — keep the revision you loaded (`host.fs.readFileWithRevision`), write with `expectedRevision`, and on `REVISION_MISMATCH` stop and show a conflict: "changed on disk — reload, or keep yours". The error's `currentRevision` identifies the version on disk; re-read the file to show its contents. Hand the conflict to the view as a handler result (`{ conflict: true, theirs, yours }`) rather than a thrown error, so the view can offer the choice without parsing an error message. Creating a file uses `expectedRevision: null`, so an agent that created it first wins and you load theirs. Appends to a log go through `host.fs.appendFile`, which adds to the end instead of rewriting the file, so it can't overwrite an agent's lines. It is not a lock: end every record with a newline, and expect a concurrent writer's lines to interleave with yours.

**SQLite:** each `run` is one statement and the handle serialises your calls. Use `transaction` for a multi-row write and keep it short. Integrity lives in the schema, so the same `CHECK` and trigger that stops an agent's bad write stops yours.

## Handing work to agents

The other direction: the user picks up a card, a message or a row and gives it to an agent. Two routes, one destination — the agent's draft, where the user types the instruction and presses Enter. Nothing is ever submitted for them.

- **Drag.** Mark the element draggable and put the `application/x-daintree-agent-context` payload on the drag. No worker code and no capability. [Views → Handing work to an agent by drag](./views.md#handing-work-to-an-agent-by-drag) has the payload and a zero-build example.
- **Send to agent…** from a card menu item or button: it calls a worker handler that calls `host.sendToAgent(text, { title, worktreeId })` (`agent:input`). The user picks an agent from a list grouped by worktree, or starts one here or in a new worktree. `host.agents.list()` (`agent:read`) gives you the panes for your own shortlist. See [`sendToAgent`](./host-api.md#sendtoagent--hand-work-to-an-agents-draft).

Build the text in the worker from the data on disk, not from what the view sends, so it is current. Make it a self-contained brief: the id, the fields that matter, and the absolute path of the data file and the contract. Leave the instruction out; the user writes that. The block arrives fenced as `daintree-context` and stays literal, so tell agents in the contract what such a block is ("a block headed `Kanban: K-…` is a card handed to you; when the work is done, move it to Review"), rather than packing conventions into every hand-off.

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

- An app-shaped panel icon (`wallet`, `kanban`, `calendar`, `users`, `chart-line`, `receipt` and more — the list is under [Panels](./contribution-points.md#panels--shipped)) and a `var(--theme-category-*)` colour.
- Tailwind with Daintree's tokens only ([Styling](./views.md#styling)); stock palette classes compile to nothing.
- Render prose with the host's [`Markdown`](./views.md#host-ui-components) from `@daintreehq/plugin-ui` rather than shipping a renderer; pass the file's path as `basePath` so relative images and links work.
- Design the empty state (no data folder yet — offer to create it), the error state (the last good data plus a banner) and the waiting-for-consent state, not just the happy path.

## Testing

Test three things: that the plugin loads, that its handlers do the right thing, and that an agent can use the data contract.

**It loads.** `npx daintree-plugin validate` in the plugin folder checks the manifest; `npx daintree-plugin doctor <projectRoot>` checks the committed `dist/` and trust state ([Development loop](./dev-loop.md)).

**The handlers work.** Drive `activate()` with the mock host from `@daintreehq/plugin-sdk/testing`, and call handlers exactly as the host does, context first: `handler(ctx, args)`. A zero-build plugin can keep a `package.json` beside it for test tooling only ([Testing a raw-ESM project plugin](./dev-loop.md#testing-a-raw-esm-project-plugin)). Worth covering:

- Seed files with `host.fs.writeFile`, then fire `simulateFsWatch` and assert a push. With `debounceMs`, use fake timers.
- Pass `databases: { directory }` and the mock's `host.db` is real SQLite at `<directory>/<id>.db`, running the host's own handle code, so migrations and triggers run for real. Write to that file from the test with `node:sqlite` or the `sqlite3` CLI to stand in for an agent, then wait for the once-a-second change poll and assert the `changed` push.
- A conflict: change the file between your handler's read and write and check the edit is re-applied, not lost.
- Malformed data: an invalid JSON board, bad frontmatter, a truncated JSONL line. The snapshot should report it, not throw.

[Testing against a mock host](./host-api.md#testing-against-a-mock-host) lists what the mock doesn't model (consent, containment, the manifest gates).

**The contract works.** This is the test that matters most, and only a real agent can run it. In a scratch clone of the project, run each agent headlessly with a request phrased the way a user would say it — never describing the format — then check the data:

```sh
git clone ~/work/budget /tmp/budget-trial && cd /tmp/budget-trial
claude "Track a coffee with Sam this morning, \$4.80 on my card"
codex "How much have I spent on groceries this month?"
sqlite3 data/budget.db "SELECT * FROM transactions ORDER BY id DESC LIMIT 3;"
```

Try each agent you expect people to use, since they read contracts differently. Include read-only questions and one arithmetic question (does the agent use your script?), an ambiguous request (does it ask, or guess sensibly?), and a request in a linked worktree if your contract has worktree rules. When an agent gets something wrong, fix the contract, not the prompt. Approve the agent's steps as it goes; that is also how you see what it tried. Run agents unattended (their skip-permission or no-sandbox modes) only inside a disposable VM or container, never on your own machine: a scratch clone isolates the data, not the agent. Agents also read the operator's own global instructions, so a run is not fully hermetic. Finally, open the panel in Daintree and watch it update while an agent writes.

## Checklist

- [ ] The store fits the data: files for documents a team diffs, SQLite for queries and totals, `local` for anything agents never touch.
- [ ] The plugin's `AGENTS.md` covers paths, schema, ids, invariants, safe-editing habits, recipes with non-test values, and how to answer common questions.
- [ ] The root `AGENTS.md` points at it and repeats the key rules; `CLAUDE.md` imports it.
- [ ] Arithmetic answers come from a script that shares the panel's code.
- [ ] The contract says what agents in a linked worktree should do.
- [ ] For SQLite: rules in `CHECK` constraints and triggers, column comments in `CREATE TABLE`, the database opened lazily, reads outside transactions.
- [ ] Live refresh: a debounced directory watch with `allowMissing`, or `db.onDidChange`; revision compare to skip no-op pushes.
- [ ] Every UI write goes through `editFile`, `expectedRevision`, `appendFile` or a transaction; a conflict the panel can't re-apply is shown, not overwritten.
- [ ] Invalid or partial data shows as an error row or banner with the last good state.
- [ ] Records can be dragged to an agent and sent with **Send to agent…**; the hand-off is a self-contained brief with no instruction; results are reported honestly.
- [ ] Settings declared with the right scope; secrets as `type: "secret"`; `required` only for what the whole plugin needs; setup reached through `host.settings.open`; no settings UI in the panel.
- [ ] Export paths and menu items in place (`menu`, `renderPdf`, `db.backup` as needed).
- [ ] App-shaped icon, token-only styling, host `Markdown` for prose, designed empty and error states.
- [ ] `open` command opens the panel; commands that don't write declare `"requires": []`.
- [ ] Handlers tested against the mock host; the contract tested with real agents in a scratch clone; the panel watched updating live in Daintree.
