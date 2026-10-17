# acme.ledger — a database-backed plugin with agent tools

The reference sample for a data plugin: a project plugin that declares a SQLite database in `contributes.databases`, opens it through `host.db`, writes down an `AGENTS.md` contract for agents that edit it directly, declares the write one statement can express as a query the host serves, and serves agent tools (`contributes.agentMcp`) for the reads and the write that need code. Zero build, hand-written ESM, no dependencies.

## How it fits together

- `plugin.json` declares one database, `ledger`, under `contributes.databases`, with one write query, `add_transaction`, in its `queries`; and one endpoint, `data`, under `contributes.agentMcp`. `fs:project-write` is what a `"project"` database requires; `mcp:expose` is what the endpoint requires. The database alone also earns the host's read-only `@databases` endpoint, with neither a capability nor code.
- The database is `.daintree/data/acme.ledger/ledger.db` under the plugin's bound project root (`host.pluginInfo.projectRoot`, normally the main checkout) — the default location for a `"project"` database, so the declaration names no `path`. Every worktree of the project shares one ledger.
- `dist/index.mjs` calls `host.mcp.registerTools("data", { … })` during `activate()` and opens the database with `host.db.open("ledger", { migrations, definitions })` on the first tool call. The host owns the route, the per-terminal credential, the project binding, enablement and revocation, and — for the file — the path, containment, first-use consent, connection policy and running the migrations.
- [`AGENTS.md`](./AGENTS.md) is the data contract: where the file is, what each column holds, which rules the schema enforces and which it cannot, an example row, and what to leave alone. A project using this plugin points to it from its own root `AGENTS.md` or `CLAUDE.md`.

## The tools

| Tool | What it does |
| --- | --- |
| `list_transactions` | A page of transactions, newest first. Optional `from`/`to` (inclusive `YYYY-MM-DD`), `category`, `limit` (1-200, default 50) and `offset`. Returns `next_offset` when there is more, and trims a page that would come close to the host's result limit (`trimmed_for_size`). |
| `summarize_by_category` | Count and total per category, optionally within a date range. |
| `add_transaction` | Declared in `plugin.json` and run by the host: one `INSERT … RETURNING` of `date` (a day the calendar has), `amount_cents` (non-zero, at most 100,000,000,000 in magnitude), `category` (lowercased and trimmed of surrounding whitespace in SQL) and `memo` (`""` for none, at most 280 characters). Returns `changes`, `lastInsertRowid` and the stored row as `columns` and `rows`. |
| `add_split_transaction` | Records one payment split across 2-20 categories (`date`, `total_cents`, `splits`, optional `memo`) as one row per category sharing a split group. The parts must add up to `total_cents` exactly. |

Nothing is ever updated or deleted through the tools. Amounts are integer cents, negative for money out. Each row carries a separate `provenance` object — when it was recorded, the terminal id and the launch agent hint from the caller — which is what the writer observed at write time, not an identity: the hint says how the terminal was launched, not who is calling. `add_transaction` stamps the time in its statement, but a declared query never sees the caller, so its rows have no terminal or hint. A row written by anything else has `null` provenance.

## Declared write or tool?

A write one statement can express, whose rules the schema can hold, is a declared query: `add_transaction` is a single `INSERT`, and everything it must satisfy is a rule about one value, which its params declare, or a rule the triggers and `STRICT` columns hold for every row, so it needs no code, no `mcp:expose` and no running worker. The host binds the agent's values to the manifest's SQL, runs it in a transaction of its own, and serves it only with **Read and write** access. Reach for a tool when the write needs what one statement cannot give: `add_split_transaction` checks its parts against each other before any is written, writes several rows in one transaction, generates the group id, and stamps the calling terminal. The readers stay tools too, because their filters are optional and their pages are trimmed to the result budget; a declared query takes every param it names.

The host runs a declared write without starting the plugin, so the statement meets the triggers the file has when it is called. In a ledger an older version of this sample created, those are older rules — a date's shape but not the calendar, or no triggers at all in one copied over from before `host.db` — until one of the plugin's own tools opens it and the host brings them up to date. That is why `add_transaction`'s params declare each rule about a single value — a calendar date (`format: "date"`), a non-zero amount within ±100,000,000,000 cents, the category grammar, a memo of at most 280 characters — as JSON Schema the host checks before the statement runs, whatever the file holds. The triggers remain the rules for a row anyone writes, `sqlite3` included.

## Where each rule lives

Agents write this database with the `sqlite3` CLI as well as through the tools, so a rule enforced only in the plugin's code binds only the plugin. The sample puts each rule as close to the data as it can go:

- **The table** is `STRICT`, so a value that cannot be stored as its column's type — `-18.99` for an amount, `'twelve'` in an integer column — is refused outright.
- **Triggers**, in `definitions`, refuse what one row can prove wrong: a zero amount, a date not shaped `YYYY-MM-DD` or not on the calendar, a category outside the grammar, split columns set inconsistently. `add_transaction` runs no plugin code, so its params repeat the ones about a single value, which the host checks even against a file whose triggers predate them. Each `RAISE(ABORT, …)` message tells the agent what to write instead. A unique index keeps a category from appearing twice in one split.
- **The tool** enforces what no row can: that a split's parts add up to its total. A row trigger sees the first part before its siblings exist, and a JSON schema cannot sum an array. `add_split_transaction` checks the balance, a real calendar date and matching signs before writing, refuses an unbalanced split with the exact difference, and writes the parts in one `db.transaction`, so a split is stored whole or not at all.
- **An audit view**, `unbalanced_splits`, covers the rest: `AGENTS.md` tells an agent editing split rows by hand to check it comes back empty.

Views and triggers live in `definitions` rather than a migration because they change freely; the host re-applies the text whenever it differs from what the file last received. The table itself lives in `migrations`, which are append-only.

## Turning it on

The plugin's tools are off until you give it access in **Project settings → Plugins → Agent tools**. Trusting the project's plugins is not enough: exposing tools to agents is a separate per-project decision, stored in Daintree's own settings and never in the repository. **Read only** gives agents the host's `database_schema` and `database_query` tools for `ledger`; **Read and write** adds `add_transaction` and the `data` endpoint's tools. A project using this plugin can set a default for everyone who opens it with `.daintree/mcp.json` — `{ "plugins": { "acme.ledger": "read-write" } }` — and the user's own choice still wins. Once it has access, every agent launched in that project by a CLI Daintree can wire gets one server for it through that CLI's own launch mechanism, with its own credential for that terminal ([Reaching an agent](../../../docs/plugins/agent-extensions.md#reaching-an-agent)). The manifest's `mcpName` is `ledger`, so Claude sees the tools as `mcp__daintree-ledger__<tool>` in every project (an installed plugin with the same name keeps it, and this one gains a hash suffix). Reducing access revokes live credentials immediately. Daintree's MCP HTTP listener must be enabled.

The host serves the database tools and `add_transaction` with no code here. `database_schema` shows the ledger's tables, views and triggers, `database_query` runs one read-only statement against `ledger`, and `add_transaction` its one `INSERT`, always on the project root's file. The host answers them without starting the plugin, so a ledger none of the plugin's own tools has created yet reads as missing, and `add_transaction` fails with `DB_NOT_FOUND` rather than creating it.

The first tool call that opens the database raises the one-time `fs:project-write` consent prompt, which is why the plugin opens it lazily rather than in `activate()`: a prompt the user has not answered would run activation past its budget. A declined prompt fails that call, and the next call asks again.

## What the plugin does for itself

The host checks every call's arguments against the tool's `inputSchema` before `execute` runs, so each schema declares `additionalProperties: false` and its `required` fields. The tools still check each value themselves — real calendar dates a pattern cannot express, bounded integers, a category grammar, and the split balance — because a test can call `execute` directly, and every query binds its values as parameters, never as SQL text.

The readers' results stay well under the host's 256 KiB limit. Every text column is clipped in the query itself, so no single row can be large however the file was written — a memo past 4096 characters comes back cut short with `memo_truncated: true` — and pages are trimmed by size. `add_transaction` returns its row whole, as written; the host drops a returned row too large for the result (`truncated: true`), never the write. `host.db` returns an integer past JavaScript's 2^53 as a `bigint`, and the tools send it on as a decimal string rather than a silently rounded number.

Memos are untrusted text. Anyone who can write the repository, and any agent that calls a write tool, can put words in one, and an agent reading it later may take those words as instructions. The plugin returns memos only as data fields: tool descriptions are fixed strings, and nothing read from the database reaches one.

Each tool checks the abort signal before it starts, and again once the database is open. Queries are synchronous in the plugin's process, so one already running finishes regardless. `add_split_transaction` checks before writing, and once more inside its transaction, where a cancel rolls every part back. That does not make a cancelled write unambiguous: the host can give up on a call (timeout, cancel, session close) while the worker is still committing, and then discards the success. The same holds for `add_transaction`, which the host runs in a process of its own and kills on a cancel. So both writers' descriptions tell agents that a cancelled or timed-out call may still have stored its rows, and to list before retrying, and the host says so in its timeout message for a declared write. A project that needs retries to be safe would add a caller-supplied request key with a unique index.

## The trust ceiling

`host.db` resolves the file inside the project, refuses a symlinked file, a symlinked directory that leads out of the project, and a path inside `.git`, and asks for `fs:project-write` consent before creating anything — boundaries the host enforces, not promises the plugin makes. The queries themselves run in the plugin's own process. A plugin worker is still a full Node process with your account's privileges, so trusting a project's plugins means trusting everyone who can write to the repository.

## Committing the database

Whether `ledger.db` is committed is the project's call. The declaration keeps the default rollback journal (`journalMode: "delete"`), and the host sets it again on every writable open, so an agent that switched the file to WAL cannot leave committed rows in a `-wal` sidecar that a commit of `ledger.db` alone would miss. To keep the database out of git, add `.daintree/data/acme.ledger/` to the project's `.gitignore`.

Earlier versions of this sample kept the ledger at `.daintree/plugin-storage/acme.ledger/ledger.db`. Nothing moves it: the new location starts empty. To keep the old rows, copy it with SQLite's own backup before the first tool call — `mkdir -p .daintree/data/acme.ledger && sqlite3 .daintree/plugin-storage/acme.ledger/ledger.db ".backup .daintree/data/acme.ledger/ledger.db"` — rather than copying the file, which can miss rows still in a `-wal` sidecar. Its schema version is the first migration, so the host upgrades it in place the first time one of the plugin's own tools opens it. Until then the copy has no triggers at all, so call `list_transactions` once before anyone writes to it with `sqlite3`.

## Limits

At most 16 tools per endpoint, names matching `^[a-z][a-z0-9_]{0,31}$`, descriptions up to 400 bytes, schemas that are plain `{ "type": "object" }` objects up to 8 KiB, results up to 256 KiB of JSON, and 60 seconds per call. The host rejects a roster that breaks any of these whole.

`engines.daintree` is `>=0.39.0`, the first release with `host.db` and `contributes.databases`; a build without them, or without declared write queries, rejects the manifest at the schema gate regardless of the range.
