# Phase 4 Spec: Sessions, History, and Notes (Light “Memory”)

## Summary
With Phase 2–3, the agent can do reliable one-shot commands. This phase makes it *usable day-to-day* by adding:

- Persistent session history (“what did I ask the agent to do?”)
- **First-Class Notes:** Durable scratchpads stored in-repo that the agent and user can collaboratively read/write.
- Per-project configuration for agent capabilities and prompt overrides.

## Depends On
- Phase 1 Actions foundation (`issues/app-wide-agent/phase-1-global-actions-system.md`)
- Phase 2 One-shot agent MVP (`issues/app-wide-agent/phase-2-one-shot-agent-mvp.md`)
- Phase 3 Read/inspect tools (`issues/app-wide-agent/phase-3-agent-read-inspect-tools.md`)

## Goals
- **G1: Session history**: persist agent runs per project (prompt → tools used → action dispatched → result).
- **G2: In-Repo Notes**: Elevate notes to first-class citizens stored in `.canopy/notes/`.
- **G3: Capability configuration**: per-project control over what actions/queries are exposed to the agent.
- **G4: Prompt overrides**: optional project-level and worktree-level system prompt snippets.

## Data Model

### Agent run record
Stored in `electron/services/ProjectStore.ts` state directory (`agent-history.json`):
- `id`, `createdAt`, `projectId`, `userText`, `decision`, `result`.

### Notes
`NoteRecord` (Stored as individual `.md` files in `.canopy/notes/` with YAML frontmatter):
- `id`: string (uuid)
- `createdAt`: ISO timestamp
- `updatedAt`: ISO timestamp
- `scope`: "project" | "worktree"
- `worktreeId?`: string
- `title`: string
- `content`: markdown body

## Storage & Persistence
- **History:** Stored in app data (`userData/projects/{projectId}/agent-history.json`).
- **Notes:** Stored in the project repository at `.canopy/notes/*.md`.
  - This allows agents to access notes using standard file tools.
  - Allows users to optionally commit notes to the repo.

## Capabilities & Exposure Control
Extend action definitions with:
- `agentAccessible: boolean`
- `capability`: `"navigation"` | `"terminals"` | `"worktrees"` | `"settings"` | `"readTerminal"` | `"readEvents"` | `"notes"`

## UI
### History
- Accessible from the app-wide agent command bar.
- List of recent runs with details on tools used and outcomes.

### Notes (The Notebook)
- **Toolbar Entry:** A dedicated "Notebook" icon in the top toolbar.
- **Note Palette:** A searchable list of all persisted notes in the current project.
- **Notes Panel:** A first-class `NotesPanel` using `react-md-editor` for editing and previewing.

## New Actions (Phase 4)
- `notes.create` `{ title, scope, content? }`
- `notes.update` `{ path, content }`
- `notes.list`
- `notes.open` `{ path }` (Spawns a Notes Panel)

## Acceptance Criteria
- Agent runs persist and are viewable per project.
- Notes are stored as addressable files in the repo and can be managed via the UI.
- Users can "restore" any note from the toolbar "Notebook" menu.
- `npm test` and `npm run check` pass.