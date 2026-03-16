import { beforeEach, describe, expect, it } from "vitest";
import {
  KeybindingService,
  normalizeKey,
  normalizeKeyForBinding,
  type KeybindingConfig,
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

  it("supports two-key chord matching", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    service.registerBinding({
      actionId: "test.chord",
      combo: "Cmd+K Cmd+R",
      scope: "global",
      priority: 99,
    });

    const first = createKeyboardEvent({
      key: "k",
      code: "KeyK",
      metaKey: true,
    });
    const second = createKeyboardEvent({
      key: "r",
      code: "KeyR",
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

  it("resolves Cmd+W to sidecar.closeTab (priority 20) over terminal.close (priority 10) in sidecar scope", () => {
    setPlatform("MacIntel");

    const service = new KeybindingService();
    service.setScope("sidecar");

    const event = createKeyboardEvent({
      key: "w",
      code: "KeyW",
      metaKey: true,
    });

    const match = service.findMatchingAction(event);
    expect(match?.actionId).toBe("sidecar.closeTab");
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

  it("surfaces empty effective combo for disabled overrides", () => {
    const service = new KeybindingService();

    (service as unknown as { overrides: Map<string, string[]> }).overrides.set(
      "terminal.duplicate",
      []
    );

    const all = service.getAllBindingsWithEffectiveCombos();
    const binding = all.find((entry) => entry.actionId === "terminal.duplicate") as
      | (KeybindingConfig & { effectiveCombo: string })
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
        combo: "Cmd+K Cmd+X",
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
});
