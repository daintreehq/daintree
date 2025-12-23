# Worktree card: accordion visual hierarchy

## Summary
The accordion headings inside each worktree card (“Details” and “Active Sessions”) blend into the
accordion container when expanded. Add an “expanded header” background color that’s visually
between the container’s default and the hover state, so expanded sections read as a distinct header
row rather than just another line inside the panel.

## Problem
In the expanded state, the header rows are only differentiated by typography and a bottom border.
Because the surrounding accordion container uses a subtle background (`bg-white/[0.01]`) and the
header has **no base background** (only `hover:bg-white/5`), the header looks nearly identical to the
rest of the container when not hovered.

This makes the accordion hierarchy harder to scan, especially when multiple worktrees are expanded
and the card itself may already have its own background/hover states.

## Current State (code)
`src/components/Worktree/WorktreeCard.tsx`

- Details accordion container: `bg-white/[0.01]` (`WorktreeCard.tsx#L1130`)
- Details expanded header button: no base `bg-*`, only `hover:bg-white/5` (`WorktreeCard.tsx#L1139`)
- Terminals accordion container: `bg-white/[0.01]` (`WorktreeCard.tsx#L1248`)
- Terminals expanded header button: no base `bg-*`, only `hover:bg-white/5` (`WorktreeCard.tsx#L1257`)

## Goals
- Expanded accordion headers have a persistent background tint (no hover required).
- The tint is visually “between” the container default and hover state.
- Keep existing spacing, borders, focus rings, and interaction behavior.
- Apply consistently to both accordions within the worktree card.

## Non-goals
- Redesign the worktree card layout or overall color system.
- Replace the current implementation with Radix Accordion or introduce a new dependency.
- Change collapsed-state styling beyond what’s needed for consistency.

## Proposed Visual Spec
### Background levels (relative)
- Accordion container background: keep `bg-white/[0.01]` (current).
- Expanded header background (new): `bg-white/[0.03]`.
- Header hover background: keep current `bg-white/5` (≈ `bg-white/[0.05]`).

Rationale: `0.03` sits between `0.01` (container) and `0.05` (hover), creating a clear hierarchy
without looking “selected” like the active worktree card (`bg-white/[0.03]` on the whole card).

### Interaction states
- Expanded header (rest): `bg-white/[0.03]`
- Expanded header (hover): `bg-white/[0.05]`
- Expanded header (keyboard focus): keep existing focus-visible outline/ring behavior; optionally add
  `focus-visible:bg-white/[0.05]` so focus is noticeable even without the outline.

### Scope
Apply only to the two “expanded header” buttons (not the collapsed summary buttons, not the list
items inside the terminal list).

## Implementation Guide
### 1) Update expanded header classnames
In `src/components/Worktree/WorktreeCard.tsx`, modify both expanded header buttons:

- Details expanded header: `WorktreeCard.tsx#L1139`
- Terminals expanded header: `WorktreeCard.tsx#L1257`

Add:
- `bg-white/[0.03]`
- Change hover to `hover:bg-white/[0.05]` (or keep `hover:bg-white/5` for identical behavior)
- Optional: `focus-visible:bg-white/[0.05]` (if desired)

### 2) Reduce duplication (optional but recommended)
Define a shared class string near the top of `WorktreeCard.tsx` for accordion header buttons, e.g.:

- Base layout/spacing/border/focus classes
- Then per-state additions (`bg-white/[0.03]` for expanded vs none for collapsed)

This prevents the “Details” and “Active Sessions” accordions from drifting over time.

### 3) Keep behavior unchanged
Do not change any click/keyboard logic:
- `handleToggleExpand` and `handleToggleTerminals` already call `stopPropagation()` to avoid
  selecting the whole card.
- `aria-expanded`, `aria-controls`, and region semantics remain as-is.

## QA / Validation Checklist
- Expand “Details”: header shows tinted background without hover.
- Expand “Active Sessions”: header shows tinted background without hover.
- Hover expanded headers: background increases subtly.
- Keyboard navigation: Tab focus shows visible focus (outline still present; background optional).
- Active worktree card state: expanded headers still look like headers, not like the whole card is
  “doubly selected”.

## Acceptance Criteria
- Expanded accordion headers have a persistent background tint.
- Tint visually separates header from accordion body and container background.
- No changes to layout, spacing, or toggle behavior.
- No regressions in focus-visible accessibility or hover affordances.

