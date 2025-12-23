# Panel Grid Empty State: Less Clicky, More “Flow”

## Problem
The empty-state UI for a worktree encourages launching via large buttons (`src/components/Terminal/ContentGrid.tsx`). This can feel noisy for experienced users who prefer palette/hotkeys and consistent workflows.

## Proposal
Refine the empty state to prioritize “flow”:
- Make hotkeys/palette the primary CTA (keep buttons but de-emphasize them).
- Add “Resume” affordances:
  - “Reopen last session(s) in this worktree” (if any exist in history).
  - “Run last recipe” (if a recipe exists).
- Optionally show a minimal “Quick actions” row instead of the full button set.

## Acceptance Criteria
- Empty state remains informative for first-time users.
- Experienced users can start work with fewer clicks (palette/hotkeys/resume actions).

