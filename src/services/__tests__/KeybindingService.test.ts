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

    (service as unknown as { overrides: Map<string, string[]> }).overrides.set("terminal.new", []);

    const conflicts = service.findConflicts("Cmd+T");
    expect(conflicts.some((binding) => binding.actionId === "terminal.new")).toBe(false);
  });

  it("surfaces empty effective combo for disabled overrides", () => {
    const service = new KeybindingService();

    (service as unknown as { overrides: Map<string, string[]> }).overrides.set("terminal.new", []);

    const all = service.getAllBindingsWithEffectiveCombos();
    const binding = all.find((entry) => entry.actionId === "terminal.new") as
      | (KeybindingConfig & { effectiveCombo: string })
      | undefined;

    expect(binding).toBeTruthy();
    expect(binding?.effectiveCombo).toBe("");
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
    expect(match?.actionId).not.toBe("terminal.contextMenu");
  });
});
