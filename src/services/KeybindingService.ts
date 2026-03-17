import type { KeyAction } from "../../shared/types/keymap.js";

import type { KeyScope, KeybindingConfig, KeybindingResolutionResult } from "./keybindingUtils";
import { normalizeKeyForBinding, parseCombo } from "./keybindingUtils";
import { DEFAULT_KEYBINDINGS } from "./defaultKeybindings";

export * from "./keybindingUtils";
export * from "./defaultKeybindings";

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
      await window.electron.keybinding.setOverride(actionId as KeyAction, combo);
      this.overrides.set(actionId, combo);
      this.notifyListeners();
    }
  }

  async removeOverride(actionId: string): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.removeOverride(actionId as KeyAction);
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
    return this.bindings.get(actionId)?.combo;
  }

  findConflicts(combo: string, excludeActionId?: string): KeybindingConfig[] {
    const conflicts: KeybindingConfig[] = [];
    const normalizedCombo = combo.trim().toLowerCase();

    for (const binding of this.bindings.values()) {
      if (excludeActionId && binding.actionId === excludeActionId) continue;

      const hasOverride = this.overrides.has(binding.actionId);
      const overrideCombos = this.overrides.get(binding.actionId) || [];
      const allCombos = [...overrideCombos];

      if (!hasOverride) {
        if (binding.combo) {
          allCombos.push(binding.combo);
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

    // Check key - use normalizeKeyForBinding to handle Alt-modified characters
    const eventKey = normalizeKeyForBinding(event);

    // Try exact match on the normalized key
    if (eventKey.toLowerCase() === parsed.key.toLowerCase()) return true;

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
    this.notifyListeners();
    this.chordTimeout = setTimeout(() => {
      this.pendingChord = null;
      this.chordTimeout = null;
      this.notifyListeners();
    }, this.CHORD_TIMEOUT_MS);
  }

  getPendingChord(): string | null {
    return this.pendingChord;
  }

  clearPendingChord(): void {
    const hadChord = this.pendingChord !== null;
    this.clearChordTimeout();
    this.pendingChord = null;
    if (hadChord) {
      this.notifyListeners();
    }
  }

  normalizeKeyForBinding(event: KeyboardEvent): string {
    return normalizeKeyForBinding(event);
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
    // Use normalizeKeyForBinding to handle Alt-modified characters on macOS
    parts.push(normalizeKeyForBinding(event));

    return parts.join("+");
  }

  resolveKeybinding(event: KeyboardEvent): KeybindingResolutionResult {
    let bestMatch: KeybindingConfig | undefined;
    let bestPriority = -Infinity;
    let foundChordPrefix = false;

    const currentCombo = this.eventToCombo(event);
    const normalizedCurrentCombo = currentCombo.trim().toLowerCase();

    // When a chord is pending, prioritize chord completion over standalone shortcuts
    let chordCompletionMatch: KeybindingConfig | undefined;
    let chordCompletionPriority = -Infinity;

    for (const binding of this.bindings.values()) {
      if (!this.canExecute(binding.actionId)) continue;

      const effectiveCombo = this.getEffectiveCombo(binding.actionId);
      if (!effectiveCombo) continue;
      const normalizedEffectiveCombo = effectiveCombo.trim().toLowerCase();

      // Check if this is a chord binding
      const chordParts = effectiveCombo.split(" ");
      const isChord = chordParts.length > 1;

      if (isChord) {
        // If we have a pending chord, check if this completes it
        if (this.pendingChord) {
          const normalizedPending = this.pendingChord.trim().toLowerCase();
          const fullChord = `${normalizedPending} ${normalizedCurrentCombo}`;
          if (fullChord === normalizedEffectiveCombo) {
            if (binding.priority > chordCompletionPriority) {
              chordCompletionMatch = binding;
              chordCompletionPriority = binding.priority;
            }
          }
        } else {
          // Check if this is the start of a chord
          if (normalizedCurrentCombo === chordParts[0].trim().toLowerCase()) {
            foundChordPrefix = true;
          }
        }
      } else {
        // Regular non-chord binding - only consider if no chord is pending
        if (!this.pendingChord && this.matchesEvent(event, effectiveCombo)) {
          if (binding.priority > bestPriority) {
            bestMatch = binding;
            bestPriority = binding.priority;
          }
        }
      }
    }

    // If chord completion was found, it takes precedence
    if (chordCompletionMatch) {
      bestMatch = chordCompletionMatch;
    }

    // If we found a chord prefix but no complete match, set pending chord
    if (foundChordPrefix && !bestMatch && !this.pendingChord) {
      this.setPendingChord(currentCombo);
      return {
        match: undefined,
        chordPrefix: true,
        shouldConsume: true,
      };
    }

    // Clear pending chord if we found a match or no chord prefix
    if (bestMatch || !foundChordPrefix) {
      this.clearPendingChord();
    }

    return {
      match: bestMatch,
      chordPrefix: foundChordPrefix,
      shouldConsume: !!bestMatch || foundChordPrefix,
    };
  }

  findMatchingAction(event: KeyboardEvent): KeybindingConfig | undefined {
    const result = this.resolveKeybinding(event);
    return result.match;
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
        effectiveCombo: effectiveCombo ?? "",
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

  getChordCompletions(prefix: string): Array<{
    secondKey: string;
    displayKey: string;
    actionId: string;
    description: string;
    category: string;
    isPrefix: boolean;
  }> {
    const normalizedPrefix = prefix.trim().toLowerCase();
    const results: Array<{
      secondKey: string;
      displayKey: string;
      actionId: string;
      description: string;
      category: string;
      isPrefix: boolean;
    }> = [];

    const allBindings = this.getAllBindingsWithEffectiveCombos();

    // Track which second keys lead to deeper chords (3+ part combos)
    const deeperPrefixes = new Map<string, { key: string; category: string }>();
    const addedSecondKeys = new Set<string>();

    // First pass: detect deeper chord prefixes (scope-filtered)
    for (const binding of allBindings) {
      if (!this.canExecute(binding.actionId)) continue;
      if (!binding.effectiveCombo) continue;
      const parts = binding.effectiveCombo.trim().split(" ");
      if (parts.length < 3) continue;
      if (parts[0].toLowerCase() !== normalizedPrefix) continue;

      const nextKey = parts[1];
      const normalizedNext = nextKey.toLowerCase();
      if (!deeperPrefixes.has(normalizedNext)) {
        deeperPrefixes.set(normalizedNext, {
          key: nextKey,
          category: binding.category ?? "Other",
        });
      }
    }

    // Second pass: build results for 2-part chords matching prefix
    for (const binding of allBindings) {
      if (!this.canExecute(binding.actionId)) continue;

      const combo = binding.effectiveCombo.trim();
      const parts = combo.split(" ");
      if (parts.length !== 2) continue;
      if (parts[0].toLowerCase() !== normalizedPrefix) continue;

      const secondKey = parts[1];
      const normalizedSecond = secondKey.toLowerCase();
      addedSecondKeys.add(normalizedSecond);

      results.push({
        secondKey,
        displayKey: this.formatComboForDisplay(secondKey),
        actionId: binding.actionId,
        description: binding.description ?? "",
        category: binding.category ?? "Other",
        isPrefix: deeperPrefixes.has(normalizedSecond),
      });
    }

    // Third pass: add synthetic entries for sub-prefixes with no direct 2-part binding
    for (const [normalizedKey, info] of deeperPrefixes) {
      if (addedSecondKeys.has(normalizedKey)) continue;

      results.push({
        secondKey: info.key,
        displayKey: this.formatComboForDisplay(info.key),
        actionId: "",
        description: "...",
        category: info.category,
        isPrefix: true,
      });
    }

    return results;
  }
}

export const keybindingService = new KeybindingService();
export { KeybindingService };
