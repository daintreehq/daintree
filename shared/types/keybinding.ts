import type { BuiltInActionId } from "./actions.js";

// Only scopes with a production setScope/useKeybindingScope caller belong
// here. "terminal", "modal", and "worktreeList" were removed (never pushed):
// terminal handling lives in the capture-handler bailouts + XtermAdapter,
// modal Escape in the escape stack, and worktree-list navigation in
// useWorktreeSidebarKeyboard. Declaring a scope nothing activates produces
// bindings that render in the settings/reference UI but can never fire.
export type KeyScope = "global" | "portal" | "worktreeGrid" | "dev-preview";

export interface KeybindingConfig {
  actionId: BuiltInActionId;
  combo: string; // e.g., "Cmd+T", "Ctrl+Shift+P", "Escape", "Cmd+K Cmd+S" (chords)
  scope: KeyScope;
  priority: number; // Higher priority wins in conflicts (default 0)
  description?: string;
  category?: string; // Category for organization in UI (e.g., "Terminal", "Panels")
}
