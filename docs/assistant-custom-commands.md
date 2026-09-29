# Assistant custom commands and skills

Users can add their own slash commands, skills, instructions, reference files and — from their own folder only, behind an opt-in — MCP servers and Claude hooks to Daintree Assistant sessions by dropping files into a Daintree-owned folder. At every assistant launch, `HelpSessionService.doProvision` mirrors that content into the per-project session directory (`userData/help-sessions/<projectPathHash>/`), where the launched CLI discovers it through its own native cwd-scoped mechanisms. Daintree never touches agent config outside its own directories (`~/.claude/`, `~/.codex/`, etc. stay user-owned — precedent #4100).

This is also the assistant-only isolation boundary: ordinary agent terminals run with the real project or worktree as their cwd, so they never discover anything under `.daintree/assistant` or the private session copy. A project can therefore define skills that exist only for its Daintree Assistant.

## Source folders

| Scope | Path | Notes |
| --- | --- | --- |
| Global | `~/.daintree/assistant/` | Applies to every project. Scaffolded with a README by the "Open Assistant Commands Folder" action (palette, or Settings → Daintree Assistant → Custom commands and skills). |
| Per-project | `<project>/.daintree/assistant/` | Overrides global. Intentionally git-trackable, like `.daintree/recipes/`. |

Inside each source folder the layout uses agent-native hidden directories:

```
~/.daintree/assistant/
  .claude/commands/<name>.md        Claude Code slash commands
  .claude/skills/<name>/SKILL.md    Claude-only skills
  .codex/skills/<name>/SKILL.md     Codex-only skills
  .agents/skills/<name>/SKILL.md    Shared skills (Agent Skills convention)
```

Every skill directory must contain a `SKILL.md` (Agent Skills shape: `name` + `description` frontmatter). A skill directory without one is invalid: it is logged, skipped, and never shadows a valid lower-precedence skill of the same name.

Beside those, each source folder may hold:

```
instructions.md                     Added to the assistant's instructions (both scopes)
reference/**                        Any files, mirrored to <session>/reference/ (both scopes)
mcp.json                            { "mcpServers": { … } } — global folder only, opt-in
hooks.json                          { "hooks": { … } } — Claude hooks, global folder only, opt-in
```

## Trust tiers

The session dir is the launched CLI's cwd, and several files there are configuration rather than content: `.claude/settings.json` (hooks run shell commands, permission rules), `.mcp.json` (servers spawn processes), `CLAUDE.md`/`AGENTS.md` (the assistant's own prompt). So nothing is copied wholesale — each lane is allowlisted, and what a lane may contribute depends on who writes the folder. The project folder is committed to the repository, so it is written by whoever authored the repo; opening the assistant in a cloned repo must never run that repo's code.

| Tier | Content | Global `~/.daintree/assistant` | Project `.daintree/assistant` |
| --- | --- | --- | --- |
| Text the model reads | commands, skills, `instructions.md`, `reference/` | Yes | Yes |
| Runs programs | `mcp.json`, `hooks.json` | Only with **Settings → Daintree Assistant → Load my MCP servers and hooks** (`helpAssistant.loadGlobalHooksAndServers`, default off) | Never — ignored with a logged warning |
| Replaces Daintree's session | settings, permissions, `CLAUDE.md`/`AGENTS.md`, `.mcp.json`, anything else | Never | Never |

Text-tier content is instructions, not authorization: everything it leads to still passes MCP tiering and action confirmation. That includes the project's own skills and commands: Claude registers a skill's frontmatter `hooks` while the skill is active, and `allowed-tools` pre-approves tools without a prompt, so both keys (and `allowed_tools`) are stripped from project-scope `SKILL.md` and command files on copy — the rest of the file arrives intact. A project file whose frontmatter can't be parsed is left out rather than copied unexamined. The user's own global skills are copied byte for byte. `AssistantUserConfig.ts` reads the non-mirrored lanes; the file lanes stay in `AssistantContentMirror.ts`.

### Instructions

`instructions.md` (64 KB cap per scope) is appended to the session's `CLAUDE.md` and `AGENTS.md` in a managed `DAINTREE_USER_INSTRUCTIONS` block after Daintree's prompt and the scratch note — global first, then project, the project section labelled as repository conventions rather than the user speaking. The block is rewritten on every provision, so edits and deletions take effect on the next launch. A project `instructions.md` that is a symlink resolving outside the project is refused: it would otherwise inline an arbitrary local file into the prompt sent to the model provider.

`AGENTS.md` is budgeted. Codex truncates project instructions past 32 KiB without telling the model, and the bundled file already uses ~24 KiB. When the inline block would push `AGENTS.md` past 31 KiB, the instructions go to a sidecar in the session dir instead, and the block tells the agent to read it first. The sidecar is named by content hash (`assistant-instructions-<sha12>.md`) and written before the pointer to it, because every lane of a project shares the session dir: a sibling lane re-provisioning with different instructions must not change or delete the file a live lane's agent was told to read. Old sidecars are retired only when no other lane of the project is live or mid-provision (a lane holds its `provisionLocks` entry from before its pointer is published until its session record is registered). `CLAUDE.md` is always inline. While there are instructions to deliver, both prompt files are required — if one is missing from the session dir (the template hash gate won't restore it), the provision fails closed rather than launching without them.

### Reference files

`reference/**` is mirrored for Claude, Codex and Copilot through the same manifest machinery as skills (per-file precedence, project over global; any file type), and the instructions block tells the agent the folder exists. In the project source, links whose real path leaves the project (a file, a directory, or `reference/` itself) are skipped with a warning: a mirrored copy is a regular file inside the session cwd, which Claude's `@path` imports load without the external-import prompt. Links out of the global folder are followed as before.

### MCP servers and hooks

With the opt-in on, `mcp.json` servers (stdio `command`/`args`/`env`/`cwd`, or `http`/`sse` `url`/`headers`) are added beside Daintree's own: into the Claude per-lane `--mcp-config` file, Copilot's session `.mcp.json`, and Codex's `-c mcp_servers.assistant-<name>.…` overrides. Codex gets the `assistant-` prefix because `-c` overrides merge per key: reusing a name from the user's own Codex config would inherit fields this entry doesn't set, such as `bearer_token_env_var`, and send that credential to a different URL. The user's `$CODEX_HOME/config.toml` is read passively and a server whose prefixed name already exists there is skipped; if that file exists but can't be parsed, no user servers are passed to Codex at all. Codex has no SSE transport, so SSE entries are skipped for it, and user servers share a budget of launch arguments (Windows caps the whole command line, and the launch path quotes and may Base64-encode it), estimated with quote-like and astral characters counted double; servers past it are skipped with a warning. Values are validated before any encoding: URLs must parse with a host, header values can't contain line breaks, lone surrogates are rejected, and `__proto__`-style keys are refused. The names `daintree`, `daintree-docs` and `daintree-runbooks` are reserved. An invalid server is dropped with a warning and the rest still load. `hooks.json` becomes the `hooks` key of the session's Claude `settings.json` — the only key a user file contributes — and is assigned fresh each provision, so turning the setting off retires it. Provisioning any other agent strips `hooks` from that file, because it survives in the shared session dir and Copilot also reads hooks from it. Unlike servers, an opted-in `hooks.json` that can't be parsed fails the provision closed, and the nested shape (string `matcher`, non-empty `hooks` list, string `type`, a `command` for command hooks, numeric `timeout`) is validated up front: a hook may be a guard, and Claude rejects the whole settings file — Daintree's deny rules included — over one malformed hook. Handler types are checked against the ones Claude accepts (`command`, `prompt`, `agent`, `http`) with each one's required field, and known optional fields (`timeout`, `async`, `statusMessage`, `model`) must have the right type. `hooks.json` is read only when the agent is Claude, so a broken one never blocks a Codex or Copilot launch. HTTP hooks' `headers` must be a string map and `allowedEnvVars` a string array. All three files are decoded as strict UTF-8 (a leading BOM is allowed) through the handle whose type, size and — for a project `instructions.md` — containment were checked.

## Per-agent mapping

`AssistantContentMirror.ts` maps source trees into the session dir per agent (`AGENT_CONTENT_MAPPINGS`):

| Agent | Mirrored into session dir | Why |
| --- | --- | --- |
| `claude` | `.claude/commands`, `.claude/skills`, `.agents/skills` translated → `.claude/skills`, and `reference` | Claude Code treats a non-git cwd as the project root and loads both from it, but declined native `.agents/skills` support (anthropics/claude-code#56193), so shared skills are copied into `.claude/skills`. An explicit `.claude/skills/<name>` replaces the translated shared skill of the same name wholesale — skills resolve at directory granularity, never a per-file merge of two skills. |
| `codex` | `.agents/skills` verbatim, `.codex/skills` translated → `.agents/skills`, and `reference` | Codex removed custom prompt files in 0.118.0; skills are the only mechanism. `<cwd>/.agents/skills` loads without a git repo and is exempt from the project-config trust gate. `.codex/skills` is a Daintree-owned SOURCE convention for Codex-only skills — it is delivered through the session's `.agents/skills` and never mirrored to a `.codex` destination, because `<cwd>/.codex` rides the trust-gated project-config layer. An explicit `.codex/skills/<name>` replaces the shared skill of the same name wholesale. |
| `copilot` | `.agents/skills`, `.claude/skills` and `reference` verbatim | Copilot CLI reads both conventions from cwd. |
| `daintree-assistant` | nothing | Currently retired as an assistant backend. Runs in the project root and reads nothing from cwd; it will read the source folders natively when its own skill loader grows user paths. It receives no instructions, reference files, MCP servers or hooks either. |
| `gemini` | nothing | Deprecated as an assistant backend; cannot provision a help session. |

Precedence, lowest to highest: global `.agents/skills` → global explicit tree (`.claude/skills` or `.codex/skills`) → project `.agents/skills` → project explicit tree. Commands resolve per file; skills resolve per skill directory (a higher-precedence skill drops every file of the shadowed one). Deleting a higher-precedence override reveals the shadowed definition again on the next provision.

## Sync mechanics

- Runs inside `doProvision` after the hash-gated template copy, unconditionally (user content changes independently of app version). A provision happens before every new backend process: first launch, new session/reset, backend switch, resume after hibernation or eviction, and app restart. Showing or hiding the panel while the process stays alive does not re-sync (Codex only discovers skills at process startup anyway).
- Failure policy is asymmetric on purpose. Invalid or unwritable NEW content is safely omitted — the assistant launches without it and the reason is logged. But content that would run STALE fails the provision closed: an unreadable source directory (the desired state can't be proven, so previously mirrored skills must not be retired or trusted) or a managed file that should be gone yet is still on disk. In that case `HelpSessionService` throws a typed `USER_CONTENT_SYNC_FAILED` error, the backend does not launch, and the HelpPanel shows an inline retryable error banner.
- Manifest-driven: `.daintree-user-content.json` in the session dir records every mirrored relpath. Files that disappear from the source are deleted on the next sync; files the user hand-placed in the session dir are never touched. Deletion is confined to the four mirror destination roots (`.claude/commands`, `.claude/skills`, `.agents/skills`, `reference`) even with a corrupt manifest: relpaths with dot segments, backslashes, or drive colons are rejected, and every existing directory component is `lstat`-verified non-symlink before any delete or copy (agents spawned in the session dir can write to it, so a planted `.claude/skills → elsewhere` symlink must not redirect the mirror). `.codex/skills` is a source-only convention and is deliberately not a deletion root.
- The manifest is written after deletions but before copies, holding the union of desired and unremoved stale paths — a mid-copy crash leaves it as a superset, and stragglers get cleaned on the next sync. Because every copied path is manifested before its copy starts, no crash point can produce an on-disk managed file the manifest doesn't own; a final verification pass then confirms stale paths are gone and desired paths are regular files. This superset-plus-verification design provides the same recovery guarantee as a separate pending-manifest scheme without a second recovery file.
- Walks follow symlinks (with realpath cycle detection), skip dot-entries, and cap at 2000 files / depth 12 / 5 MB per file with a logged warning on truncation. Oversized files are excluded before the manifest write, so a file that grows past the cap also gets its old session copy removed.
- Agent switching self-heals: re-provisioning the same project for codex removes files that were mirrored for claude (and vice versa), because the manifest cleanup spans all mirror roots.

## User-facing behavior notes

- Changes are picked up at the next assistant launch — a new backend process, not a hide/show of the panel. Claude Code additionally hot-reloads skills mid-session; Codex scans skills at startup only — provision-time mirroring stays authoritative and never depends on hot reload.
- Codex surfaces skills via `$skill-name` mentions and the `/skills` picker, not `/name` slash commands. Codex tolerates Claude-specific `SKILL.md` frontmatter keys (`argument-hint`, `allowed-tools`, …), so a shared skill can carry both.
- Claude sessions run under the bundled sandbox settings (`Write`/`Edit` denied), so the assistant itself can't author its skills — users author them in an editor or a regular agent terminal, then relaunch the assistant.
- Commands mirrored into `.claude/commands` automatically appear in the HelpPanel's slash autocomplete: `HybridInputBar` scans the terminal cwd (the session dir) via `SlashCommandService`.
- Skills are repository-controlled instructions, not authorization: they pass through the same MCP tiering and action confirmation as any other assistant input.
- Future OpenCode support slots into the same layout (`.opencode/commands`, plus it already reads `.claude/skills` and `.agents/skills`), with one caveat: OpenCode only discovers project content inside a git worktree, so the session dir would need a `git init` or marker tweak.

## Key files

- `electron/services/AssistantContentMirror.ts` — mapping table, walk, manifest sync, verification, folder scaffolding.
- `electron/services/AssistantUserConfig.ts` — `instructions.md`, and the opt-in `mcp.json` / `hooks.json` lane: validation, trust scoping, and the Claude/Copilot/Codex encodings.
- `electron/services/HelpSessionService.ts` — the `doProvision` call site, the fail-closed `USER_CONTENT_SYNC_FAILED` policy, the instructions block and `AGENTS.md` budget, and merging user servers and hooks into each backend's config.
- `electron/ipc/handlers/help.ts` — `help:open-assistant-content-folder` (scaffold + reveal).
- `src/services/actions/definitions/helpActions.ts` — `help.openCommandsFolder` action.
- `src/components/Settings/DaintreeAssistantSettingsTab.tsx` — the Custom commands and skills settings section.
- `src/components/HelpPanel/HelpPanelBanners.tsx` — the `skills-sync-failed` inline error banner.

## Known limits

- The containment check on a project `instructions.md` and `reference/` resolves real paths before opening; a process that swaps a parent directory between that check and the read could still redirect it (and Windows has no `O_NOFOLLOW`). Winning that race needs live write access to the project folder during provisioning, which is already local code execution, so it is out of scope.
- Claude slash commands may run `` !`cmd` `` lines when invoked. Those need Bash permission; with `allowed-tools` stripped, a project command can no longer pre-grant it, so the session's own permission settings decide — and with bypass permissions on, the user has already allowed the assistant to run commands.
