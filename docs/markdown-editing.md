# Markdown editing

The file browser's **Edit** mode makes a Markdown file's source writable in place. It ships as the built-in plugin `daintree.markdown-editor` (`plugins/builtin/markdown-editor/`), so core stays read-only and every write goes through the plugin host's capability-gated, audited filesystem API. This page states the guarantees in the same words the UI uses.

## Where Edit appears

Edit joins the file browser’s Source / Rendered toggle (and the standalone file panel’s Source / Rendered / Diff toggle) for a file that has a `.md`, `.markdown` or `.mkd` extension (case-insensitive; `.mdx` is never offered), lives inside an open project or one of its worktrees, loaded as text (binary, oversized and LFS-pointer files are already excluded by the reader), is under 2 MiB, and while the Markdown editor plugin is enabled. The plugin is off by default. A themed notice below the file browser’s toolbar offers **Enable Markdown editor**; enabling it opens Edit in the same content area. When enabled, **Edit** is a plugin-contributed tab alongside Source and Rendered. Standalone file panels offer it too; the standalone file viewer dialog stays read-only. Disabling the plugin removes Edit live, and a panel that was persisted in Edit mode falls back to Source without rewriting the stored preference.

From a diff, **Open in file browser** in the toolbar selects the current working file in its containing worktree. Use Edit there, or enable the plugin from the notice. Deleted files do not offer this route.

## What a save writes

The editor buffer is the file. Nothing reformats, re-wraps, re-indents, trims whitespace or changes markers.

- **An unedited save writes nothing.** The buffer is compared with the text that was read; if they match, the disk is re-checked and the same revision is reported back.
- **An edited save writes exactly the buffer**, with the file's UTF-8 BOM and its dominant line ending re-applied. A one-word change produces a one-line diff.
- **Line endings.** CodeMirror stores lines without terminators. The dominant ending (LF or CRLF) is detected once when the file is read and re-applied to the whole document on an edited save. A file with **mixed line endings** is normalised to its dominant ending the first time an edited save happens; the status line says "Mixed line endings — saving normalises to LF" (or CRLF) before that save. This is the one documented normalisation, and it never applies to an unedited save.
- **Encoding.** Files are read as bytes and decoded as strict UTF-8. A file that does not decode is not editable; the panel says so and offers the external editor. Undecodable bytes are never replaced and written back.
- **Size.** The 2 MiB limit is applied at open, to draft growth, and again at the write boundary.

## Conflicts and the save contract

Every save passes the revision (a hash of the bytes last read) to the host. The host serialises writes per file, compares the file's current bytes with that revision, and only then replaces the file atomically. A save whose revision no longer matches is refused and nothing is written.

| Situation | What happens |
| --- | --- |
| The file changes on disk while the document is clean | The editor reloads the new text with a fresh undo history |
| The file changes on disk while a draft is dirty | The draft is kept, the panel shows **File changed on disk**, and Save is held |
| A save is refused as stale | Same conflict state; nothing was written |
| Typing lands while a save is in flight | The submitted snapshot saves; the later typing stays unsaved against the new revision |
| The save fails or is refused | The draft stays, and the banner offers Retry |
| The file is deleted, renamed, or its worktree removed | The draft is kept, the panel reports the file unavailable, and Save draft as… is offered; nothing is recreated or retargeted silently |
| Another window or plugin saves the file | Treated as an external change |
| A change is missed by the watcher | The file is re-checked on focus, on returning to the project, and before every save; the watcher is an optimisation, not the authority |

A conflict offers three ways out and no automatic merge: **Compare** (the draft against the disk version in the app's own diff surface, read-only), **Load disk version** (with an explicit discard confirmation), or **Save draft as…** (a new Markdown file inside the same root).

**The residual race.** The checked write prevents the editor from clobbering a change it has not seen, prevents partial writes, and serialises every host-mediated writer. It does not lock out an uncooperative external process: a write that lands between the hash check and the rename is overwritten. The window is small but real. The draft is kept until a save is verified, so nothing of yours is lost on an ambiguous result, and no surface claims conflict-free writes.

## Draft recovery

Unsaved edits are stored outside the repository, under `~/.daintree/plugin-data/daintree.markdown-editor/drafts/`, one JSON record per document identity (project, worktree and path), named by a hash of that identity. Ordinary Markdown files remain the durable documents; recovery storage is a safety net, not a second document system.

- A record is written about one second after typing stops, and immediately when the panel is hidden, when the app loses focus, when you leave Edit mode, and when the panel is closed. **Work after the last persisted point can be lost on a hard crash.**
- A recovered draft is loaded as a draft and compared with the current disk revision before Save is enabled. If the file changed since the draft was taken, the draft opens in the conflict state. A recovered draft is never written automatically.
- Records are cleared only after a verified save or an explicit discard. Disabling the plugin leaves records in place; re-enabling finds them.
- **Markdown: Recover drafts…** in the command palette lists stored drafts and opens one in Edit mode in its own project and worktree.
- Storage is capped at 50 records or 16 MiB. Unsaved work is never evicted silently: when a record cannot be written, the draft stays in the panel and a persistent warning offers to copy it.
- Document contents and drafts never reach telemetry, logs that leave the machine, plugin settings, or Git.

## Closing and switching

The draft is document state, not view state. Switching from Edit to Source, Rendered or Diff keeps it, Rendered previews the draft while one exists, and the panel chrome shows the unsaved mark in every mode. Switching to another file in the browser or closing a dirty panel asks **Save**, **Discard changes** or **Cancel**. A temporary unmount — a sibling maximised, a dock tab switch, a background project view evicted — is not a close and never prompts.

## Keyboard

`Cmd+S` / `Ctrl+S` saves while focus is inside the editor and is consumed there, so it never reaches a terminal or another panel; a terminal in the same window keeps its own `Cmd+S`. Enter continues a list, task list or quote and renumbers the next ordered item; Backspace on an empty item removes the marker. `Cmd+F` opens find and replace inside the editor, `Cmd+L` goes to a line, and `Cmd`/`Ctrl` + click follows a link through the host's link policy with the draft intact. Leaving Edit returns focus to the mode toggle.

## Security posture

Edit renders text through CodeMirror; no document HTML is parsed or executed. Rendered mode keeps its existing sanitisation and previews the draft through the same path it uses for disk text. Reads and writes go through `host.fs`, contained to the project and worktree roots and revalidated inside the write. Nothing here reads or writes `~/.claude/`, `~/.gemini/`, `~/.codex/`, user hooks, or a project's `CLAUDE.md` / `AGENTS.md` on the user's behalf, and enabling the plugin has no agent-config side effect. No MCP tool is added: external agents gain no file-writing surface through this feature.
