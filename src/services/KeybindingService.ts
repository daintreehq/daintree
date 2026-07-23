import type {
  KeyScope,
  RegisteredKeybindingConfig,
  KeybindingConflict,
  KeybindingResolutionResult,
} from "./keybindingUtils";
import { combosFieldsEqual, normalizeKeyForBinding, parseCombo } from "./keybindingUtils";
import { DEFAULT_KEYBINDINGS } from "./defaultKeybindings";
import { isMac } from "@/lib/platform";
import { BUILT_IN_ACTION_IDS } from "@shared/config/actionIds";
import { KEY_ACTION_VALUES } from "@shared/types/keymap";
import { evaluate } from "@shared/utils/whenClause/evaluator";
import { parse } from "@shared/utils/whenClause/parser";
import type { WhenClauseContext } from "@shared/utils/whenClause/types";
import { formatErrorMessage } from "@shared/utils/errorMessage";

export * from "./keybindingUtils";
export * from "./defaultKeybindings";

function scopesConflict(a: KeyScope, b: KeyScope): boolean {
  return a === b || a === "global" || b === "global";
}

const builtInActionIdSet: ReadonlySet<string> = new Set([
  ...BUILT_IN_ACTION_IDS,
  ...KEY_ACTION_VALUES,
]);

const whenAstCache = new Map<string, ReturnType<typeof parse>>();

function evaluateWhenClause(when: string, ctx: WhenClauseContext): boolean {
  try {
    let ast = whenAstCache.get(when);
    if (!ast) {
      ast = parse(when);
      whenAstCache.set(when, ast);
    }
    return evaluate(ast, ctx);
  } catch {
    return false;
  }
}

class KeybindingService {
  private bindings: Map<string, RegisteredKeybindingConfig[]> = new Map();
  private overrides: Map<string, string[]> = new Map();
  private scopeStack: KeyScope[] = ["global"];
  private currentScope: KeyScope = "global";
  private pendingChord: string | null = null;
  private lastInvalidKey: string | null = null;
  private chordTimeout: NodeJS.Timeout | null = null;
  private listeners = new Set<() => void>();
  private whenContext: WhenClauseContext = {};
  private whenContextProvider: ((event: KeyboardEvent) => WhenClauseContext) | null = null;

  constructor() {
    DEFAULT_KEYBINDINGS.forEach((binding) => {
      const existing = this.bindings.get(binding.actionId);
      if (existing) {
        existing.push(binding);
      } else {
        this.bindings.set(binding.actionId, [binding]);
      }
    });
  }

  /**
   * Replace the in-memory overrides with an already-fetched payload — same
   * validation as `loadOverrides()` minus the IPC round-trip. Used by the
   * hydration bootstrap to seed overrides from the batched `app:boot` payload.
   */
  applyOverrides(overrides: Record<string, string[]> | undefined): void {
    this.overrides.clear();
    if (overrides && typeof overrides === "object") {
      for (const [actionId, combos] of Object.entries(overrides)) {
        if (!Array.isArray(combos)) continue;
        if (!builtInActionIdSet.has(actionId) && !this.bindings.has(actionId)) {
          console.warn(
            `[KeybindingService] Dropping override for unknown action "${actionId}" — not a built-in or registered binding.`
          );
          continue;
        }
        this.overrides.set(actionId, combos as string[]);
      }
    }
    this.notifyListeners();
  }

  async loadOverrides(): Promise<void> {
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      try {
        const overrides = await window.electron.keybinding.getOverrides();
        this.applyOverrides(overrides);
      } catch (error) {
        // Mirrors useUserAgentRegistryStore.initialize() — non-fatal degradation.
        // `this.bindings` retains DEFAULT_KEYBINDINGS (seeded in constructor).
        // On a fresh service, `this.overrides` is empty, so the user gets stock
        // shortcuts. On a service that has loaded overrides before, the prior
        // overrides persist as last-known-good — a failed reload does not
        // silently clobber the user's customizations. The caller (hydrate
        // bootstrap, settings tabs, settings-changed IPC) keeps running
        // instead of aborting the entire session restore.
        console.warn(
          `[KeybindingService] Failed to load keybinding overrides; keeping prior state: ${formatErrorMessage(error, "Unknown keybinding override load failure")}`
        );
      }
    }
  }

  async setOverride(actionId: string, combo: string[]): Promise<void> {
    // A pending chord captured under the old binding may now reference a stale
    // combo. Drop it before the rebind so the next keypress starts fresh.
    this.clearPendingChord();
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.setOverride(actionId, combo);
      this.overrides.set(actionId, combo);
      this.notifyListeners();
    }
  }

  async removeOverride(actionId: string): Promise<void> {
    this.clearPendingChord();
    if (typeof window !== "undefined" && window.electron?.keybinding) {
      await window.electron.keybinding.removeOverride(actionId);
      this.overrides.delete(actionId);
      this.notifyListeners();
    }
  }

  async resetAllOverrides(): Promise<void> {
    this.clearPendingChord();
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
    return this.getBinding(actionId)?.combo;
  }

  // Detects clashes for a candidate `combo` against currently registered bindings.
  // Two clash kinds:
  //   "conflict" — same combo string in an overlapping scope.
  //   "shadowed" — chord-prefix collision (either the candidate is a prefix of an
  //     existing chord, or an existing combo is a prefix of the candidate chord).
  // The optional `scope` defaults to "global" so callers that don't yet thread a
  // target scope still get correct conservative results: a global candidate
  // collides with both global and scoped bindings, mirroring `scopesConflict`.
  findConflicts(
    combo: string,
    excludeActionId?: string,
    scope: KeyScope = "global"
  ): KeybindingConflict[] {
    const conflicts: KeybindingConflict[] = [];
    const candidateParts = combo.trim().split(/\s+/).filter(Boolean);
    if (candidateParts.length === 0) return conflicts;

    for (const arr of this.bindings.values()) {
      for (const binding of arr) {
        if (excludeActionId && binding.actionId === excludeActionId) continue;
        if (!scopesConflict(binding.scope, scope)) continue;

        const hasOverride = this.overrides.has(binding.actionId);
        const overrideCombos = this.overrides.get(binding.actionId) || [];
        const effectiveCombos = hasOverride ? overrideCombos : binding.combo ? [binding.combo] : [];

        let matched: "conflict" | "shadowed" | null = null;
        for (const existingCombo of effectiveCombos) {
          const existingParts = existingCombo.trim().split(/\s+/).filter(Boolean);
          if (existingParts.length === 0) continue;
          if (
            existingParts.length === candidateParts.length &&
            existingParts.every((p, i) => combosFieldsEqual(p, candidateParts[i]!))
          ) {
            matched = "conflict";
            break;
          }

          const candidateIsPrefix =
            candidateParts.length < existingParts.length &&
            candidateParts.every((p, i) => combosFieldsEqual(p, existingParts[i]!));
          const existingIsPrefix =
            existingParts.length < candidateParts.length &&
            existingParts.every((p, i) => combosFieldsEqual(p, candidateParts[i]!));
          if (candidateIsPrefix || existingIsPrefix) {
            matched = "shadowed";
            // Don't break: a later combo on the same binding might be an exact
            // conflict, which outranks "shadowed".
          }
        }

        if (matched) {
          conflicts.push({ ...binding, kind: matched });
        }
      }
    }
    return conflicts;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const snapshot = Array.from(this.listeners);
    for (const listener of snapshot) {
      try {
        listener();
      } catch (error) {
        console.warn("[KeybindingService] listener threw", error);
      }
    }
  }

  setScope(scope: KeyScope): void {
    // The stack stores duplicates intentionally — concurrent component instances
    // pushing the same scope are valid, and restoreScope pops by lastIndexOf so
    // counts stay correct. Only the active-scope transition is observable, so
    // skip the chord clear when the new scope is already on top.
    this.scopeStack.push(scope);
    if (this.currentScope !== scope) {
      this.currentScope = scope;
      this.clearPendingChord();
    }
  }

  restoreScope(scope: KeyScope): void {
    const idx = this.scopeStack.lastIndexOf(scope);
    if (idx > 0) {
      this.scopeStack.splice(idx, 1);
    }
    this.currentScope = this.scopeStack[this.scopeStack.length - 1] ?? "global";
    if (this.currentScope !== scope) {
      this.clearPendingChord();
    }
  }

  setWhenContext(ctx: WhenClauseContext): void {
    this.whenContext = ctx;
  }

  /**
   * Lazy `when`-clause context source. Called at most once per keydown, only
   * when a candidate binding carries a `when` clause — mirrors ActionService's
   * context-provider pattern so the snapshot is always live (no stale
   * subscriptions or partial event-driven updates). The static
   * `setWhenContext` value is the fallback when no provider is wired (tests).
   */
  setWhenContextProvider(provider: ((event: KeyboardEvent) => WhenClauseContext) | null): void {
    this.whenContextProvider = provider;
  }

  getScope(): KeyScope {
    return this.currentScope;
  }

  getBinding(actionId: string): RegisteredKeybindingConfig | undefined {
    const arr = this.bindings.get(actionId);
    if (!arr || arr.length === 0) return undefined;
    const scopeMatch = arr.find((b) => b.scope === this.currentScope);
    return scopeMatch ?? arr[0];
  }

  getAllBindings(): RegisteredKeybindingConfig[] {
    return Array.from(this.bindings.values()).flat();
  }

  matchesEvent(event: KeyboardEvent, combo: string): boolean {
    return this.matchesEventInternal(event, combo, isMac(), normalizeKeyForBinding(event));
  }

  // resolveKeybinding iterates every registered binding per keydown — the
  // platform check and event-key normalization are per-event invariants, so
  // callers hoist them out of the loop and pass them in.
  private matchesEventInternal(
    event: KeyboardEvent,
    combo: string,
    mac: boolean,
    eventKey: string
  ): boolean {
    // Chord sequences (e.g., "Cmd+K Cmd+K") should not be matched here.
    // They are handled by findMatchingAction's chord state machine.
    if (combo.includes(" ")) {
      return false;
    }

    const parsed = parseCombo(combo);

    // Handle Cmd vs Ctrl based on platform
    // On macOS, Cmd (metaKey) is the primary modifier
    // On Windows/Linux, Ctrl is the primary modifier
    const hasCmd = mac ? event.metaKey : event.ctrlKey;

    // AltGr on Windows synthesizes ctrlKey+altKey on the keyboard event. Reject
    // the match early so international character input (€, @, {, etc.) is never
    // swallowed by a Cmd/Ctrl+Alt binding that happens to share the produced
    // character or the underlying physical key. (#7941)
    if (!mac && event.getModifierState?.("AltGraph")) return false;

    // Check modifiers
    if (parsed.cmd && !hasCmd) return false;
    if (parsed.ctrl && !event.ctrlKey) return false;
    if (parsed.shift && !event.shiftKey) return false;
    if (parsed.alt && !event.altKey) return false;

    // Check that we don't have extra modifiers
    // (unless the combo expects them)
    if (!parsed.cmd && !parsed.ctrl && hasCmd) return false;
    if (!parsed.shift && event.shiftKey) return false;
    if (!parsed.alt && event.altKey) return false;
    // Ctrl check is more nuanced due to Cmd/Ctrl swap
    if (!parsed.cmd && !parsed.ctrl && event.ctrlKey && !mac) return false;
    // On macOS, reject unexpected Ctrl when not explicitly required
    if (mac && !parsed.ctrl && event.ctrlKey) return false;

    // Check key - eventKey comes from normalizeKeyForBinding (handles
    // Alt-modified characters). Try exact match on the normalized key.
    if (eventKey.toLowerCase() === parsed.key.toLowerCase()) return true;

    // Legacy compatibility for the physical digit-row path: combos recorded
    // before that normalization stored the produced character ("Cmd+Shift+!"
    // on US, "Cmd+&" on AZERTY). When normalization rewrote the event key to
    // a digit, also accept the raw produced character so persisted rebinds
    // keep firing.
    if (
      /^[0-9]$/.test(eventKey) &&
      event.key.length === 1 &&
      event.key !== eventKey &&
      event.key.toLowerCase() === parsed.key.toLowerCase()
    ) {
      return true;
    }

    return false;
  }

  canExecute(actionId: string): boolean {
    const arr = this.bindings.get(actionId);
    if (!arr || arr.length === 0) return false;
    return arr.some((b) => b.scope === "global" || b.scope === this.currentScope);
  }

  private clearChordTimeout(): void {
    if (this.chordTimeout) {
      clearTimeout(this.chordTimeout);
      this.chordTimeout = null;
    }
  }

  private setPendingChord(combo: string): void {
    // No auto-cancel timeout: a pending chord (e.g. the Cmd+K command HUD)
    // persists until it's completed, cancelled (Esc/Backspace), the window
    // blurs, or the scope/overrides change. clearChordTimeout() is kept as a
    // harmless no-op so any residual timeout from an earlier code path clears.
    this.clearChordTimeout();
    this.pendingChord = combo;
    this.notifyListeners();
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

  popPendingChord(): void {
    this.clearPendingChord();
  }

  getLastInvalidKey(): string | null {
    return this.lastInvalidKey;
  }

  clearLastInvalidKey(): void {
    if (this.lastInvalidKey === null) return;
    this.lastInvalidKey = null;
    this.notifyListeners();
  }

  normalizeKeyForBinding(event: KeyboardEvent): string {
    return normalizeKeyForBinding(event);
  }

  private eventToCombo(event: KeyboardEvent): string {
    const parts: string[] = [];
    const mac = isMac();

    if (mac && event.metaKey) parts.push("Cmd");
    if (!mac && event.ctrlKey) parts.push("Cmd");
    if (event.shiftKey) parts.push("Shift");
    if (event.altKey) parts.push("Alt");
    // Use normalizeKeyForBinding to handle Alt-modified characters on macOS
    parts.push(normalizeKeyForBinding(event));

    return parts.join("+");
  }

  resolveKeybinding(event: KeyboardEvent): KeybindingResolutionResult {
    let bestMatch: RegisteredKeybindingConfig | undefined;
    let bestPriority = -Infinity;
    let foundChordPrefix = false;

    const currentCombo = this.eventToCombo(event);
    const mac = isMac();
    const eventKey = normalizeKeyForBinding(event);

    // When a chord is pending, prioritize chord completion over standalone shortcuts
    let chordCompletionMatch: RegisteredKeybindingConfig | undefined;
    let chordCompletionPriority = -Infinity;

    // One live snapshot per keydown, computed only when some candidate
    // actually carries a `when` clause. Each chord step gets its own snapshot
    // (conditions may change between prefix and completion).
    let whenCtx: WhenClauseContext | null = null;
    const resolveWhenCtx = (): WhenClauseContext => {
      whenCtx ??= this.whenContextProvider?.(event) ?? this.whenContext;
      return whenCtx;
    };

    for (const arr of this.bindings.values()) {
      for (const binding of arr) {
        if (!this.scopeAllows(binding.scope)) continue;
        if (binding.when && !evaluateWhenClause(binding.when, resolveWhenCtx())) continue;

        const hasOverride = this.overrides.has(binding.actionId);
        const effectiveCombo = hasOverride
          ? this.overrides.get(binding.actionId)?.[0]
          : binding.combo;
        if (!effectiveCombo) continue;

        // Check if this is a chord binding
        const chordParts = effectiveCombo.split(" ");
        const isChord = chordParts.length > 1;

        if (isChord) {
          // Match chord parts via parseCombo field equality so user-stored overrides
          // with non-canonical modifier order (e.g. "Alt+Cmd+T") match the canonical
          // order produced by eventToCombo. matchesEvent uses parseCombo internally.
          if (this.pendingChord) {
            if (
              combosFieldsEqual(this.pendingChord, chordParts[0]!, mac) &&
              this.matchesEventInternal(event, chordParts[1]!, mac, eventKey)
            ) {
              if (binding.priority > chordCompletionPriority) {
                chordCompletionMatch = binding;
                chordCompletionPriority = binding.priority;
              }
            }
          } else {
            // Check if this is the start of a chord
            if (this.matchesEventInternal(event, chordParts[0]!, mac, eventKey)) {
              foundChordPrefix = true;
            }
          }
        } else {
          // Regular non-chord binding - only consider if no chord is pending
          if (
            !this.pendingChord &&
            this.matchesEventInternal(event, effectiveCombo, mac, eventKey)
          ) {
            if (binding.priority > bestPriority) {
              bestMatch = binding;
              bestPriority = binding.priority;
            }
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

    // When a pending chord exists and the second key is neither a chord
    // completion nor a recognized standalone, surface the attempted combo
    // so the HUD can echo it, AND consume the event so the key doesn't
    // leak through to xterm (bare key types in the terminal) or fire a
    // side-effecting standalone action (e.g. Cmd+B → nav.toggleSidebar)
    // that the user only pressed as part of the cancelled chord.
    const invalidChordKey = this.pendingChord !== null && !bestMatch && !foundChordPrefix;

    // Clear pending chord if we found a match or no chord prefix
    if (bestMatch || !foundChordPrefix) {
      // lastInvalidKey must be set before clearPendingChord() — the
      // synchronous notifyListeners() call inside that method is when
      // subscribers read the snapshot.
      if (invalidChordKey) {
        this.lastInvalidKey = currentCombo;
      }
      this.clearPendingChord();
    }

    return {
      match: bestMatch,
      chordPrefix: foundChordPrefix,
      shouldConsume: !!bestMatch || foundChordPrefix || invalidChordKey,
    };
  }

  private scopeAllows(scope: KeyScope): boolean {
    return scope === "global" || scope === this.currentScope;
  }

  findMatchingAction(event: KeyboardEvent): RegisteredKeybindingConfig | undefined {
    const result = this.resolveKeybinding(event);
    return result.match;
  }

  registerBinding(config: RegisteredKeybindingConfig): void {
    if (config.combo) {
      for (const arr of this.bindings.values()) {
        for (const existing of arr) {
          if (existing.actionId === config.actionId) continue;
          // Compare against the EFFECTIVE combo — a user override remaps where a
          // built-in actually fires, so a plugin binding at the overridden combo
          // would otherwise slip past this guard and then win at resolution
          // (PLUGIN priority > DEFAULT). Fall back to the stored combo when no
          // override exists.
          const effectiveCombo = this.getEffectiveCombo(existing.actionId) ?? existing.combo;
          if (!effectiveCombo) continue;
          if (!combosFieldsEqual(effectiveCombo, config.combo)) continue;
          if (!scopesConflict(existing.scope, config.scope)) continue;
          console.warn(
            `[KeybindingService] Skipping binding for "${config.actionId}" (${config.combo}, scope=${config.scope}) — combo already registered to "${existing.actionId}" (scope=${existing.scope}). Use setOverride() to rebind.`
          );
          return;
        }
      }
    }
    const arr = this.bindings.get(config.actionId);
    if (arr) {
      // Replace only on a true self-update: the existing same-combo entry must
      // share this config's owner (both built-in/user with no pluginId, or the
      // same pluginId). Replacing a differently-owned entry would let a plugin
      // clobber a built-in binding for the same action+combo — and destroy it on
      // unload, since removePluginBindings() filters by pluginId. Push instead so
      // both coexist; resolution picks by priority and unload only drops the plugin's.
      const existingIdx = arr.findIndex(
        (b) => b.combo?.trim().toLowerCase() === config.combo?.trim().toLowerCase()
      );
      if (existingIdx !== -1 && arr[existingIdx]!.pluginId === config.pluginId) {
        arr[existingIdx] = config;
      } else {
        arr.push(config);
      }
    } else {
      this.bindings.set(config.actionId, [config]);
    }
    // Dynamic registrations (plugin load) must flush to subscribers — the
    // shortcuts reference, settings tab, and hint hovers read from this snapshot.
    this.notifyListeners();
  }

  removePluginBindings(pluginId: string): void {
    let changed = false;
    for (const [actionId, bindings] of this.bindings.entries()) {
      const filtered = bindings.filter((b) => b.pluginId !== pluginId);
      if (filtered.length === bindings.length) {
        continue;
      }
      changed = true;
      if (filtered.length === 0) {
        this.bindings.delete(actionId);
      } else {
        this.bindings.set(actionId, filtered);
      }
    }
    if (changed) {
      this.notifyListeners();
    }
  }

  removeBinding(actionId: string): void {
    if (this.bindings.delete(actionId)) {
      this.notifyListeners();
    }
  }

  getDisplayCombo(actionId: string): string {
    const effectiveCombo = this.getEffectiveCombo(actionId);
    if (!effectiveCombo) return "";

    return this.formatComboForDisplay(effectiveCombo);
  }

  formatComboForDisplay(combo: string): string {
    const mac = isMac();

    let display = combo;
    if (mac) {
      display = display.replace(/Cmd\+/gi, "⌘+");
      display = display.replace(/Ctrl\+/gi, "⌃+");
      display = display.replace(/Shift\+/gi, "⇧+");
      display = display.replace(/Alt\+/gi, "⌥+");
    } else {
      display = display.replace(/Cmd\+/gi, "Ctrl+");
    }

    return display;
  }

  getAllBindingsWithEffectiveCombos(): Array<
    RegisteredKeybindingConfig & { effectiveCombo: string }
  > {
    return Array.from(this.bindings.values())
      .flat()
      .map((binding) => {
        const effectiveCombo = this.getEffectiveCombo(binding.actionId);
        return {
          ...binding,
          effectiveCombo: effectiveCombo ?? "",
        };
      });
  }

  getCategories(): string[] {
    const categories = new Set<string>();
    for (const arr of this.bindings.values()) {
      for (const binding of arr) {
        if (binding.category) {
          categories.add(binding.category);
        }
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
      if (parts[0]!.toLowerCase() !== normalizedPrefix) continue;

      const nextKey = parts[1];
      if (nextKey === undefined) continue;
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
      if (parts[0]!.toLowerCase() !== normalizedPrefix) continue;

      const secondKey = parts[1];
      if (secondKey === undefined) continue;
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
