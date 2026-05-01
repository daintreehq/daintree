import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBINDINGS,
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

  describe("worktree empty-state shortcut defaults — issue #6437", () => {
    it("registers Cmd+K N as the default for worktree.createDialog.open", () => {
      const binding = DEFAULT_KEYBINDINGS.find((b) => b.actionId === "worktree.createDialog.open");
      expect(binding).toBeDefined();
      expect(binding?.combo).toBe("Cmd+K N");
      expect(binding?.scope).toBe("global");
      expect(binding?.category).toBe("Worktrees");
    });

    it("does not collide with the existing Cmd+K W worktree-palette chord", () => {
      const createDialog = DEFAULT_KEYBINDINGS.find(
        (b) => b.actionId === "worktree.createDialog.open"
      );
      const palette = DEFAULT_KEYBINDINGS.find((b) => b.actionId === "worktree.openPalette");
      expect(createDialog?.combo).toBe("Cmd+K N");
      expect(palette?.combo).toBe("Cmd+K W");
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

    it("registers worktree.createDialog.open in the BuiltInKeyAction value set", async () => {
      // Registry completeness: every action with a default binding should
      // appear in KEY_ACTION_VALUES so introspection (settings UI, conflict
      // detection, etc.) sees it.
      const { KEY_ACTION_VALUES } = await import("@shared/types/keymap");
      expect(KEY_ACTION_VALUES.has("worktree.createDialog.open")).toBe(true);
    });
  });
});
