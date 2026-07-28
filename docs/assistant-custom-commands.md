# Assistant custom commands and skills

Users can add their own slash commands and skills to Daintree Assistant sessions by dropping files into a Daintree-owned folder. At every assistant launch, `HelpSessionService.doProvision` mirrors that content into the per-project session directory (`userData/help-sessions/<projectPathHash>/`), where the launched CLI discovers it through its own native cwd-scoped mechanisms. Daintree never touches agent config outside its own directories (`~/.claude/`, `~/.codex/`, etc. stay user-owned — precedent #4100).

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

## Per-agent mapping

`AssistantContentMirror.ts` maps source trees into the session dir per agent (`AGENT_CONTENT_MAPPINGS`):

| Agent | Mirrored into session dir | Why |
| --- | --- | --- |
| `claude` | `.claude/commands`, `.claude/skills`, and `.agents/skills` translated → `.claude/skills` | Claude Code treats a non-git cwd as the project root and loads both from it, but declined native `.agents/skills` support (anthropics/claude-code#56193), so shared skills are copied into `.claude/skills`. An explicit `.claude/skills/<name>` replaces the translated shared skill of the same name wholesale — skills resolve at directory granularity, never a per-file merge of two skills. |
| `codex` | `.agents/skills` verbatim, and `.codex/skills` translated → `.agents/skills` | Codex removed custom prompt files in 0.118.0; skills are the only mechanism. `<cwd>/.agents/skills` loads without a git repo and is exempt from the project-config trust gate. `.codex/skills` is a Daintree-owned SOURCE convention for Codex-only skills — it is delivered through the session's `.agents/skills` and never mirrored to a `.codex` destination, because `<cwd>/.codex` rides the trust-gated project-config layer. An explicit `.codex/skills/<name>` replaces the shared skill of the same name wholesale. |
| `copilot` | `.agents/skills` and `.claude/skills` verbatim | Copilot CLI reads both conventions from cwd. |
| `daintree-assistant` | nothing | Runs in the project root and reads nothing from cwd; it will read the source folders natively when its own skill loader grows user paths. |
| `gemini` | nothing | Deprecated as an assistant backend; cannot provision a help session. |

Precedence, lowest to highest: global `.agents/skills` → global explicit tree (`.claude/skills` or `.codex/skills`) → project `.agents/skills` → project explicit tree. Commands resolve per file; skills resolve per skill directory (a higher-precedence skill drops every file of the shadowed one). Deleting a higher-precedence override reveals the shadowed definition again on the next provision.

## Sync mechanics

- Runs inside `doProvision` after the hash-gated template copy, unconditionally (user content changes independently of app version). A provision happens before every new backend process: first launch, new session/reset, backend switch, resume after hibernation or eviction, and app restart. Showing or hiding the panel while the process stays alive does not re-sync (Codex only discovers skills at process startup anyway).
- Failure policy is asymmetric on purpose. Invalid or unwritable NEW content is safely omitted — the assistant launches without it and the reason is logged. But content that would run STALE fails the provision closed: an unreadable source directory (the desired state can't be proven, so previously mirrored skills must not be retired or trusted) or a managed file that should be gone yet is still on disk. In that case `HelpSessionService` throws a typed `USER_CONTENT_SYNC_FAILED` error, the backend does not launch, and the HelpPanel shows an inline retryable error banner.
- Manifest-driven: `.daintree-user-content.json` in the session dir records every mirrored relpath. Files that disappear from the source are deleted on the next sync; files the user hand-placed in the session dir are never touched. Deletion is confined to the three mirror destination roots (`.claude/commands`, `.claude/skills`, `.agents/skills`) even with a corrupt manifest: relpaths with dot segments, backslashes, or drive colons are rejected, and every existing directory component is `lstat`-verified non-symlink before any delete or copy (agents spawned in the session dir can write to it, so a planted `.claude/skills → elsewhere` symlink must not redirect the mirror). `.codex/skills` is a source-only convention and is deliberately not a deletion root.
- The manifest is written after deletions but before copies, holding the union of desired and unremoved stale paths — a mid-copy crash leaves it as a superset, and stragglers get cleaned on the next sync. Because every copied path is manifested before its copy starts, no crash point can produce an on-disk managed file the manifest doesn't own; a final verification pass then confirms stale paths are gone and desired paths are regular files. This superset-plus-verification design provides the same recovery guarantee as a separate pending-manifest scheme without a second recovery file.
- Walks follow symlinks (with realpath cycle detection), skip dot-entries, and cap at 2000 files / depth 12 / 5 MB per file with a logged warning on truncation. Oversized files are excluded before the manifest write, so a file that grows past the cap also gets its old session copy removed.
- Agent switching self-heals: re-provisioning the same project for codex removes files that were mirrored for claude (and vice versa), because the manifest cleanup spans all mirror roots.

## User-facing behavior notes

- Changes are picked up at the next assistant launch (every open re-provisions). Claude Code additionally hot-reloads skills mid-session; Codex scans skills at startup only — provision-time mirroring stays authoritative and never depends on hot reload.
- Codex surfaces skills via `$skill-name` mentions and the `/skills` picker, not `/name` slash commands. Codex tolerates Claude-specific `SKILL.md` frontmatter keys (`argument-hint`, `allowed-tools`, …), so a shared skill can carry both.
- Claude sessions run under the bundled sandbox settings (`Write`/`Edit` denied), so the assistant itself can't author its skills — users author them in an editor or a regular agent terminal, then relaunch the assistant.
- Commands mirrored into `.claude/commands` automatically appear in the HelpPanel's slash autocomplete: `HybridInputBar` scans the terminal cwd (the session dir) via `SlashCommandService`.
- Skills are repository-controlled instructions, not authorization: they pass through the same MCP tiering and action confirmation as any other assistant input.
- Future OpenCode support slots into the same layout (`.opencode/commands`, plus it already reads `.claude/skills` and `.agents/skills`), with one caveat: OpenCode only discovers project content inside a git worktree, so the session dir would need a `git init` or marker tweak.

## Key files

- `electron/services/AssistantContentMirror.ts` — mapping table, walk, manifest sync, verification, folder scaffolding.
- `electron/services/HelpSessionService.ts` — the `doProvision` call site and the fail-closed `USER_CONTENT_SYNC_FAILED` policy.
- `electron/ipc/handlers/help.ts` — `help:open-assistant-content-folder` (scaffold + reveal).
- `src/services/actions/definitions/helpActions.ts` — `help.openCommandsFolder` action.
- `src/components/Settings/DaintreeAssistantSettingsTab.tsx` — the Custom commands and skills settings section.
- `src/components/HelpPanel/HelpPanelBanners.tsx` — the `skills-sync-failed` inline error banner.
