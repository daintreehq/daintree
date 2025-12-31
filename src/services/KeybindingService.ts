export type KeyScope = "global" | "terminal" | "modal" | "worktreeList" | "sidecar";

export interface KeybindingConfig {
  actionId: string;
  combo: string; // e.g., "Cmd+T", "Ctrl+Shift+P", "Escape", "Cmd+K Cmd+S" (chords)
  scope: KeyScope;
  priority: number; // Higher priority wins in conflicts (default 0)
  description?: string;
  category?: string; // Category for organization in UI (e.g., "Terminal", "Panels")
}

const DEFAULT_KEYBINDINGS: KeybindingConfig[] = [
  {
    actionId: "terminal.close",
    combo: "Cmd+W",
    scope: "global",
    priority: 10,
    description: "Close focused terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.palette",
    combo: "Cmd+P",
    scope: "global",
    priority: 0,
    description: "Open terminal palette",
    category: "Terminal",
  },
  {
    actionId: "terminal.new",
    combo: "Cmd+T",
    scope: "global",
    priority: 0,
    description: "New terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.spawnPalette",
    combo: "Cmd+N",
    scope: "global",
    priority: 0,
    description: "New terminal...",
    category: "Terminal",
  },
  {
    actionId: "terminal.reopenLast",
    combo: "Cmd+Shift+T",
    scope: "global",
    priority: 0,
    description: "Reopen last closed terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.closeAll",
    combo: "Cmd+Shift+W",
    scope: "global",
    priority: 0,
    description: "Close all terminals",
    category: "Terminal",
  },
  {
    actionId: "terminal.killAll",
    combo: "Cmd+K Cmd+K",
    scope: "global",
    priority: 0,
    description: "End all terminals",
    category: "Terminal",
  },
  {
    actionId: "terminal.restartAll",
    combo: "Cmd+K Cmd+R",
    scope: "global",
    priority: 0,
    description: "Restart all terminals",
    category: "Terminal",
  },
  {
    actionId: "terminal.minimize",
    combo: "Cmd+Alt+M",
    scope: "global",
    priority: 0,
    description: "Minimize focused terminal to dock",
    category: "Terminal",
  },
  {
    actionId: "terminal.minimizeAll",
    combo: "Cmd+Alt+Shift+M",
    scope: "global",
    priority: 0,
    description: "Minimize all terminals to dock",
    category: "Terminal",
  },
  {
    actionId: "terminal.restore",
    combo: "Cmd+Alt+U",
    scope: "global",
    priority: 0,
    description: "Restore focused terminal from dock",
    category: "Terminal",
  },
  {
    actionId: "terminal.restoreAll",
    combo: "Cmd+Alt+Shift+U",
    scope: "global",
    priority: 0,
    description: "Restore all terminals from dock",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusNext",
    combo: "Ctrl+Tab",
    scope: "global",
    priority: 0,
    description: "Focus next terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusPrevious",
    combo: "Ctrl+Shift+Tab",
    scope: "global",
    priority: 0,
    description: "Focus previous terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.maximize",
    combo: "Ctrl+Shift+F",
    scope: "global",
    priority: 0,
    description: "Toggle maximize terminal",
    category: "Terminal",
  },
  {
    actionId: "terminal.moveLeft",
    combo: "Cmd+Shift+Alt+ArrowLeft",
    scope: "global",
    priority: 0,
    description: "Move terminal left in grid",
    category: "Terminal",
  },
  {
    actionId: "terminal.moveRight",
    combo: "Cmd+Shift+Alt+ArrowRight",
    scope: "global",
    priority: 0,
    description: "Move terminal right in grid",
    category: "Terminal",
  },
  {
    actionId: "agent.palette",
    combo: "Cmd+Shift+A",
    scope: "global",
    priority: 0,
    description: "Open agent palette",
    category: "Agents",
  },
  {
    actionId: "agent.claude",
    combo: "Cmd+Alt+C",
    scope: "global",
    priority: 0,
    description: "Launch Claude agent",
    category: "Agents",
  },
  {
    actionId: "agent.gemini",
    combo: "Cmd+Alt+G",
    scope: "global",
    priority: 0,
    description: "Launch Gemini agent",
    category: "Agents",
  },
  {
    actionId: "agent.codex",
    combo: "Cmd+Alt+X",
    scope: "global",
    priority: 0,
    description: "Launch Codex agent",
    category: "Agents",
  },
  {
    actionId: "agent.terminal",
    combo: "Cmd+Alt+N",
    scope: "global",
    priority: 0,
    description: "Launch terminal in current worktree",
    category: "Agents",
  },
  {
    actionId: "agent.focusNextWaiting",
    combo: "Cmd+Alt+/",
    scope: "global",
    priority: 0,
    description: "Jump to next waiting agent",
    category: "Agents",
  },
  {
    actionId: "agent.focusNextFailed",
    combo: "Cmd+Alt+Shift+/",
    scope: "global",
    priority: 0,
    description: "Jump to next failed agent",
    category: "Agents",
  },
  {
    actionId: "terminal.inject",
    combo: "Cmd+Shift+I",
    scope: "global",
    priority: 0,
    description: "Inject context into focused terminal",
    category: "Terminal",
  },
  // Directional terminal navigation (Ghostty-style: Cmd+Option+Arrow)
  {
    actionId: "terminal.focusUp",
    combo: "Cmd+Alt+ArrowUp",
    scope: "global",
    priority: 0,
    description: "Focus terminal above",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusDown",
    combo: "Cmd+Alt+ArrowDown",
    scope: "global",
    priority: 0,
    description: "Focus terminal below",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusLeft",
    combo: "Cmd+Alt+ArrowLeft",
    scope: "global",
    priority: 0,
    description: "Focus terminal to the left",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusRight",
    combo: "Cmd+Alt+ArrowRight",
    scope: "global",
    priority: 0,
    description: "Focus terminal to the right",
    category: "Terminal",
  },
  // Index-based terminal navigation (Cmd+1-9)
  {
    actionId: "terminal.focusIndex1",
    combo: "Cmd+1",
    scope: "global",
    priority: 0,
    description: "Focus terminal 1",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex2",
    combo: "Cmd+2",
    scope: "global",
    priority: 0,
    description: "Focus terminal 2",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex3",
    combo: "Cmd+3",
    scope: "global",
    priority: 0,
    description: "Focus terminal 3",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex4",
    combo: "Cmd+4",
    scope: "global",
    priority: 0,
    description: "Focus terminal 4",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex5",
    combo: "Cmd+5",
    scope: "global",
    priority: 0,
    description: "Focus terminal 5",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex6",
    combo: "Cmd+6",
    scope: "global",
    priority: 0,
    description: "Focus terminal 6",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex7",
    combo: "Cmd+7",
    scope: "global",
    priority: 0,
    description: "Focus terminal 7",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex8",
    combo: "Cmd+8",
    scope: "global",
    priority: 0,
    description: "Focus terminal 8",
    category: "Terminal",
  },
  {
    actionId: "terminal.focusIndex9",
    combo: "Cmd+9",
    scope: "global",
    priority: 0,
    description: "Focus terminal 9",
    category: "Terminal",
  },
  {
    actionId: "panel.palette",
    combo: "Cmd+Shift+P",
    scope: "global",
    priority: 0,
    description: "Open panel palette",
    category: "Panels",
  },
  {
    actionId: "panel.diagnosticsLogs",
    combo: "Ctrl+Shift+L",
    scope: "global",
    priority: 0,
    description: "Open diagnostics dock to Logs tab",
    category: "Panels",
  },
  {
    actionId: "panel.diagnosticsEvents",
    combo: "Ctrl+Shift+E",
    scope: "global",
    priority: 0,
    description: "Open diagnostics dock to Events tab",
    category: "Panels",
  },
  {
    actionId: "panel.diagnosticsMessages",
    combo: "Ctrl+Shift+M",
    scope: "global",
    priority: 0,
    description: "Open diagnostics dock to Problems tab",
    category: "Panels",
  },
  {
    actionId: "panel.toggleDock",
    combo: "Ctrl+`",
    scope: "global",
    priority: 0,
    description: "Toggle terminal dock",
    category: "Panels",
  },
  {
    actionId: "panel.toggleDockAlt",
    combo: "Cmd+J",
    scope: "global",
    priority: 0,
    description: "Toggle terminal dock",
    category: "Panels",
  },
  {
    actionId: "panel.toggleDiagnostics",
    combo: "Cmd+Shift+D",
    scope: "global",
    priority: 0,
    description: "Toggle diagnostics dock",
    category: "Panels",
  },
  {
    actionId: "panel.toggleSidecar",
    combo: "Cmd+\\",
    scope: "global",
    priority: 0,
    description: "Toggle sidecar panel",
    category: "Panels",
  },
  {
    actionId: "sidecar.closeTab",
    combo: "Cmd+W",
    scope: "sidecar",
    priority: 20,
    description: "Close active sidecar tab",
    category: "Sidecar",
  },
  {
    actionId: "sidecar.nextTab",
    combo: "Ctrl+Tab",
    scope: "sidecar",
    priority: 20,
    description: "Next sidecar tab",
    category: "Sidecar",
  },
  {
    actionId: "sidecar.prevTab",
    combo: "Ctrl+Shift+Tab",
    scope: "sidecar",
    priority: 20,
    description: "Previous sidecar tab",
    category: "Sidecar",
  },
  {
    actionId: "sidecar.newTab",
    combo: "Cmd+T",
    scope: "sidecar",
    priority: 20,
    description: "New sidecar tab",
    category: "Sidecar",
  },
  {
    actionId: "nav.toggleSidebar",
    combo: "Cmd+B",
    scope: "global",
    priority: 0,
    description: "Toggle sidebar",
    category: "Navigation",
  },
  {
    actionId: "worktree.switch1",
    combo: "Cmd+Alt+1",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 1",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch2",
    combo: "Cmd+Alt+2",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 2",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch3",
    combo: "Cmd+Alt+3",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 3",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch4",
    combo: "Cmd+Alt+4",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 4",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch5",
    combo: "Cmd+Alt+5",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 5",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch6",
    combo: "Cmd+Alt+6",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 6",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch7",
    combo: "Cmd+Alt+7",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 7",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch8",
    combo: "Cmd+Alt+8",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 8",
    category: "Worktrees",
  },
  {
    actionId: "worktree.switch9",
    combo: "Cmd+Alt+9",
    scope: "global",
    priority: 0,
    description: "Switch to worktree 9",
    category: "Worktrees",
  },
  {
    actionId: "worktree.next",
    combo: "Cmd+Alt+]",
    scope: "global",
    priority: 0,
    description: "Switch to next worktree",
    category: "Worktrees",
  },
  {
    actionId: "worktree.previous",
    combo: "Cmd+Alt+[",
    scope: "global",
    priority: 0,
    description: "Switch to previous worktree",
    category: "Worktrees",
  },
  {
    actionId: "worktree.openPalette",
    combo: "Cmd+K W",
    scope: "global",
    priority: 0,
    description: "Open worktree palette",
    category: "Worktrees",
  },
  {
    actionId: "notes.openPalette",
    combo: "Cmd+Shift+O",
    scope: "global",
    priority: 0,
    description: "Open notes palette",
    category: "Notes",
  },
  {
    actionId: "help.shortcuts",
    combo: "Cmd+K Cmd+S",
    scope: "global",
    priority: 0,
    description: "Open keyboard shortcuts reference",
    category: "Help",
  },
  {
    actionId: "help.shortcutsAlt",
    combo: "Cmd+/",
    scope: "global",
    priority: 0,
    description: "Open keyboard shortcuts reference",
    category: "Help",
  },
  {
    actionId: "app.settings",
    combo: "Cmd+,",
    scope: "global",
    priority: 0,
    description: "Open settings",
    category: "System",
  },
  {
    actionId: "modal.close",
    combo: "Escape",
    scope: "modal",
    priority: 10,
    description: "Close modal dialog",
    category: "System",
  },
  {
    actionId: "worktree.up",
    combo: "ArrowUp",
    scope: "worktreeList",
    priority: 5,
    description: "Move up in worktree list",
    category: "Worktrees",
  },
  {
    actionId: "worktree.down",
    combo: "ArrowDown",
    scope: "worktreeList",
    priority: 5,
    description: "Move down in worktree list",
    category: "Worktrees",
  },
  {
    actionId: "worktree.upVim",
    combo: "k",
    scope: "worktreeList",
    priority: 5,
    description: "Move up in worktree list (vim)",
    category: "Worktrees",
  },
  {
    actionId: "worktree.downVim",
    combo: "j",
    scope: "worktreeList",
    priority: 5,
    description: "Move down in worktree list (vim)",
    category: "Worktrees",
  },
  {
    actionId: "worktree.home",
    combo: "Home",
    scope: "worktreeList",
    priority: 5,
    description: "Go to first worktree",
    category: "Worktrees",
  },
  {
    actionId: "worktree.end",
    combo: "End",
    scope: "worktreeList",
    priority: 5,
    description: "Go to last worktree",
    category: "Worktrees",
  },
  {
    actionId: "worktree.select",
    combo: "Enter",
    scope: "worktreeList",
    priority: 5,
    description: "Select worktree",
    category: "Worktrees",
  },
  {
    actionId: "worktree.selectSpace",
    combo: "Space",
    scope: "worktreeList",
    priority: 5,
    description: "Select worktree (space)",
    category: "Worktrees",
  },
  {
    actionId: "worktree.copyTree",
    combo: "c",
    scope: "worktreeList",
    priority: 5,
    description: "Copy tree context",
    category: "Worktrees",
  },
  {
    actionId: "worktree.openEditor",
    combo: "e",
    scope: "worktreeList",
    priority: 5,
    description: "Open in editor",
    category: "Worktrees",
  },
];

// Map physical key codes to standard characters
// Fixes issues where Option/Alt changes the character (e.g., Option+/ becomes ÷ on Mac)
export const CODE_TO_KEY: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  IntlBackslash: "\\",
};

export function normalizeKey(key: string): string {
  const keyMap: Record<string, string> = {
    " ": "Space",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    escape: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    backspace: "Backspace",
    delete: "Delete",
  };
  return keyMap[key.toLowerCase()] || key;
}

/**
 * Normalize a keyboard event to get the correct key for keybinding matching.
 * This handles Option/Alt modifiers on macOS that change characters (e.g., Option+/ becomes ÷).
 * Use this function in both the keybinding matcher and the shortcut recorder to ensure consistency.
 */
export function normalizeKeyForBinding(event: KeyboardEvent): string {
  // Prefer physical key code for punctuation (handles Option/Alt modifiers)
  if (event.code && CODE_TO_KEY[event.code]) {
    return CODE_TO_KEY[event.code];
  }

  // Fallback to character-based normalization
  return normalizeKey(event.key);
}

function parseCombo(combo: string): {
  cmd: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
} {
  const parts = combo.split("+").map((p) => p.trim());
  const key = normalizeKey(parts.pop() || "");

  return {
    cmd: parts.some((p) => p.toLowerCase() === "cmd" || p.toLowerCase() === "meta"),
    ctrl: parts.some((p) => p.toLowerCase() === "ctrl"),
    shift: parts.some((p) => p.toLowerCase() === "shift"),
    alt: parts.some((p) => p.toLowerCase() === "alt" || p.toLowerCase() === "option"),
    key,
  };
}

class KeybindingService {
  private bindings: Map<string, KeybindingConfig> = new Map();
  private overrides: Map<string, string[]> = new Map();
  private currentScope: KeyScope = "global";
  private pendingChord: string | null = null;
  private chordTimeout: NodeJS.Timeout | null = null;
  private readonly CHORD_TIMEOUT_MS = 1000;
  private listeners: Array<() => void> = [];

  constructor() {
    DEFAULT_KEYBINDINGS.forEach((binding) => {
      this.bindings.set(binding.actionId, binding);
    });
  }

  async loadOverrides(): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      const overrides = await window.electron.keybinding.getOverrides();
      this.overrides.clear();
      if (overrides && typeof overrides === "object") {
        Object.entries(overrides).forEach(([actionId, combos]) => {
          if (Array.isArray(combos)) {
            this.overrides.set(actionId, combos);
          }
        });
      }
      this.notifyListeners();
    }
  }

  async setOverride(actionId: string, combo: string[]): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.setOverride(
        actionId as import("../../shared/types/keymap.js").KeyAction,
        combo
      );
      this.overrides.set(actionId, combo);
      this.notifyListeners();
    }
  }

  async removeOverride(actionId: string): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.removeOverride(
        actionId as import("../../shared/types/keymap.js").KeyAction
      );
      this.overrides.delete(actionId);
      this.notifyListeners();
    }
  }

  async resetAllOverrides(): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.resetAll();
      this.overrides.clear();
      this.notifyListeners();
    }
  }

  hasOverride(actionId: string): boolean {
    return this.overrides.has(actionId);
  }

  getOverride(actionId: string): string[] | undefined {
    return this.overrides.get(actionId);
  }

  getDefaultCombo(actionId: string): string | undefined {
    const defaultBinding = DEFAULT_KEYBINDINGS.find((b) => b.actionId === actionId);
    return defaultBinding?.combo;
  }

  getEffectiveCombo(actionId: string): string | undefined {
    if (this.overrides.has(actionId)) {
      const override = this.overrides.get(actionId);
      if (override && override.length > 0) {
        return override[0];
      }
      return undefined;
    }
    return this.getDefaultCombo(actionId);
  }

  findConflicts(combo: string, excludeActionId?: string): KeybindingConfig[] {
    const conflicts: KeybindingConfig[] = [];
    const normalizedCombo = combo.trim().toLowerCase();

    for (const binding of this.bindings.values()) {
      if (excludeActionId && binding.actionId === excludeActionId) continue;

      const overrideCombos = this.overrides.get(binding.actionId) || [];
      const allCombos = [...overrideCombos];

      if (overrideCombos.length === 0) {
        const defaultCombo = this.getDefaultCombo(binding.actionId);
        if (defaultCombo) {
          allCombos.push(defaultCombo);
        }
      }

      for (const existingCombo of allCombos) {
        if (existingCombo.trim().toLowerCase() === normalizedCombo) {
          conflicts.push(binding);
          break;
        }
      }
    }
    return conflicts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(): void {
    this.listeners.forEach((listener) => listener());
  }

  setScope(scope: KeyScope): void {
    this.currentScope = scope;
    this.clearPendingChord();
  }

  getScope(): KeyScope {
    return this.currentScope;
  }

  getBinding(actionId: string): KeybindingConfig | undefined {
    return this.bindings.get(actionId);
  }

  getAllBindings(): KeybindingConfig[] {
    return Array.from(this.bindings.values());
  }

  matchesEvent(event: KeyboardEvent, combo: string): boolean {
    // Chord sequences (e.g., "Cmd+K Cmd+K") should not be matched here.
    // They are handled by findMatchingAction's chord state machine.
    if (combo.includes(" ")) {
      return false;
    }

    const parsed = parseCombo(combo);

    // Handle Cmd vs Ctrl based on platform
    // On macOS, Cmd (metaKey) is the primary modifier
    // On Windows/Linux, Ctrl is the primary modifier
    const isMac =
      typeof navigator !== "undefined" &&
      navigator.platform &&
      navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const hasCmd = isMac ? event.metaKey : event.ctrlKey;

    // Check modifiers
    if (parsed.cmd && !hasCmd) return false;
    if (parsed.ctrl && !event.ctrlKey) return false;
    if (parsed.shift && !event.shiftKey) return false;
    if (parsed.alt && !event.altKey) return false;

    // Check that we don't have extra modifiers
    // (unless the combo expects them)
    if (!parsed.cmd && hasCmd) return false;
    if (!parsed.shift && event.shiftKey) return false;
    if (!parsed.alt && event.altKey) return false;
    // Ctrl check is more nuanced due to Cmd/Ctrl swap
    if (!parsed.cmd && !parsed.ctrl && event.ctrlKey && !isMac) return false;
    // On macOS, reject unexpected Ctrl when not explicitly required
    if (isMac && !parsed.ctrl && event.ctrlKey) return false;

    // Check key
    const eventKey = normalizeKey(event.key);

    // Try exact match on the produced character
    if (eventKey.toLowerCase() === parsed.key.toLowerCase()) return true;

    // Fallback: Try physical key code mapping
    // This fixes issues where Option/Alt changes the character (e.g., Option+/ becomes ÷ on Mac)
    if (event.code && CODE_TO_KEY[event.code] === parsed.key) return true;

    return false;
  }

  canExecute(actionId: string): boolean {
    const binding = this.bindings.get(actionId);
    if (!binding) return false;

    // Global shortcuts always work
    if (binding.scope === "global") return true;

    // Scope-specific shortcuts only work in their scope
    return binding.scope === this.currentScope;
  }

  private clearChordTimeout(): void {
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
      this.chordTimeout = null;
    }
  }

  private setPendingChord(combo: string): void {
    this.clearChordTimeout();
    this.pendingChord = combo;
    this.chordTimeout = setTimeout(() => {
      this.pendingChord = null;
      this.chordTimeout = null;
    }, this.CHORD_TIMEOUT_MS);
  }

  getPendingChord(): string | null {
    return this.pendingChord;
  }

  clearPendingChord(): void {
    this.clearChordTimeout();
    this.pendingChord = null;
  }

  private eventToCombo(event: KeyboardEvent): string {
    const parts: string[] = [];
    const isMac =
      typeof navigator !== "undefined" &&
      navigator.platform &&
      navigator.platform.toUpperCase().indexOf("MAC") >= 0;

    if (isMac && event.metaKey) parts.push("Cmd");
    if (!isMac && event.ctrlKey) parts.push("Cmd");
    if (event.shiftKey) parts.push("Shift");
    if (event.altKey) parts.push("Alt");
    parts.push(normalizeKey(event.key));

    return parts.join("+");
  }

  findMatchingAction(event: KeyboardEvent): KeybindingConfig | undefined {
    let bestMatch: KeybindingConfig | undefined;
    let bestPriority = -Infinity;
    let foundChordPrefix = false;

    const currentCombo = this.eventToCombo(event);

    for (const binding of this.bindings.values()) {
      if (!this.canExecute(binding.actionId)) continue;

      const effectiveCombo = this.getEffectiveCombo(binding.actionId);
      if (!effectiveCombo) continue;

      // Check if this is a chord binding
      const chordParts = effectiveCombo.split(" ");
      const isChord = chordParts.length > 1;

      if (isChord) {
        // If we have a pending chord, check if this completes it
        if (this.pendingChord) {
          const fullChord = `${this.pendingChord} ${currentCombo}`;
          if (fullChord === effectiveCombo) {
            if (binding.priority > bestPriority) {
              bestMatch = binding;
              bestPriority = binding.priority;
            }
          }
        } else {
          // Check if this is the start of a chord
          if (currentCombo === chordParts[0]) {
            foundChordPrefix = true;
          }
        }
      } else {
        // Regular non-chord binding
        if (this.matchesEvent(event, effectiveCombo)) {
          if (binding.priority > bestPriority) {
            bestMatch = binding;
            bestPriority = binding.priority;
          }
        }
      }
    }

    // If we found a chord prefix but no complete match, set pending chord
    if (foundChordPrefix && !bestMatch && !this.pendingChord) {
      this.setPendingChord(currentCombo);
      return undefined;
    }

    // Clear pending chord if we found a match or no chord prefix
    if (bestMatch || !foundChordPrefix) {
      this.clearPendingChord();
    }

    return bestMatch;
  }

  registerBinding(config: KeybindingConfig): void {
    this.bindings.set(config.actionId, config);
  }

  removeBinding(actionId: string): void {
    this.bindings.delete(actionId);
  }

  getDisplayCombo(actionId: string): string {
    const effectiveCombo = this.getEffectiveCombo(actionId);
    if (!effectiveCombo) return "";

    return this.formatComboForDisplay(effectiveCombo);
  }

  formatComboForDisplay(combo: string): string {
    const isMac =
      typeof navigator !== "undefined" &&
      navigator.platform &&
      navigator.platform.toUpperCase().indexOf("MAC") >= 0;

    let display = combo;
    if (isMac) {
      display = display.replace(/Cmd\+/gi, "⌘");
      display = display.replace(/Ctrl\+/gi, "⌃");
      display = display.replace(/Shift\+/gi, "⇧");
      display = display.replace(/Alt\+/gi, "⌥");
    } else {
      display = display.replace(/Cmd\+/gi, "Ctrl+");
    }

    return display;
  }

  getAllBindingsWithEffectiveCombos(): Array<KeybindingConfig & { effectiveCombo: string }> {
    return Array.from(this.bindings.values()).map((binding) => {
      const effectiveCombo = this.getEffectiveCombo(binding.actionId);
      return {
        ...binding,
        effectiveCombo: effectiveCombo !== undefined ? effectiveCombo : binding.combo,
      };
    });
  }

  getCategories(): string[] {
    const categories = new Set<string>();
    for (const binding of this.bindings.values()) {
      if (binding.category) {
        categories.add(binding.category);
      }
    }
    return Array.from(categories).sort();
  }

  getOverridesSnapshot(): Record<string, string[]> {
    return Object.fromEntries(this.overrides.entries());
  }
}

export const keybindingService = new KeybindingService();
export { KeybindingService };
