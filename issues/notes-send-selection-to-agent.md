# Notes: Selective Context & Agent Addressing

## Problem
Users often want to draft or collect snippets and then hand a focused slice to an agent. While "Copy Context" exists for the whole worktree, there isn't a tight loop for selective snippets or referencing durable scratchpads.

## Proposal
In the Notes Panel, implement two primary ways to share information with agents:
1. **Selective Snippets:** Send specific text selections to an active agent.
2. **File Addressing:** Reference the entire note file via a standard path that agents can resolve.

## UX
### 1. Send to Agent (Selection)
- Right-click context menu inside the editor:
  - “Send selection to… → Claude/Gemini/Codex”
  - “Send note to…”
- A button in the header opens the same menu.
- **Behavior:**
  - If a selection exists, only that text is sent.
  - If no selection exists, the entire note content is sent.
  - After sending, optionally show a small "Sent to [Agent]" toast or indicator.

### 2. Copy Path (@addressable)
- A "Copy Path" action in the Notes Panel header.
- **Format:** Copies a string like `@.canopy/notes/my-scratchpad.md`.
- **Flow:** User pastes this into an agent terminal: "Hey Claude, please clean up the thoughts I have in @.canopy/notes/my-scratchpad.md".
- **Agent Action:** The agent uses `read_file(".canopy/notes/my-scratchpad.md")` to pull the context.

## Implementation Notes
- **Direct Injection:** Reuse the existing agent launch/run flow to enqueue the prompt into an active session.
- **Normalization:** Ensure content is escaped/normalized similarly to other context injection utilities.
- **File Access:** Since notes are stored in `.canopy/notes/`, agents (which run in the project root) have native access to them without special IPC if they have file-reading tools.

## Acceptance Criteria
- “Send selection to Claude” targets a Claude session and submits the selected text.
- "Copy Path" provides a relative path prefixed with `@` (or standard relative path) that is clear for agents.
- Works for all enabled agents in the registry.