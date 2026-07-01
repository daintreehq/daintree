import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
  KeybindingService,
  normalizeKey,
  normalizeKeyForBinding,
  type RegisteredKeybindingConfig,
} from "../KeybindingService";

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

function createKeyboardEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("KeybindingService", () => {
  beforeEach(() => {
    setPlatform("MacIntel");
  });

  it("normalizes key aliases", () => {
    expect(normalizeKey("escape")).toBe("Escape");
    expect(normalizeKey("return")).toBe("Enter");
    expect(normalizeKey(" ")).toBe("Space");
    expect(normalizeKey("X")).toBe("X");
  });

  it("normalizes mac alt-letter combos from physical key code", () => {
    setPlatform("MacIntel");

    const event = createKeyboardEvent({
      key: "π",
      code: "KeyP",
      altKey: true,
    });

    expect(normalizeKeyForBinding(event)).toBe("P");
  });

  it("normalizes punctuation keys from physical key code", () => {
    setPlatform("MacIntel");

    const event = createKeyboardEvent({
      key: "÷",
      code: "Slash",
      altKey: true,
    });

    expect(normalizeKeyForBinding(event)).toBe("/");
  });

  describe("AltGr and non-US layout key handling", () => {
    function altGraphModifierState(): (key: string) => boolean {
      return (key: string) => key === "AltGraph";
    }

    // ── normalizeKeyForBinding (utility layer) ──────────────────

    it("returns the produced character on Windows AltGr+E, not the physical key", () => {
      setPlatform("Win32");

      const event = createKeyboardEvent({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(normalizeKeyForBinding(event)).toBe("€");
    });

    it("returns the produced character on Windows AltGr+digit, not the physical key", () => {
      setPlatform("Win32");

      const event = createKeyboardEvent({
        key: "{",
        code: "Digit8",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(normalizeKeyForBinding(event)).toBe("{");
    });

    it("returns the physical key on macOS Option-letter (contrast with Windows AltGr)", () => {
      setPlatform("MacIntel");

      const event = createKeyboardEvent({
        key: "π",
        code: "KeyP",
        altKey: true,
      });

      expect(normalizeKeyForBinding(event)).toBe("P");
    });

    // ── matchesEvent (matcher layer) ────────────────────────────

    it("rejects Ctrl+Alt+E when AltGr produces € on Windows", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+E")).toBe(false);
    });

    it("rejects Ctrl+Alt+Q when AltGr produces @ on Windows", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "@",
        code: "KeyQ",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+Q")).toBe(false);
    });

    it("rejects Ctrl+Alt+E on Linux AltGr (neither modifier flag is set)", () => {
      setPlatform("Linux x86_64");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "€",
        code: "KeyE",
        getModifierState: altGraphModifierState(),
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+E")).toBe(false);
    });

    it("rejects Ctrl+Alt+E on Linux AltGr when ctrlKey+altKey are also synthesized", () => {
      // Some X11/Wayland setups synthesize ctrlKey+altKey alongside the
      // AltGraph modifier. The explicit guard must still reject the match.
      setPlatform("Linux x86_64");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+E")).toBe(false);
    });

    it("matches legitimate Ctrl+Alt+E on US-layout Windows (positive control)", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "E",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+E")).toBe(true);
    });

    it("rejects bare-key { when AltGr modifiers are present on Windows", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "{",
        code: "Digit8",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.matchesEvent(event, "{")).toBe(false);
    });

    // ── findMatchingAction (pipeline layer) ─────────────────────

    it("does not resolve a Ctrl+Alt+E action from AltGr+E on Windows", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.ctrlAltE",
        combo: "Ctrl+Alt+E",
        scope: "global",
        priority: 99,
      });

      const event = createKeyboardEvent({
        key: "€",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.findMatchingAction(event)).toBeUndefined();
    });

    it("resolves a Ctrl+Alt+E action from legitimate Ctrl+Alt+E on US-layout Windows", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.ctrlAltE",
        combo: "Ctrl+Alt+E",
        scope: "global",
        priority: 99,
      });

      const event = createKeyboardEvent({
        key: "E",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
      });

      expect(service.findMatchingAction(event)?.actionId).toBe("test.ctrlAltE");
    });

    it("does not resolve a Cmd+Alt+Q agent-launch binding from AltGr+Q on Windows — #1678 guard", () => {
      setPlatform("Win32");

      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.agentLaunch",
        combo: "Cmd+Alt+Q",
        scope: "global",
        priority: 99,
      });

      const event = createKeyboardEvent({
        key: "@",
        code: "KeyQ",
        ctrlKey: true,
        altKey: true,
        getModifierState: altGraphModifierState(),
      });

      expect(service.findMatchingAction(event)).toBeUndefined();
    });
  });

  it("matches Cmd bindings on non-mac when Ctrl is pressed", () => {
    setPlatform("Win32");

    const service = new KeybindingService();
    const event = createKeyboardEvent({
      key: "t",
      code: "KeyT",
      ctrlKey: true,
    });

    expect(service.matchesEvent(event, "Cmd+T")).toBe(true);
  });

  it("matches literal Ctrl bindings on non-mac when Ctrl is pressed", () => {
    setPlatform("Win32");

    const service = new KeybindingService();
    const event = createKeyboardEvent({
      key: "Tab",
      code: "Tab",
      ctrlKey: true,
    });

    expect(service.matchesEvent(event, "Ctrl+Tab")).toBe(true);
  });

  it("resolves Ctrl+Tab terminal focus bindings on non-mac", () => {
    setPlatform("Win32");

    const service = new KeybindingService();
    const forward = createKeyboardEvent({
      key: "Tab",
      code: "Tab",
      ctrlKey: true,
    });
    const backward = createKeyboardEvent({
      key: "Tab",
      code: "Tab",
      ctrlKey: true,
      shiftKey: true,
    });

    expect(service.findMatchingAction(forward)?.actionId).toBe("terminal.focusNext");
    expect(service.findMatchingAction(backward)?.actionId).toBe("terminal.focusPrevious");
  });

  it("supports two-key chord matching", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    service.registerBinding({
      actionId: "test.chord",
      combo: "Cmd+K Cmd+Z",
      scope: "global",
      priority: 99,
    });

    const first = createKeyboardEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
    });
    const second = createKeyboardEvent({
      key: "z",
      code: "KeyZ",
      metaKey: true,
    });

    expect(service.findMatchingAction(first)).toBeUndefined();
    const match = service.findMatchingAction(second);
    expect(match?.actionId).toBe("test.chord");
  });

  it("resolves Cmd+W to terminal.close in global scope", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    const event = createKeyboardEvent({
      key: "w",
      code: "KeyW",
      metaKey: true,
    });

    const match = service.findMatchingAction(event);
    expect(match?.actionId).toBe("terminal.close");
  });

  it("resolves Cmd+W to portal.closeTab (priority 20) over terminal.close (priority 10) in portal scope", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    service.setScope("portal");

    const event = createKeyboardEvent({
      key: "w",
      code: "KeyW",
      metaKey: true,
    });

    const match = service.findMatchingAction(event);
    expect(match?.actionId).toBe("portal.closeTab");
    expect(match?.priority).toBe(20);
  });

  it("resolves Cmd+K Cmd+W chord to terminal.closeAll, not terminal.close", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    const cmdK = createKeyboardEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
    });
    const cmdW = createKeyboardEvent({
      key: "w",
      code: "KeyW",
      metaKey: true,
    });

    // Cmd+K sets the chord prefix — no action yet
    const prefixResult = service.resolveKeybinding(cmdK);
    expect(prefixResult.match).toBeUndefined();
    expect(prefixResult.chordPrefix).toBe(true);

    // Cmd+W after Cmd+K completes the chord
    const match = service.findMatchingAction(cmdW);
    expect(match?.actionId).toBe("terminal.closeAll");
  });

  it("does not report conflicts for bindings disabled by empty override list", () => {
    const service = new KeybindingService();

    (service as unknown as { overrides: Map<string, string[]> }).overrides.set(
      "terminal.duplicate",
      []
    );

    const conflicts = service.findConflicts("Cmd+T");
    expect(conflicts.some((binding) => binding.actionId === "terminal.duplicate")).toBe(false);
  });

  describe("findConflicts scope filtering and chord shadowing", () => {
    // Default `modal.close` is bound to Escape in "modal" scope.
    // `terminal` and `modal` scopes are disjoint, so a terminal-scoped Escape
    // candidate must not collide with `modal.close`.
    it("does not flag scope-disjoint bindings as conflicts", () => {
      const service = new KeybindingService();

      const conflicts = service.findConflicts("Escape", undefined, "terminal");
      expect(conflicts.some((c) => c.actionId === "modal.close")).toBe(false);
    });

    it("flags global-scoped candidates against any scope", () => {
      const service = new KeybindingService();

      // A "global" candidate would fire everywhere, so it must collide with the
      // modal-scoped Escape binding.
      const conflicts = service.findConflicts("Escape", undefined, "global");
      expect(conflicts.some((c) => c.actionId === "modal.close")).toBe(true);
    });

    it("marks exact-combo collisions as kind: 'conflict'", () => {
      const service = new KeybindingService();
      const conflicts = service.findConflicts("Cmd+T");
      const dup = conflicts.find((c) => c.actionId === "terminal.duplicate");
      expect(dup?.kind).toBe("conflict");
    });

    it("marks new-combo-shadows-existing-chord as kind: 'shadowed'", () => {
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.chord",
        combo: "Cmd+Alt+Shift+J Cmd+Alt+Shift+Q",
        scope: "global",
        priority: 0,
        description: "Test chord",
      });

      // Registering "Cmd+Alt+Shift+J" alone would make the chord unreachable.
      const conflicts = service.findConflicts("Cmd+Alt+Shift+J");
      const shadowed = conflicts.find((c) => c.actionId === "test.chord");
      expect(shadowed?.kind).toBe("shadowed");
    });

    it("marks new-chord-shadowed-by-existing as kind: 'shadowed'", () => {
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.singleKey",
        combo: "Cmd+Alt+Shift+J",
        scope: "global",
        priority: 0,
        description: "Test single",
      });

      // Trying to register a chord starting with the same first step — the
      // existing single binding makes the chord unreachable.
      const conflicts = service.findConflicts("Cmd+Alt+Shift+J Cmd+Alt+Shift+Q");
      const shadowed = conflicts.find((c) => c.actionId === "test.singleKey");
      expect(shadowed?.kind).toBe("shadowed");
    });

    it("excludeActionId suppresses both 'conflict' and 'shadowed' returns", () => {
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.chord",
        combo: "Cmd+Alt+Shift+J Cmd+Alt+Shift+Q",
        scope: "global",
        priority: 0,
      });

      const conflicts = service.findConflicts("Cmd+Alt+Shift+J", "test.chord");
      expect(conflicts.some((c) => c.actionId === "test.chord")).toBe(false);
    });
  });

  it("surfaces empty effective combo for disabled overrides", () => {
    const service = new KeybindingService();

    (service as unknown as { overrides: Map<string, string[]> }).overrides.set(
      "terminal.duplicate",
      []
    );

    const all = service.getAllBindingsWithEffectiveCombos();
    const binding = all.find((entry) => entry.actionId === "terminal.duplicate") as
      | (RegisteredKeybindingConfig & { effectiveCombo: string })
      | undefined;

    expect(binding).toBeTruthy();
    expect(binding?.effectiveCombo).toBe("");
  });

  it("binds Cmd+T to terminal.duplicate by default", () => {
    const service = new KeybindingService();
    expect(service.getBinding("terminal.duplicate")?.combo).toBe("Cmd+T");
  });

  it("binds Cmd+Alt+T to terminal.new by default", () => {
    const service = new KeybindingService();
    expect(service.getBinding("terminal.new")?.combo).toBe("Cmd+Alt+T");
  });

  it("binds project MRU plus (older) and shift+plus (newer) by default; minus stays unbound", () => {
    setPlatform("MacIntel");
    const service = new KeybindingService();

    expect(service.getBinding("project.mruCycleOlder")?.combo).toBe("Cmd+Alt+=");
    expect(service.getBinding("project.mruCycleNewer")?.combo).toBe("Cmd+Shift+Alt+=");

    const plus = createKeyboardEvent({
      key: "≠",
      code: "Equal",
      metaKey: true,
      altKey: true,
    });
    expect(service.findMatchingAction(plus)?.actionId).toBe("project.mruCycleOlder");

    const shiftedPlus = createKeyboardEvent({
      key: "+",
      code: "Equal",
      metaKey: true,
      altKey: true,
      shiftKey: true,
    });
    expect(service.findMatchingAction(shiftedPlus)?.actionId).toBe("project.mruCycleNewer");

    const minus = createKeyboardEvent({
      key: "–",
      code: "Minus",
      metaKey: true,
      altKey: true,
    });
    expect(service.findMatchingAction(minus)).toBeUndefined();
  });

  it("matchesEvent returns true for Shift+F10", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    const event = createKeyboardEvent({
      key: "F10",
      code: "F10",
      shiftKey: true,
    });

    expect(service.matchesEvent(event, "Shift+F10")).toBe(true);
  });

  it("findMatchingAction returns terminal.contextMenu for Shift+F10", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    const event = createKeyboardEvent({
      key: "F10",
      code: "F10",
      shiftKey: true,
    });

    const match = service.findMatchingAction(event);
    expect(match?.actionId).toBe("terminal.contextMenu");
  });

  it("disabling terminal.contextMenu with empty override prevents match", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    (service as unknown as { overrides: Map<string, string[]> }).overrides.set(
      "terminal.contextMenu",
      []
    );

    const event = createKeyboardEvent({
      key: "F10",
      code: "F10",
      shiftKey: true,
    });

    const match = service.findMatchingAction(event);
    expect(match).toBeUndefined();
  });

  it("getEffectiveCombo returns undefined when terminal.contextMenu is disabled", () => {
    const service = new KeybindingService();
    (service as unknown as { overrides: Map<string, string[]> }).overrides.set(
      "terminal.contextMenu",
      []
    );

    expect(service.getEffectiveCombo("terminal.contextMenu")).toBeUndefined();
  });

  it("getEffectiveCombo returns Shift+F10 for terminal.contextMenu by default", () => {
    const service = new KeybindingService();
    expect(service.getEffectiveCombo("terminal.contextMenu")).toBe("Shift+F10");
  });

  describe("getChordCompletions", () => {
    it("returns completions with category and isPrefix fields", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      const completions = service.getChordCompletions("Cmd+K");
      expect(completions.length).toBeGreaterThan(0);

      for (const c of completions) {
        expect(c).toHaveProperty("category");
        expect(c).toHaveProperty("isPrefix");
        expect(typeof c.category).toBe("string");
        expect(typeof c.isPrefix).toBe("boolean");
      }
    });

    it("returns correct categories from bindings", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      const completions = service.getChordCompletions("Cmd+K");
      const closeAll = completions.find((c) => c.actionId === "terminal.closeAll");
      expect(closeAll).toBeTruthy();
      expect(closeAll?.category).toBe("Terminal");

      const worktreePalette = completions.find((c) => c.actionId === "worktree.openPalette");
      expect(worktreePalette).toBeTruthy();
      expect(worktreePalette?.category).toBe("Worktrees");
    });

    it("defaults category to 'Other' when binding has no category", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.noCategory",
        combo: "Cmd+K Cmd+Y",
        scope: "global",
        priority: 0,
        description: "Test no category",
      });

      const completions = service.getChordCompletions("Cmd+K");
      const entry = completions.find((c) => c.actionId === "test.noCategory");
      expect(entry?.category).toBe("Other");
    });

    it("detects sub-prefix entries with isPrefix: true", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      // Register a 3-part chord so "Cmd+G" becomes a sub-prefix of "Cmd+K"
      service.registerBinding({
        actionId: "test.deepChord",
        combo: "Cmd+K Cmd+G Cmd+X",
        scope: "global",
        priority: 0,
        description: "Deep chord test",
        category: "Test",
      });

      const completions = service.getChordCompletions("Cmd+K");
      const subPrefix = completions.find((c) => c.secondKey === "Cmd+G");
      expect(subPrefix?.isPrefix).toBe(true);

      // Regular entries should not be prefixes
      const closeAll = completions.find((c) => c.actionId === "terminal.closeAll");
      expect(closeAll?.isPrefix).toBe(false);
    });

    it("returns empty array for non-chord prefix", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      const completions = service.getChordCompletions("Cmd+Z");
      expect(completions).toEqual([]);
    });
  });

  describe("agent launch defaults", () => {
    it("only registers Claude, Gemini, and Codex as default agent launch shortcuts", () => {
      const agentLaunchDefaults = DEFAULT_KEYBINDINGS.filter(
        (b) =>
          b.actionId.startsWith("agent.") &&
          b.category === "Agents" &&
          /^Cmd\+Alt\+[A-Z]$/.test(b.combo)
      ).map((b) => b.actionId);

      expect(agentLaunchDefaults).toContain("agent.claude");
      expect(agentLaunchDefaults).toContain("agent.gemini");
      expect(agentLaunchDefaults).toContain("agent.codex");
      expect(agentLaunchDefaults).not.toContain("agent.opencode");
      expect(agentLaunchDefaults).not.toContain("agent.cursor");
      expect(agentLaunchDefaults).not.toContain("agent.kiro");
      expect(agentLaunchDefaults).not.toContain("agent.copilot");
      expect(agentLaunchDefaults).not.toContain("agent.kimi");
    });

    it("resolves Cmd+Alt+K to agent.focusNextAgent (no collision with agent.kiro)", () => {
      setPlatform("MacIntel");

      const service = new KeybindingService();
      const event = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
        altKey: true,
      });

      const match = service.findMatchingAction(event);
      expect(match?.actionId).toBe("agent.focusNextAgent");
    });

    it("exposes combo-less long-tail agents in the bindings enumeration so settings UI can rebind them", () => {
      const service = new KeybindingService();
      const all = service.getAllBindingsWithEffectiveCombos();
      const entry = all.find((b) => b.actionId === "agent.kiro");

      expect(entry).toBeDefined();
      expect(entry?.effectiveCombo).toBe("");
      expect(entry?.category).toBe("Agents");
    });

    it("surfaces a user override for a combo-less long-tail agent", async () => {
      const service = new KeybindingService();
      (service as unknown as { overrides: Map<string, string[]> }).overrides.set("agent.kiro", [
        "Cmd+Alt+K",
      ]);

      expect(service.getEffectiveCombo("agent.kiro")).toBe("Cmd+Alt+K");
    });
  });

  describe("lastInvalidKey echo — issue #8105", () => {
    function startCmdKChord(service: KeybindingService): void {
      setPlatform("MacIntel");
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);
      expect(service.getPendingChord()).not.toBeNull();
    }

    it("returns null initially", () => {
      const service = new KeybindingService();
      expect(service.getLastInvalidKey()).toBeNull();
    });

    it("captures the attempted combo when a second key is unrecognized after a chord prefix", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);

      // Press an unrecognized second key — bare "Y" with no modifier is neither
      // a chord completion under Cmd+K nor a standalone shortcut.
      const bareY = createKeyboardEvent({
        key: "y",
        code: "KeyY",
      });
      service.resolveKeybinding(bareY);

      expect(service.getPendingChord()).toBeNull();
      expect(service.getLastInvalidKey()).toBe("y");
    });

    it("consumes the event for an invalid bare-key second press so it does not leak to xterm", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);

      const bareY = createKeyboardEvent({ key: "y", code: "KeyY" });
      const result = service.resolveKeybinding(bareY);

      // shouldConsume must be true — useGlobalKeybindings only calls
      // preventDefault when this is set. Without it, bare keys land in
      // the focused terminal as input.
      expect(result.shouldConsume).toBe(true);
      expect(result.match).toBeUndefined();
      expect(result.chordPrefix).toBe(false);
    });

    it("does not fire a standalone modified shortcut as the invalid second key (Cmd+K then Cmd+B)", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);

      // Cmd+B is normally bound to nav.toggleSidebar and is not a Cmd+K chord
      // completion. As an invalid second key after Cmd+K, it must NOT resolve to
      // that action — the user pressed it as part of a cancelled chord, not as
      // an intentional sidebar toggle.
      const cmdB = createKeyboardEvent({
        key: "b",
        code: "KeyB",
        metaKey: true,
      });
      const result = service.resolveKeybinding(cmdB);

      expect(result.match).toBeUndefined();
      expect(result.shouldConsume).toBe(true);
      expect(service.getLastInvalidKey()).toBe("Cmd+b");
    });

    it("notifies listeners synchronously when lastInvalidKey is set via resolveKeybinding", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);

      // Snapshot the listener captured value at notify-time. The renderer
      // pattern reads getLastInvalidKey() inside the subscriber, so the field
      // MUST already be populated before clearPendingChord() fires the notify.
      let observedAtNotify: string | null | undefined;
      service.subscribe(() => {
        observedAtNotify = service.getLastInvalidKey();
      });

      const bareY = createKeyboardEvent({
        key: "y",
        code: "KeyY",
      });
      service.resolveKeybinding(bareY);

      expect(observedAtNotify).toBe("y");
    });

    it("does not set lastInvalidKey when a chord completes successfully", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.chordOk",
        combo: "Cmd+K Cmd+Z",
        scope: "global",
        priority: 99,
      });
      startCmdKChord(service);

      const cmdZ = createKeyboardEvent({
        key: "z",
        code: "KeyZ",
        metaKey: true,
      });
      const match = service.findMatchingAction(cmdZ);
      expect(match?.actionId).toBe("test.chordOk");
      expect(service.getLastInvalidKey()).toBeNull();
    });

    it("does not set lastInvalidKey when clearPendingChord is called directly (Escape/Backspace path)", () => {
      const service = new KeybindingService();
      startCmdKChord(service);

      service.clearPendingChord();
      expect(service.getPendingChord()).toBeNull();
      expect(service.getLastInvalidKey()).toBeNull();
    });

    it("keeps the pending chord alive indefinitely (no auto-clear timeout)", () => {
      vi.useFakeTimers();
      try {
        const service = new KeybindingService();
        startCmdKChord(service);

        // Chords no longer expire on a timer — the Cmd+K command HUD stays open
        // until explicitly completed/cancelled. Advancing well past the old
        // 1000ms window must leave the chord pending and lastInvalidKey null.
        vi.advanceTimersByTime(5000);
        expect(service.getPendingChord()).not.toBeNull();
        expect(service.getLastInvalidKey()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not set lastInvalidKey for an unrecognized standalone key with no pending chord", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      // No chord pending — a bare unrecognized key must not surface as invalid;
      // it's just a key the app doesn't bind.
      const bareY = createKeyboardEvent({
        key: "y",
        code: "KeyY",
      });
      service.resolveKeybinding(bareY);

      expect(service.getLastInvalidKey()).toBeNull();
    });

    it("clearLastInvalidKey resets to null and notifies listeners", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);
      const bareY = createKeyboardEvent({ key: "y", code: "KeyY" });
      service.resolveKeybinding(bareY);
      expect(service.getLastInvalidKey()).toBe("y");

      const listener = vi.fn();
      service.subscribe(listener);

      service.clearLastInvalidKey();
      expect(service.getLastInvalidKey()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("clearLastInvalidKey is a no-op (no notify) when already null", () => {
      const service = new KeybindingService();
      const listener = vi.fn();
      service.subscribe(listener);

      service.clearLastInvalidKey();
      expect(listener).not.toHaveBeenCalled();
    });

    it("setting a new pending chord after an invalid key does not auto-clear lastInvalidKey at the service layer", () => {
      // The renderer side (ChordIndicator) clears the echo when a new prefix
      // starts. The service should NOT silently overwrite — that's the
      // component's concern, and keeping the boundary clean lets the renderer
      // sequence the echo against the new prefix as it sees fit.
      setPlatform("MacIntel");
      const service = new KeybindingService();
      startCmdKChord(service);
      const bareY = createKeyboardEvent({ key: "y", code: "KeyY" });
      service.resolveKeybinding(bareY);
      expect(service.getLastInvalidKey()).toBe("y");

      // Start a new chord — service-side lastInvalidKey is unchanged.
      startCmdKChord(service);
      expect(service.getLastInvalidKey()).toBe("y");
    });
  });

  describe("popPendingChord", () => {
    it("is a no-op when no chord is pending", () => {
      const service = new KeybindingService();
      const listener = vi.fn();
      service.subscribe(listener);

      service.popPendingChord();

      expect(service.getPendingChord()).toBeNull();
      expect(listener).not.toHaveBeenCalled();
    });

    it("clears the pending chord and notifies listeners", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);
      expect(service.getPendingChord()).not.toBeNull();

      const listener = vi.fn();
      service.subscribe(listener);

      service.popPendingChord();

      expect(service.getPendingChord()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("is idempotent — repeated calls do not re-notify", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);

      const listener = vi.fn();
      service.subscribe(listener);

      service.popPendingChord();
      service.popPendingChord();

      expect(service.getPendingChord()).toBeNull();
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("leaves no lingering timer after pop (no delayed re-notify)", () => {
      vi.useFakeTimers();
      try {
        setPlatform("MacIntel");
        const service = new KeybindingService();
        const cmdK = createKeyboardEvent({
          key: "k",
          code: "KeyK",
          metaKey: true,
        });
        service.resolveKeybinding(cmdK);
        expect(service.getPendingChord()).not.toBeNull();

        service.popPendingChord();
        expect(service.getPendingChord()).toBeNull();

        const listener = vi.fn();
        service.subscribe(listener);

        // Pending chords no longer arm a timer, so advancing the clock must
        // never re-notify listeners once the chord has been popped.
        vi.advanceTimersByTime(2000);

        expect(listener).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("listener hygiene", () => {
    function triggerNotify(service: KeybindingService): void {
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);
      service.popPendingChord();
    }

    it("isolates errors so a throwing listener does not stop subsequent listeners", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const before = vi.fn();
      const thrower = vi.fn(() => {
        throw new Error("listener boom");
      });
      const after = vi.fn();

      service.subscribe(before);
      service.subscribe(thrower);
      service.subscribe(after);

      triggerNotify(service);

      expect(before).toHaveBeenCalled();
      expect(thrower).toHaveBeenCalled();
      expect(after).toHaveBeenCalled();
      expect(after).toHaveBeenCalledTimes(before.mock.calls.length);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("dedupes a listener subscribed twice via Set semantics", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const listener = vi.fn();

      service.subscribe(listener);
      service.subscribe(listener);

      triggerNotify(service);

      // Set dedup: the listener fires once per notification, not twice.
      // triggerNotify produces 2 notifications (set + pop), so listener: 2 calls.
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it("safely handles a listener that unsubscribes itself during notification", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const after = vi.fn();
      let unsubscribeSelf: (() => void) | null = null;

      const selfRemover = vi.fn(() => {
        unsubscribeSelf?.();
      });

      unsubscribeSelf = service.subscribe(selfRemover);
      service.subscribe(after);

      triggerNotify(service);

      expect(selfRemover).toHaveBeenCalledTimes(1);
      // `after` runs on both the set-pending and pop-pending notifications;
      // mutating the underlying Set during notification must not break the
      // current iteration's snapshot.
      expect(after).toHaveBeenCalledTimes(2);
    });

    it("returns an unsubscribe that detaches the listener", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const listener = vi.fn();
      const unsubscribe = service.subscribe(listener);

      triggerNotify(service);
      const initialCalls = listener.mock.calls.length;
      expect(initialCalls).toBeGreaterThan(0);

      unsubscribe();
      triggerNotify(service);

      expect(listener).toHaveBeenCalledTimes(initialCalls);
    });
  });

  describe("registerBinding collision detection", () => {
    it("warns and keeps incumbent when a different actionId tries to claim an existing combo", () => {
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.stealsClaude",
        combo: "Cmd+Alt+C",
        scope: "global",
        priority: 0,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(service.getBinding("test.stealsClaude")).toBeUndefined();
      expect(service.getBinding("agent.claude")?.combo).toBe("Cmd+Alt+C");

      warnSpy.mockRestore();
    });

    it("allows re-registering the same actionId (self-update passes through)", () => {
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "agent.claude",
        combo: "Cmd+Alt+C",
        scope: "global",
        priority: 5,
        description: "Updated description",
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(service.getBinding("agent.claude")?.priority).toBe(5);

      warnSpy.mockRestore();
    });

    it("skips collision check when combo is empty (no-op binding)", () => {
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.noop",
        combo: "",
        scope: "global",
        priority: 0,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(service.getBinding("test.noop")).toBeDefined();

      warnSpy.mockRestore();
    });

    it("allows same combo on scope-isolated non-global bindings", () => {
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.portalOnly",
        combo: "Cmd+Shift+F4",
        scope: "portal",
        priority: 0,
      });
      service.registerBinding({
        actionId: "test.terminalOnly",
        combo: "Cmd+Shift+F4",
        scope: "terminal",
        priority: 0,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(service.getBinding("test.portalOnly")).toBeDefined();
      expect(service.getBinding("test.terminalOnly")).toBeDefined();

      warnSpy.mockRestore();
    });

    it("still blocks collisions when one binding is global", () => {
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.portalStealsClaude",
        combo: "Cmd+Alt+C",
        scope: "portal",
        priority: 0,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(service.getBinding("test.portalStealsClaude")).toBeUndefined();
      expect(service.getBinding("agent.claude")?.combo).toBe("Cmd+Alt+C");

      warnSpy.mockRestore();
    });
  });

  describe("platform-aware Cmd/Ctrl conflict detection — issue #7941", () => {
    it("findConflicts treats Cmd+Shift+E and Ctrl+Shift+E as the same combo on Windows", () => {
      // terminal.sendToAgent defaults to "Cmd+Shift+E". The rebind UI must
      // surface a conflict when a user tries to assign "Ctrl+Shift+E" on
      // non-Mac because both map to the same physical key.
      setPlatform("Win32");
      const service = new KeybindingService();

      const conflicts = service.findConflicts("Ctrl+Shift+E");
      expect(
        conflicts.some((c) => c.actionId === "terminal.sendToAgent" && c.kind === "conflict")
      ).toBe(true);
    });

    it("findConflicts treats Cmd+Shift+E and Ctrl+Shift+E as the same combo on Linux", () => {
      setPlatform("Linux x86_64");
      const service = new KeybindingService();

      const conflicts = service.findConflicts("Ctrl+Shift+E");
      expect(
        conflicts.some((c) => c.actionId === "terminal.sendToAgent" && c.kind === "conflict")
      ).toBe(true);
    });

    it("findConflicts keeps Cmd+Shift+E and Ctrl+Shift+E distinct on macOS", () => {
      // On macOS, Cmd and Ctrl are physically distinct keys — assigning
      // Ctrl+Shift+E should NOT collide with the Cmd+Shift+E default.
      setPlatform("MacIntel");
      const service = new KeybindingService();

      const conflicts = service.findConflicts("Ctrl+Shift+E");
      expect(conflicts.some((c) => c.actionId === "terminal.sendToAgent")).toBe(false);
    });

    it("findConflicts surfaces a cross-form chord-prefix shadow on non-Mac", () => {
      setPlatform("Win32");
      const service = new KeybindingService();

      // terminal.closeAll defaults to "Cmd+K Cmd+W". A non-chord "Ctrl+K"
      // candidate should be reported as shadowed on non-Mac because Cmd+K
      // and Ctrl+K map to the same physical key.
      const conflicts = service.findConflicts("Ctrl+K");
      expect(
        conflicts.some((c) => c.actionId === "terminal.closeAll" && c.kind === "shadowed")
      ).toBe(true);
    });

    it("registerBinding rejects Ctrl+Shift+E when Cmd+Shift+E is already registered on Windows", () => {
      setPlatform("Win32");
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.first",
        combo: "Cmd+Shift+F4",
        scope: "global",
        priority: 0,
      });
      service.registerBinding({
        actionId: "test.second",
        combo: "Ctrl+Shift+F4",
        scope: "global",
        priority: 0,
      });

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(service.getBinding("test.first")?.combo).toBe("Cmd+Shift+F4");
      expect(service.getBinding("test.second")).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("registerBinding allows Ctrl+Shift+E alongside Cmd+Shift+E on macOS", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      service.registerBinding({
        actionId: "test.first",
        combo: "Cmd+Shift+F4",
        scope: "global",
        priority: 0,
      });
      service.registerBinding({
        actionId: "test.second",
        combo: "Ctrl+Shift+F4",
        scope: "global",
        priority: 0,
      });

      expect(warnSpy).not.toHaveBeenCalled();
      expect(service.getBinding("test.first")?.combo).toBe("Cmd+Shift+F4");
      expect(service.getBinding("test.second")?.combo).toBe("Ctrl+Shift+F4");

      warnSpy.mockRestore();
    });

    it("DEFAULT_KEYBINDINGS has no silent platform-equivalent shadows on non-Mac", () => {
      // Regression fence: any future default binding that collides cross-form
      // on Windows/Linux will fail here. The constructor pushes defaults
      // directly without going through registerBinding's guard, so this audit
      // is the only place that catches built-in collisions.
      //
      // Intentional overlaps disambiguated by priority (e.g. terminal.close at
      // priority 10 + portal.closeTab at priority 20 on "Cmd+W") are allowed
      // because findMatchingAction picks the higher priority deterministically.
      // A silent shadow is two defaults with overlapping scope + identical
      // platform-normalized combo + identical priority — that's the failure
      // mode this audit catches.
      //
      // Note: this filters to kind === "conflict" only. A future regression
      // where a standalone `Cmd+K` default shadowed the entire `Cmd+K ...`
      // chord namespace would surface as kind === "shadowed" and be missed
      // here. No such standalone exists in defaults today.
      setPlatform("Win32");
      const service = new KeybindingService();
      const silentShadows: string[] = [];

      for (const binding of DEFAULT_KEYBINDINGS) {
        if (!binding.combo) continue;

        const conflicts = service
          .findConflicts(binding.combo, binding.actionId, binding.scope)
          .filter((c) => c.kind === "conflict" && c.priority === binding.priority);
        for (const c of conflicts) {
          // Pair-symmetric: only report each (a, b) once.
          if (c.actionId < binding.actionId) continue;
          silentShadows.push(
            `${binding.actionId} (${binding.combo}, ${binding.scope}, p${binding.priority}) ↔ ${c.actionId} (${c.combo}, ${c.scope}, p${c.priority})`
          );
        }
      }

      expect(silentShadows).toEqual([]);
    });

    it("matchesEvent rejects matches when AltGr is the only Ctrl-source on Windows", () => {
      setPlatform("Win32");
      const service = new KeybindingService();
      // Even if event.key were to coincide with the bound key, the AltGr
      // early-return must reject the match so international input is never
      // swallowed.
      const event = createKeyboardEvent({
        key: "E",
        code: "KeyE",
        ctrlKey: true,
        altKey: true,
        getModifierState: (key: string) => key === "AltGraph",
      });

      expect(service.matchesEvent(event, "Ctrl+Alt+E")).toBe(false);
      expect(service.matchesEvent(event, "Cmd+Alt+E")).toBe(false);
    });

    it("findConflicts surfaces cross-form clashes against user-stored Cmd+ overrides on non-Mac", () => {
      // A user has rebound some action to "Cmd+Shift+F4" via setOverride.
      // When another rebind UI run queries findConflicts("Ctrl+Shift+F4")
      // on Windows, the override must still surface as a conflict.
      setPlatform("Win32");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.target",
        combo: "",
        scope: "global",
        priority: 0,
      });
      // Simulate an existing user override on test.target via direct map
      // manipulation — bypasses the IPC layer the public setOverride uses.
      (service as unknown as { overrides: Map<string, string[]> }).overrides.set("test.target", [
        "Cmd+Shift+F4",
      ]);

      const conflicts = service.findConflicts("Ctrl+Shift+F4");
      expect(conflicts.some((c) => c.actionId === "test.target" && c.kind === "conflict")).toBe(
        true
      );
    });

    it("matchesEvent ignores AltGr guard on macOS (AltGr does not exist there)", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      // Synthetic AltGraph state on macOS must not gate the matcher.
      const event = createKeyboardEvent({
        key: "e",
        code: "KeyE",
        metaKey: true,
        altKey: true,
        getModifierState: (key: string) => key === "AltGraph",
      });

      expect(service.matchesEvent(event, "Cmd+Alt+E")).toBe(true);
    });
  });

  describe("chord matching is modifier-order-independent — issue #7303", () => {
    // Use Cmd+Shift+Alt+J as the prefix — not bound to any default non-chord
    // action, so the chord prefix isn't shadowed by a competing non-chord match.
    it("matches a chord override stored with non-canonical modifier order on the prefix step", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.reorderedPrefix",
        // User-stored: Shift+Alt+Cmd+J. Canonical eventToCombo: Cmd+Shift+Alt+J.
        combo: "Shift+Alt+Cmd+J Cmd+X",
        scope: "global",
        priority: 99,
      });

      const first = createKeyboardEvent({
        key: "j",
        code: "KeyJ",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      });

      const result = service.resolveKeybinding(first);
      expect(result.chordPrefix).toBe(true);
      expect(service.getPendingChord()).not.toBeNull();
    });

    it("completes a chord whose first part uses non-canonical modifier order", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.reorderedChord",
        combo: "Shift+Alt+Cmd+J Cmd+X",
        scope: "global",
        priority: 99,
      });

      const first = createKeyboardEvent({
        key: "j",
        code: "KeyJ",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      });
      service.resolveKeybinding(first);

      const second = createKeyboardEvent({
        key: "x",
        code: "KeyX",
        metaKey: true,
      });
      const match = service.findMatchingAction(second);
      expect(match?.actionId).toBe("test.reorderedChord");
    });

    it("completes a chord whose second part uses non-canonical modifier order", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "test.reorderedSecond",
        combo: "Cmd+K Alt+Shift+P",
        scope: "global",
        priority: 99,
      });

      const first = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(first);

      const second = createKeyboardEvent({
        key: "p",
        code: "KeyP",
        shiftKey: true,
        altKey: true,
      });
      const match = service.findMatchingAction(second);
      expect(match?.actionId).toBe("test.reorderedSecond");
    });
  });

  describe("setScope skips redundant clearPendingChord — issue #7303", () => {
    it("does not clear a pending chord when pushing the same scope twice", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      // Establish a pending chord first.
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);
      expect(service.getPendingChord()).not.toBeNull();

      // First setScope changes scope and clears the chord (expected).
      service.setScope("modal");
      expect(service.getPendingChord()).toBeNull();

      // Re-establish a chord under the new scope, then push the same scope again.
      service.resolveKeybinding(cmdK);
      expect(service.getPendingChord()).not.toBeNull();

      service.setScope("modal");

      // Second push is the StrictMode/concurrent-instance case: scope didn't
      // change, so the chord must survive.
      expect(service.getPendingChord()).not.toBeNull();
    });

    it("preserves stack count so restoreScope still pops correctly with concurrent same-scope pushes", () => {
      const service = new KeybindingService();
      const stack = (service as unknown as { scopeStack: string[] }).scopeStack;

      service.setScope("modal");
      service.setScope("modal");
      expect(stack.filter((s) => s === "modal").length).toBe(2);

      service.restoreScope("modal");
      expect(stack.filter((s) => s === "modal").length).toBe(1);
      expect(service.getScope()).toBe("modal");

      service.restoreScope("modal");
      expect(stack.filter((s) => s === "modal").length).toBe(0);
      expect(service.getScope()).toBe("global");
    });
  });

  describe("override mutation clears pending chord — issue #7303", () => {
    function startChord(service: KeybindingService) {
      setPlatform("MacIntel");
      const cmdK = createKeyboardEvent({
        key: "k",
        code: "KeyK",
        metaKey: true,
      });
      service.resolveKeybinding(cmdK);
      expect(service.getPendingChord()).not.toBeNull();
    }

    it("setOverride clears the pending chord", async () => {
      const service = new KeybindingService();
      startChord(service);
      await service.setOverride("test.action", ["Cmd+Q"]);
      expect(service.getPendingChord()).toBeNull();
    });

    it("removeOverride clears the pending chord", async () => {
      const service = new KeybindingService();
      startChord(service);
      await service.removeOverride("test.action");
      expect(service.getPendingChord()).toBeNull();
    });

    it("resetAllOverrides clears the pending chord", async () => {
      const service = new KeybindingService();
      startChord(service);
      await service.resetAllOverrides();
      expect(service.getPendingChord()).toBeNull();
    });
  });

  describe("worktree empty-state shortcut defaults — issue #6437", () => {
    it("registers Cmd+K Cmd+N as the default for worktree.createDialog.open", () => {
      const binding = DEFAULT_KEYBINDINGS.find((b) => b.actionId === "worktree.createDialog.open");
      expect(binding).toBeDefined();
      expect(binding?.combo).toBe("Cmd+K Cmd+N");
      expect(binding?.scope).toBe("global");
      expect(binding?.category).toBe("Worktrees");
    });

    it("does not collide with the existing Cmd+K Cmd+O worktree-palette chord", () => {
      const createDialog = DEFAULT_KEYBINDINGS.find(
        (b) => b.actionId === "worktree.createDialog.open"
      );
      const palette = DEFAULT_KEYBINDINGS.find((b) => b.actionId === "worktree.openPalette");
      expect(createDialog?.combo).toBe("Cmd+K Cmd+N");
      expect(palette?.combo).toBe("Cmd+K Cmd+O");
      expect(createDialog?.combo).not.toBe(palette?.combo);
    });

    it("makes the chord resolvable via getChordCompletions for the Cmd+K prefix", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const completions = service.getChordCompletions("Cmd+K");
      expect(completions).toContainEqual(
        expect.objectContaining({ actionId: "worktree.createDialog.open" })
      );
    });

    it("returns the display combo for worktree.createDialog.open via getDisplayCombo", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const display = service.getDisplayCombo("worktree.createDialog.open");
      expect(display).not.toBe("");
      expect(display).toContain("⌘");
      expect(display.toUpperCase()).toContain("K");
      expect(display.toUpperCase()).toContain("N");
    });

    it("registers every default-binding actionId in KEY_ACTION_VALUES", async () => {
      // KEY_ACTION_VALUES is hand-maintained alongside the BuiltInKeyAction
      // open union (BuiltInKeyAction | (string & {})), so the compiler can't
      // catch drift. Iterate DEFAULT_KEYBINDINGS so any new action without a
      // matching value entry fails the build instead of silently falling out
      // of introspection (settings UI, conflict detection, etc.).
      const { KEY_ACTION_VALUES } = await import("@shared/types/keymap");
      const missing = DEFAULT_KEYBINDINGS.map((b) => b.actionId).filter(
        (id) => !KEY_ACTION_VALUES.has(id)
      );
      expect(missing).toEqual([]);
    });
  });

  describe("terminal recovery chords — issue #9803", () => {
    // The five per-pane recovery actions (kill, restart, forceResume, redraw,
    // rename) ship with default 3-part Cmd+K Cmd+<letter> chords. Each test
    // pins one chord and asserts (a) the display combo resolves to the
    // expected key glyphs on Mac, and (b) the chord has no exact or prefix
    // shadow against any other registered binding. The chord family matches
    // the existing terminal bulk-action convention (closeAll/restartAll use
    // the same Cmd+K Cmd+<letter> shape).
    const RECOVERY_CHORDS: Array<{ actionId: string; combo: string; letter: string }> = [
      { actionId: "terminal.kill", combo: "Cmd+K Cmd+Q", letter: "Q" },
      { actionId: "terminal.restart", combo: "Cmd+K Cmd+E", letter: "E" },
      { actionId: "terminal.forceResume", combo: "Cmd+K Cmd+U", letter: "U" },
      { actionId: "terminal.redraw", combo: "Cmd+K Cmd+D", letter: "D" },
      { actionId: "terminal.rename", combo: "Cmd+K Cmd+L", letter: "L" },
    ];

    for (const { actionId, combo, letter } of RECOVERY_CHORDS) {
      it(`resolves the display combo for ${actionId} (${combo})`, () => {
        setPlatform("MacIntel");
        const service = new KeybindingService();
        const display = service.getDisplayCombo(actionId);
        expect(display).not.toBe("");
        expect(display).toContain("⌘");
        expect(display.toUpperCase()).toContain("K");
        expect(display.toUpperCase()).toContain(letter.toUpperCase());
      });

      it(`finds no other-binding conflicts for ${actionId} (${combo})`, () => {
        setPlatform("MacIntel");
        const service = new KeybindingService();
        // Exclude the actionId under test so the chord's own registration
        // doesn't count as a self-conflict; the rest of the registry must
        // have nothing at the same combo.
        const conflicts = service.findConflicts(combo, actionId, "global");
        expect(conflicts.filter((c) => c.kind === "conflict")).toEqual([]);
        expect(conflicts.filter((c) => c.kind === "shadowed")).toEqual([]);
      });
    }

    it("registers the five recovery chords in CORE_KEYBINDINGS", () => {
      const actionIds = RECOVERY_CHORDS.map((c) => c.actionId);
      for (const id of actionIds) {
        const entries = DEFAULT_KEYBINDINGS.filter((b) => b.actionId === id);
        expect(entries).toHaveLength(1);
        expect(entries[0]?.combo).toBe(RECOVERY_CHORDS.find((c) => c.actionId === id)?.combo);
      }
    });
  });

  describe("window.zoomIn discoverability alias — issue #7304", () => {
    it("registers both Cmd+= and Cmd+Shift+= as defaults for window.zoomIn", () => {
      const combos = DEFAULT_KEYBINDINGS.filter((b) => b.actionId === "window.zoomIn").map(
        (b) => b.combo
      );
      expect(combos).toEqual(expect.arrayContaining(["Cmd+=", "Cmd+Shift+="]));
      expect(combos).toHaveLength(2);
    });

    it("resolves Cmd+Shift+= to window.zoomIn at runtime", () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();
      const match = service.findMatchingAction(
        createKeyboardEvent({ key: "+", code: "Equal", metaKey: true, shiftKey: true })
      );
      expect(match?.actionId).toBe("window.zoomIn");
    });
  });

  describe("loadOverrides warn-and-drop — issue #8318", () => {
    function mockElectronOverrides(overrides: Record<string, string[]>) {
      vi.stubGlobal("window", {
        electron: {
          keybinding: {
            getOverrides: vi.fn().mockResolvedValue(overrides),
            setOverride: vi.fn().mockResolvedValue(undefined),
            removeOverride: vi.fn().mockResolvedValue(undefined),
            resetAll: vi.fn().mockResolvedValue(undefined),
          },
        },
      });
    }

    it("loads valid built-in override", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({ "terminal.close": ["Cmd+Shift+W"] });
      const service = new KeybindingService();

      await service.loadOverrides();
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+W");
    });

    it("drops unknown actionId with warning", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({ "terminal.clearr": ["Cmd+X"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await service.loadOverrides();
      expect(service.getOverride("terminal.clearr")).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Dropping override for unknown action "terminal.clearr"')
      );

      warnSpy.mockRestore();
    });

    it("retains valid entries in mixed valid + invalid overrides", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({
        "terminal.close": ["Cmd+Shift+W"],
        "terminal.clearr": ["Cmd+X"],
        "terminal.new": ["Cmd+Shift+N"],
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await service.loadOverrides();
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+W");
      expect(service.getEffectiveCombo("terminal.new")).toBe("Cmd+Shift+N");
      expect(service.getOverride("terminal.clearr")).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      warnSpy.mockRestore();
    });

    it("empty overrides load without warning", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await service.loadOverrides();
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it("calling loadOverrides twice does not resurrect stale invalid entries", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({ "terminal.clearr": ["Cmd+X"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await service.loadOverrides();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockClear();

      await service.loadOverrides();
      // Second load from same stub returns the same invalid entry, dropped again
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(service.getOverride("terminal.clearr")).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("preserves plugin-like binding registered before loadOverrides", async () => {
      setPlatform("MacIntel");
      mockElectronOverrides({ "plugin.foo": ["Cmd+P"] });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "plugin.foo",
        combo: "",
        scope: "global",
        priority: 0,
      });

      await service.loadOverrides();
      expect(service.getEffectiveCombo("plugin.foo")).toBe("Cmd+P");
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });

  describe("loadOverrides degradation on IPC rejection — issue #9931", () => {
    function mockElectronOverrides(overrides: Record<string, string[]>) {
      vi.stubGlobal("window", {
        electron: {
          keybinding: {
            getOverrides: vi.fn().mockResolvedValue(overrides),
            setOverride: vi.fn().mockResolvedValue(undefined),
            removeOverride: vi.fn().mockResolvedValue(undefined),
            resetAll: vi.fn().mockResolvedValue(undefined),
          },
        },
      });
    }

    function mockElectronGetOverridesRejection(reason: unknown) {
      vi.stubGlobal("window", {
        electron: {
          keybinding: {
            getOverrides: vi.fn().mockRejectedValue(reason),
            setOverride: vi.fn().mockResolvedValue(undefined),
            removeOverride: vi.fn().mockResolvedValue(undefined),
            resetAll: vi.fn().mockResolvedValue(undefined),
          },
        },
      });
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("resolves with defaults and warns when getOverrides rejects with an Error", async () => {
      setPlatform("MacIntel");
      mockElectronGetOverridesRejection(new Error("boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await expect(service.loadOverrides()).resolves.toBeUndefined();

      // Defaults remain active — no override installed because the IPC failed
      expect(service.getOverride("terminal.close")).toBeUndefined();
      expect(service.getEffectiveCombo("terminal.close")).toBe(
        service.getDefaultCombo("terminal.close")
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[KeybindingService] Failed to load keybinding overrides; keeping prior state: boom"
        )
      );
    });

    it("handles non-Error rejection values without throwing", async () => {
      setPlatform("MacIntel");
      mockElectronGetOverridesRejection("string-only failure");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await expect(service.loadOverrides()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[KeybindingService] Failed to load keybinding overrides; keeping prior state: string-only failure"
        )
      );
    });

    it("does not notify listeners on degradation (constructor seed is the stable state)", async () => {
      setPlatform("MacIntel");
      mockElectronGetOverridesRejection(new Error("boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();
      const listener = vi.fn();
      service.subscribe(listener);

      await service.loadOverrides();

      expect(listener).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("tolerates hostile rejection values whose String() throws", async () => {
      // Some preloads can hand back objects with throwing String coercion.
      // The catch must not re-throw via String(error) — otherwise we re-introduce
      // the #9931 failure mode. formatErrorMessage is hostile-safe.
      setPlatform("MacIntel");
      const hostile = {
        toString() {
          throw new Error("format boom");
        },
        [Symbol.toPrimitive]() {
          throw new Error("format boom");
        },
      };
      mockElectronGetOverridesRejection(hostile);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await expect(service.loadOverrides()).resolves.toBeUndefined();
      // formatErrorMessage falls back to the supplied message for hostile values.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[KeybindingService] Failed to load keybinding overrides; keeping prior state: Unknown keybinding override load failure"
        )
      );
    });

    it("catches synchronous throws from getOverrides too", async () => {
      setPlatform("MacIntel");
      vi.stubGlobal("window", {
        electron: {
          keybinding: {
            getOverrides: vi.fn(() => {
              throw new Error("sync boom");
            }),
            setOverride: vi.fn().mockResolvedValue(undefined),
            removeOverride: vi.fn().mockResolvedValue(undefined),
            resetAll: vi.fn().mockResolvedValue(undefined),
          },
        },
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const service = new KeybindingService();

      await expect(service.loadOverrides()).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[KeybindingService] Failed to load keybinding overrides; keeping prior state: sync boom"
        )
      );
    });

    it("keeps prior overrides as last-known-good when a reload rejects", async () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      // First load: success — install a custom override.
      mockElectronOverrides({ "terminal.close": ["Cmd+Shift+W"] });
      await service.loadOverrides();
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+W");

      // Second load: IPC rejects. Prior override must persist (not silently
      // clobbered) and the user keeps their customization.
      mockElectronGetOverridesRejection(new Error("reload boom"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await service.loadOverrides();

      expect(service.getOverride("terminal.close")).toEqual(["Cmd+Shift+W"]);
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+W");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[KeybindingService] Failed to load keybinding overrides; keeping prior state: reload boom"
        )
      );
    });

    it("recovers cleanly when a subsequent loadOverrides succeeds", async () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      mockElectronGetOverridesRejection(new Error("first call fails"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await service.loadOverrides();
      expect(service.getOverride("terminal.close")).toBeUndefined();

      // A successful reload installs fresh overrides and notifies listeners.
      mockElectronOverrides({ "terminal.close": ["Cmd+K"] });
      const listener = vi.fn();
      service.subscribe(listener);
      await service.loadOverrides();
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+K");
      expect(listener).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });

    it("setOverride still works after a failed loadOverrides", async () => {
      setPlatform("MacIntel");
      const service = new KeybindingService();

      mockElectronGetOverridesRejection(new Error("load fails"));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      await service.loadOverrides();

      await service.setOverride("terminal.close", ["Cmd+Shift+W"]);
      expect(service.getOverride("terminal.close")).toEqual(["Cmd+Shift+W"]);
      expect(service.getEffectiveCombo("terminal.close")).toBe("Cmd+Shift+W");
      warnSpy.mockRestore();
    });
  });

  describe("Windows shortcut conventions — issue #7943", () => {
    it("registers both Shift+F10 and ContextMenu as defaults for terminal.contextMenu", () => {
      const combos = DEFAULT_KEYBINDINGS.filter((b) => b.actionId === "terminal.contextMenu").map(
        (b) => b.combo
      );
      expect(combos).toEqual(expect.arrayContaining(["Shift+F10", "ContextMenu"]));
      expect(combos).toHaveLength(2);
    });

    it("resolves the ContextMenu key to terminal.contextMenu at runtime", () => {
      setPlatform("Win32");
      const service = new KeybindingService();
      const match = service.findMatchingAction(
        createKeyboardEvent({ key: "ContextMenu", code: "ContextMenu" })
      );
      expect(match?.actionId).toBe("terminal.contextMenu");
    });

    it("includes Ctrl+F4 entries in DEFAULT_KEYBINDINGS on Win32", async () => {
      setPlatform("Win32");
      vi.resetModules();
      const { DEFAULT_KEYBINDINGS: WIN_BINDINGS } = await import("../defaultKeybindings");

      const closeEntry = WIN_BINDINGS.find(
        (b) => b.actionId === "terminal.close" && b.combo === "Ctrl+F4"
      );
      const portalEntry = WIN_BINDINGS.find(
        (b) => b.actionId === "portal.closeTab" && b.combo === "Ctrl+F4"
      );

      expect(closeEntry?.scope).toBe("global");
      expect(closeEntry?.priority).toBe(10);
      expect(portalEntry?.scope).toBe("portal");
      expect(portalEntry?.priority).toBe(20);
    });

    it("omits Ctrl+F4 entries from DEFAULT_KEYBINDINGS on macOS", async () => {
      setPlatform("MacIntel");
      vi.resetModules();
      const { DEFAULT_KEYBINDINGS: MAC_BINDINGS } = await import("../defaultKeybindings");

      const ctrlF4Entries = MAC_BINDINGS.filter((b) => b.combo === "Ctrl+F4");
      expect(ctrlF4Entries).toEqual([]);
    });

    it("resolves Ctrl+F4 to terminal.close in global scope on Win32", async () => {
      setPlatform("Win32");
      vi.resetModules();
      const { KeybindingService: WinKeybindingService } = await import("../KeybindingService");

      const service = new WinKeybindingService();
      const match = service.findMatchingAction(
        createKeyboardEvent({ key: "F4", code: "F4", ctrlKey: true })
      );
      expect(match?.actionId).toBe("terminal.close");
    });

    it("resolves Ctrl+F4 to portal.closeTab (priority 20) over terminal.close (priority 10) in portal scope on Win32", async () => {
      setPlatform("Win32");
      vi.resetModules();
      const { KeybindingService: WinKeybindingService } = await import("../KeybindingService");

      const service = new WinKeybindingService();
      service.setScope("portal");
      const match = service.findMatchingAction(
        createKeyboardEvent({ key: "F4", code: "F4", ctrlKey: true })
      );
      expect(match?.actionId).toBe("portal.closeTab");
      expect(match?.priority).toBe(20);
    });

    it("does NOT resolve Ctrl+F4 to any action on macOS", async () => {
      setPlatform("MacIntel");
      vi.resetModules();
      const { KeybindingService: MacKeybindingService } = await import("../KeybindingService");

      const service = new MacKeybindingService();
      const match = service.findMatchingAction(
        createKeyboardEvent({ key: "F4", code: "F4", ctrlKey: true })
      );
      expect(match).toBeUndefined();
    });
  });

  describe("dynamic plugin binding listener notification", () => {
    it("notifies subscribers when registerBinding adds a binding", () => {
      const service = new KeybindingService();
      const listener = vi.fn();
      service.subscribe(listener);

      service.registerBinding({
        actionId: "p1.act",
        combo: "Cmd+Shift+8",
        scope: "global",
        priority: 1,
        pluginId: "p1",
      });

      expect(listener).toHaveBeenCalled();
    });

    it("notifies subscribers when removePluginBindings removes a binding", () => {
      const service = new KeybindingService();
      service.registerBinding({
        actionId: "p1.act",
        combo: "Cmd+Shift+8",
        scope: "global",
        priority: 1,
        pluginId: "p1",
      });

      const listener = vi.fn();
      service.subscribe(listener);
      service.removePluginBindings("p1");

      expect(listener).toHaveBeenCalled();
    });

    it("does not notify when removePluginBindings matches nothing", () => {
      const service = new KeybindingService();
      const listener = vi.fn();
      service.subscribe(listener);

      service.removePluginBindings("nonexistent");

      expect(listener).not.toHaveBeenCalled();
    });

    it("does not clobber a built-in when a plugin binds the same action and combo", () => {
      const service = new KeybindingService();
      const builtIn = service
        .getAllBindings()
        .find((b) => b.actionId === "terminal.close" && !b.pluginId);
      expect(builtIn).toBeDefined();
      const beforeBuiltIns = service
        .getAllBindings()
        .filter((b) => b.actionId === builtIn!.actionId && !b.pluginId);

      // Plugin contributes the same actionId + combo as the built-in.
      service.registerBinding({
        actionId: builtIn!.actionId,
        combo: builtIn!.combo!,
        scope: builtIn!.scope,
        priority: 1,
        pluginId: "p1",
      });

      service.removePluginBindings("p1");

      // The original built-in must survive the plugin's load/unload cycle.
      const after = service
        .getAllBindings()
        .filter((b) => b.actionId === "terminal.close" && !b.pluginId);
      expect(after).toHaveLength(beforeBuiltIns.length);
      expect(after.some((binding) => binding.combo === builtIn!.combo)).toBe(true);
    });

    it("rejects a plugin binding that collides with a user-overridden combo", async () => {
      const prevWindow = (globalThis as { window?: unknown }).window;
      (globalThis as { window?: unknown }).window = {
        electron: { keybinding: { setOverride: vi.fn().mockResolvedValue(undefined) } },
      };
      try {
        const service = new KeybindingService();
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        // User remaps a built-in to Cmd+Shift+8 (its stored combo is something else).
        await service.setOverride("nav.quickSwitcher", ["Cmd+Shift+8"]);

        const before = service.getAllBindings().length;
        service.registerBinding({
          actionId: "plugin.act",
          combo: "Cmd+Shift+8",
          scope: "global",
          priority: 1,
          pluginId: "p1",
        });

        // The plugin binding must be rejected — the effective (overridden) combo is taken.
        expect(service.getAllBindings().length).toBe(before);
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      } finally {
        if (prevWindow === undefined) {
          delete (globalThis as { window?: unknown }).window;
        } else {
          (globalThis as { window?: unknown }).window = prevWindow;
        }
      }
    });
  });
});
