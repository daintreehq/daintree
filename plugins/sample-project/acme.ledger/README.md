# acme.ledger — agent MCP tools over project-owned data

The canonical example of `contributes.agentMcp`: a project plugin that serves a small tool roster to the agents running in this project's terminals, backed by a SQLite database that lives in the project. Zero build, hand-written ESM, no dependencies — the database is Node's built-in `node:sqlite`, which every Daintree plugin worker already has.

## How it fits together

- `plugin.json` declares one endpoint, `data`, under `contributes.agentMcp`, and the `mcp:expose` capability that endpoint requires.
- `dist/index.mjs` calls `host.mcp.registerTools("data", { … })` during `activate()`. The host owns everything else: the loopback route, the per-terminal credential, the project binding, enablement and revocation.
- The database is `<projectRoot>/.daintree/plugin-storage/acme.ledger/ledger.db`, created on the first tool call rather than at activation. `projectRoot` is the host's binding for this plugin instance (`host.pluginInfo.projectRoot`, the main worktree), so every worktree of the project shares one ledger. It sits beside the host's own project-scope `host.storage` files, in a directory named by the manifest id.

## The tools

| Tool | What it does |
| --- | --- |
| `list_transactions` | A page of transactions, newest first. Optional `from`/`to` (inclusive `YYYY-MM-DD`), `category`, `limit` (1-200, default 50) and `offset`. Returns `next_offset` when there is more, and trims a page that would come close to the host's result limit (`trimmed_for_size`). |
| `summarize_by_category` | Count and total per category, optionally within a date range. |
| `add_transaction` | Appends one row (`date`, `amount_cents`, `category`, optional `memo` of at most 280 characters) and returns the row as stored. Nothing is ever updated or deleted. |

Amounts are integer cents, negative for money out. Each row carries a separate `provenance` object — when it was recorded, the terminal id and the launch agent hint from the caller — which is what the plugin observed at write time, not an identity: the hint says how the terminal was launched, not who is calling. A row written by anything other than this plugin has `null` provenance.

## Turning it on

The endpoint is off until you turn it on in **Project settings → Plugins → Agent tools**. Trusting the project's plugins is not enough: exposing an endpoint to agents is a separate per-project decision, stored in Daintree's own settings and never in the repository. Once it is on, a Claude agent launched in that project gets the endpoint through the MCP config file Daintree writes for the launch (with its own credential for that terminal), and sees the three tools as `mcp__daintree-acme_ledger-data__<tool>` (the server key gains a hash suffix if it would collide with another enabled endpoint, such as an installed copy of the same plugin). Turning it off revokes live credentials immediately. Daintree's MCP HTTP listener must be enabled, and only Claude launches are wired today.

## What the plugin does for itself

The host checks only that a tool's arguments are a JSON object; it never validates them against `inputSchema`. So every tool rejects unknown arguments and checks each value itself — real calendar dates, bounded integers, a category grammar — and every query binds its values as parameters, never as SQL text.

Results stay well under the host's 256 KiB limit. Every text column is clipped in the query itself, so no single row can be large however the file was written — a memo longer than the plugin would ever write comes back cut short with `memo_truncated: true` — and pages are trimmed by size. SQLite integers are 64-bit, so any value past JavaScript's 2^53 comes back as a decimal string rather than a silently rounded number.

Memos are untrusted text. Anyone who can write the repository, and any agent that calls `add_transaction`, can put words in one, and an agent reading it later may take those words as instructions. The plugin returns memos only as data fields: tool descriptions are fixed strings, and nothing read from the database reaches one.

Each tool checks the abort signal before it starts, and the read tools check it again before returning. `node:sqlite` is synchronous, so a query already running finishes regardless. `add_transaction` checks only before writing; once the INSERT starts, the result reports the stored row. That does not make a cancelled write unambiguous: the host can give up on a call (timeout, cancel, session close) while the worker is still committing, and then discards the success. So the tool's description tells agents that a cancelled or timed-out call may still have stored its row, and to list before retrying. A project that needs retries to be safe would add a caller-supplied request key with a unique index.

If the plugin runtime has no `node:sqlite`, activation fails with a message saying so, and the endpoint serves no tools.

## The trust ceiling

`capabilities` are disclosure. `fs:project-write` is declared because this plugin writes a file into the project — but it writes it with `node:fs` and `node:sqlite` directly, not through `host.fs`, so no first-use consent prompt fires and the host's path containment never sees the path. `host.fs` carries UTF-8 text only and cannot hold a SQLite file, so there is no sanctioned route to take instead.

The plugin holds itself to the same rule — it refuses to open the ledger through a symlinked directory or file, so a committed link cannot redirect it outside the project — but that is the plugin's own code, not a boundary. A plugin worker is a full Node process with your account's privileges. Trusting a project's plugins means trusting everyone who can write to the repository, and what this sample promises extends exactly as far as its own source.

## Committing the database

Whether `ledger.db` is committed is the project's call. The plugin sets SQLite's rollback journal (`journal_mode = DELETE`) each time it opens the file, switching back if another tool left it in WAL mode, so between writes the database is a single file with no `-wal` or `-shm` sidecars. If another process is holding the file open in WAL mode, that switch cannot happen until it closes. To keep the database out of git, add `.daintree/plugin-storage/acme.ledger/` to the project's `.gitignore`.

## Limits

At most 8 tools per endpoint, names matching `^[a-z][a-z0-9_]{0,31}$`, descriptions up to 400 bytes, schemas that are plain `{ "type": "object" }` objects up to 8 KiB, results up to 256 KiB of JSON, and 60 seconds per call. The host rejects a roster that breaks any of these whole.

`engines.daintree` is `>=0.36.1` so development builds of this branch load it; a release without `agentMcp` rejects the manifest at the schema gate regardless of the range.
