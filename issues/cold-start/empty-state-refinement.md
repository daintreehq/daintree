# Panel Grid Empty State: Less Clicky, More “Flow”

## Problem
The empty-state UI for a worktree currently encourages launching via large, generic agent buttons (`src/components/Terminal/ContentGrid.tsx`). This can feel noisy for experienced users who prefer palette/hotkeys and consistent workflows, and it lacks project-specific context.

## Proposal
Refine the empty state to prioritize “flow” and project-specific setups via **Recipes**.

### 1. Recipes as First-Class Citizens
Recipes (premade terminal layouts) should be a primary way to initialize a worktree.
- When creating or editing a Recipe, add a toggle: **"Show in Empty State"**.
- In the Empty State, display these "pinned" recipes as prominent launcher cards (e.g., "Dev Server", "Test Suite", "Full Stack").
- This allows a project to define its own "Start Menu".

### 2. De-emphasize Generic Launchers
- Move the generic "Launch Claude/Gemini/Terminal" buttons to a secondary row or "Quick Actions" bar.
- Make the Command Palette / Hotkeys (`Cmd+P`, `Cmd+T`) the primary call-to-action for ad-hoc tasks.

### 3. "Resume" Affordances
- If the user was previously working in this worktree, show a **"Resume Last Session"** button.
- If a specific recipe was last used, offer to **"Rerun [Recipe Name]"**.

## User Experience
*   **New Project:** Shows "What's This Project?" (see `whats-this-project-workflow.md`) and generic launchers.
*   **Configured Project:** Shows "Dev Server" (Recipe), "Run Tests" (Recipe), and "What's Next?" (see `whats-next-workflow.md`).
*   **Returning User:** Prominently offers "Resume Last Session".

## Acceptance Criteria
- [ ] Recipe editor includes a "Show in Empty State" checkbox.
- [ ] Empty state renders pinned recipes as primary actions.
- [ ] Generic agent launchers are visually de-emphasized.
- [ ] "Resume" actions appear when history is available.