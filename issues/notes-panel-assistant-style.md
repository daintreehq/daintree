# Notes Panel: First-Class Assistant Notepad

## Goal
Elevate "Notes" to a first-class citizen in Canopy. A Notes Panel supports lightweight, durable writing during work, designed to feel like a scratchpad that integrates deeply with agent workflows.

## Proposal
Create a non-PTY panel kind: `notes`.

### UI & Editor
- **Component:** Use `react-md-editor` (@uiwjs/react-md-editor) for a rich Markdown editing experience with live preview and code block support.
- **Styling:** Ensure theme (Dark/Light) syncs with Canopy's Tailwind theme.
- **Sanitization:** Use `rehype-sanitize` to ensure secure rendering of markdown content.

### Storage & Persistence (The addressable file)
- **Location:** Notes are stored as Markdown files in the project root under `.canopy/notes/` (e.g., `.canopy/notes/refactor-plan.md`).
- **Git Strategy:** By default, `.canopy/notes/` should be added to `.gitignore`, but users can choose to commit important architectural notes to the repo.
- **Metadata (Frontmatter):** Use YAML frontmatter for panel metadata:
  ```markdown
  ---
  id: "note-uuid"
  title: "Auth Refactor Plan"
  scope: "worktree" | "project"
  worktreeId: "wt-api"
  createdAt: 2023-12-23T10:00:00Z
  ---
  # Note Content
  ```

### First-Class Entry Points
- **Toolbar "Notebook":** Add a Notes/Notebook icon to the top toolbar (near the Sidecar toggle).
- **Note Palette:** Clicking the toolbar icon opens a palette (similar to the Terminal Palette) to search and "restore" old scratchpads.
- **Grid Integration:** Restore a note by spawning it as a `NotesPanel` in the active grid or dock.

### Actions
- **Copy Path (@addressable):** Header action to copy the addressable path (e.g., `@.canopy/notes/plan.md`). This allows users to easily mention notes to agents (e.g., "Review the plan at @.canopy/notes/plan.md").
- **Send to Agent:** Selective context injection (see `notes-send-selection-to-agent.md`).

## Technical Notes
- Follow the existing non-PTY pattern:
  - register `notes` in `shared/config/panelKindRegistry.ts` (`hasPty: false`),
  - register a `NotesPanel` component in `src/registry/builtInPanelRegistrations.ts`,
  - add a `notesStateStore` or utilize `ProjectStore` to manage the file lifecycle.
- Persistence is file-based in-repo, making notes naturally accessible to local CLI agents.

## Acceptance Criteria
- User can create a Notes Panel and content persists as a `.md` file in `.canopy/notes/`.
- Notes are restorable from a central "Notebook" entry point in the toolbar.
- The editor provides a polished Markdown experience with `react-md-editor`.
- Agents can read/write these files via standard file tools.