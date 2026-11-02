# Continue Session

Carries a Codex session over to Claude Code, or a Claude Code session over to Codex, in the same worktree (#16097). A session file can run to hundreds of megabytes, far past any CLI's context window, so the new agent doesn't replay it: it starts with a short hand-off and searches the old conversation when it needs something.

An installed plugin, not a built-in one: `docs/feature-curation.md` removed Chat History Search from core, and this plugin answers to the plugin trust model instead. `scripts/build-main.mjs` compiles `main/` into `dist-electron/plugins/sample/continue-session/` beside its `plugin.json`, as it does for the other `plugins/sample/` packages; nothing under `plugins/sample/` ships in the app. Its name is outside the reserved `daintree.*` namespace, which only built-in plugins may use, so it can be installed as a package.

## Using it

1. Right-click a Codex or Claude Code pane and choose **Continue in another agent…**. The confirmation says what happens and what doesn't.
2. Daintree reads the session once, read-only, into a full-text index on this machine (`~/.daintree/plugin-data/daintreehq.continue-session/sessions/`). Progress and Cancel are in the background-work readout.
3. The other CLI starts in the same worktree and directory. Its first turn is the hand-off: the user's last five requests and the source agent's last message, quoted, plus how to search.
4. The new agent calls `search_converted` on the `daintree-continue-session` MCP server for anything else.

The search tool reaches an agent only where the plugin's agent tools are on (**Project settings → Plugins → Agent tools**, or once for every project), and the Daintree MCP server is enabled. With them off the agent still gets the hand-off and is told the tool is missing.

**Converted sessions…** on the project pill's right-click menu lists the project's converted sessions with their size on disk, starts a continuing agent again, deletes one or all of them, and turns sharing on or off.

## Scope

- **Session-only (default):** only the agent launched to continue a session can search it. The plugin checks the host's record of each call's terminal and project, never anything the agent sends.
- **Shared:** a project that shares its converted sessions lets every agent in it search them. Its agents can also search the sessions of every other project that shares; a project that doesn't share is never searched from outside.

## What it never does

- Write, move or rename a session file. It opens the exact path core observed (`terminal.sessionFile.get`), refuses a symlink or anything but a regular file, and reads up to the file's size at open.
- Guess a session file. When core answers `unknown`, nothing is read.
- Send anything off the machine. Indexing and search are local SQLite FTS5; what the continuing agent does with the hand-off and its search results is that agent's own traffic, which the confirmation says.
- Declare a `contributes.databases` entry: the host's generic database tools would serve every index to every agent with access, past the per-terminal check.

## Limits

- Codex and Claude Code only, on macOS and Linux, for local panes. A Claude Code session the CLI switched to by itself (`/clear`, a fork) isn't seen; core reports the session Daintree launched.
- Tool inputs and outputs are indexed up to 16,000 characters each, and records over 8 MB are skipped and counted.
- An index is deleted when its project is no longer registered, checked the next time the plugin converts a session or lists them: the plugin isn't told when a project is removed.
