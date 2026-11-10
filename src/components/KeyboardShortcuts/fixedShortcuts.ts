export interface FixedShortcut {
  label: string;
  /** Alternative keys, each a combo string `KbdChord` can render. */
  keys: string[];
  description: string;
  /** The reference's category, shared with the bindable shortcuts of the same area. */
  category: string;
}

// Worktree-list navigation and drag-handle reordering live outside the keybinding
// engine (useWorktreeSidebarKeyboard's roving focus, dnd-kit's keyboard sensor), so
// they are documented as fixed rather than offered as rows that could never fire.
export const FIXED_SHORTCUTS: readonly FixedShortcut[] = [
  {
    label: "Move through the worktree list",
    keys: ["Up", "Down", "J", "K"],
    description: "PageUp, PageDown, Home and End jump further",
    category: "Worktrees",
  },
  {
    label: "Open worktree",
    keys: ["Space", "Enter"],
    description: "Right or F2 moves into the row's actions",
    category: "Worktrees",
  },
  {
    label: "Reorder worktree",
    keys: ["Alt+Up", "Alt+Down"],
    description: "With the worktree focused in the sidebar",
    category: "Worktrees",
  },
  {
    label: "Reorder panel",
    keys: ["Space"],
    description:
      "Focus the panel header, press Space to pick it up, move with the arrow keys, Space to drop, Esc to cancel",
    category: "Panels",
  },
  {
    label: "Reorder tab",
    keys: ["Space"],
    description:
      "Focus the active tab, press Space to pick it up, move with the arrow keys, Space to drop",
    category: "Panels",
  },
];

/** The double-tap gesture; it fires only while `doubleShiftOpensCanopy` is on. */
export const DOUBLE_SHIFT_SHORTCUT: FixedShortcut = {
  label: "Open Canopy with a double tap",
  keys: ["Shift Shift"],
  description: "Works from anywhere",
  category: "Project",
};
