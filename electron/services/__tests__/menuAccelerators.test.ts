import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({}) as unknown),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

import {
  comboToAccelerator,
  getEffectiveMenuCombo,
  findActionForInput,
  findTerminalCycleAction,
  getMenuAccelerator,
  isAcceleratorClaimedByKeybinding,
  isDictationKey,
  isKeybindingOwnedAction,
  isRendererOwnedShortcut,
  keepsKeyFromMenu,
  rendererMenuAccelerator,
  resetRendererOwnedAccelerators,
} from "../menuAccelerators.js";
import { buildDefaultKeybindings } from "../../../shared/config/defaultKeybindings.js";

function defaultCombo(actionId: string): string {
  const row = buildDefaultKeybindings(false).find(
    (b) => b.actionId === actionId && b.scope === "global"
  );
  if (!row) throw new Error(`no default row for ${actionId}`);
  return row.combo;
}

const realPlatform = process.platform;

function setProcessPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function input(overrides: Partial<Electron.Input>): Electron.Input {
  return {
    type: "keyDown",
    key: "",
    code: "",
    alt: false,
    control: false,
    meta: false,
    shift: false,
    isAutoRepeat: false,
    isComposing: false,
    location: 0,
    modifiers: [],
    ...overrides,
  } as unknown as Electron.Input;
}

beforeEach(() => {
  storeMock.get.mockReturnValue({});
  resetRendererOwnedAccelerators();
});

afterEach(() => {
  setProcessPlatform(realPlatform);
});

describe("comboToAccelerator", () => {
  it("converts Cmd to CommandOrControl and preserves other modifiers", () => {
    expect(comboToAccelerator("Cmd+Shift+P")).toBe("CommandOrControl+Shift+P");
    expect(comboToAccelerator("Cmd+Alt+T")).toBe("CommandOrControl+Alt+T");
    expect(comboToAccelerator("Ctrl+Shift+F")).toBe("Control+Shift+F");
  });

  it("returns undefined for chords — Electron accelerators cannot express them", () => {
    expect(comboToAccelerator("Cmd+K Cmd+S")).toBeUndefined();
    expect(comboToAccelerator("Cmd+K Cmd+N")).toBeUndefined();
  });

  it("maps named keys and passes punctuation through", () => {
    expect(comboToAccelerator("Cmd+ArrowUp")).toBe("CommandOrControl+Up");
    expect(comboToAccelerator("Cmd+=")).toBe("CommandOrControl+=");
    expect(comboToAccelerator("Cmd+/")).toBe("CommandOrControl+/");
    expect(comboToAccelerator("Cmd+,")).toBe("CommandOrControl+,");
  });

  it("returns undefined for empty combos", () => {
    expect(comboToAccelerator("")).toBeUndefined();
    expect(comboToAccelerator("   ")).toBeUndefined();
  });
});

describe("getEffectiveMenuCombo", () => {
  it("prefers the user override over the default", () => {
    storeMock.get.mockReturnValue({ "nav.toggleSidebar": ["Cmd+Shift+B"] });
    expect(getEffectiveMenuCombo("nav.toggleSidebar")).toBe("Cmd+Shift+B");
  });

  it("treats an empty override array as deliberately unbound — no default fallback", () => {
    storeMock.get.mockReturnValue({ "nav.toggleSidebar": [] });
    expect(getEffectiveMenuCombo("nav.toggleSidebar")).toBeUndefined();
  });

  it("falls back to the shipped global default", () => {
    expect(getEffectiveMenuCombo("nav.toggleSidebar")).toBe(defaultCombo("nav.toggleSidebar"));
    expect(getEffectiveMenuCombo("action.palette.open")).toBe(defaultCombo("action.palette.open"));
  });

  it("returns the chord default for chord-bound actions (accelerator then omits it)", () => {
    const chord = defaultCombo("worktree.createDialog.open");
    expect(chord).toMatch(/\s/);
    expect(getEffectiveMenuCombo("worktree.createDialog.open")).toBe(chord);
    expect(getMenuAccelerator("worktree.createDialog.open")).toBeUndefined();
  });
});

describe("isAcceleratorClaimedByKeybinding", () => {
  it("reports a registry shortcut that lands on a bound key", () => {
    // fleet.armAll ships on Cmd+Alt+A, which Antigravity's registry entry used to claim.
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+A")).toBe(true);
  });

  it("follows the user's overrides rather than the defaults", () => {
    storeMock.get.mockReturnValue({ "fleet.armAll": ["Cmd+Alt+Shift+A"] });
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+A")).toBe(false);
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+Shift+A")).toBe(true);
  });

  it("matches whatever the modifier order or Cmd/Ctrl spelling", () => {
    setProcessPlatform("linux");
    storeMock.get.mockReturnValue({ "fleet.armAll": ["Alt+Ctrl+A"] });
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+A")).toBe(true);
  });

  it("counts a chord's first stroke as claimed", () => {
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+K")).toBe(true);
  });

  it("leaves an unbound key free", () => {
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+Shift+F12")).toBe(false);
  });

  it("leaves a key free that only a retired action's saved override holds", () => {
    storeMock.get.mockReturnValue({ "panel.togglePortal": ["Cmd+Alt+Shift+F12"] });
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+Shift+F12")).toBe(false);
    storeMock.get.mockReturnValue({ "fleet.armAll": ["Cmd+Alt+Shift+F12"] });
    expect(isAcceleratorClaimedByKeybinding("CommandOrControl+Alt+Shift+F12")).toBe(true);
  });
});

describe("findActionForInput", () => {
  const PREVIEW = ["devPreview.reloadPreview"];

  it("resolves a scoped default on macOS", () => {
    setProcessPlatform("darwin");
    expect(findActionForInput(input({ key: "r", meta: true }), PREVIEW, "dev-preview")).toBe(
      "devPreview.reloadPreview"
    );
  });

  it("resolves a default only in its own scope", () => {
    setProcessPlatform("darwin");
    expect(findActionForInput(input({ key: "r", meta: true }), PREVIEW, "global")).toBeUndefined();
  });

  it("ignores other keys and key-ups", () => {
    setProcessPlatform("darwin");
    expect(
      findActionForInput(input({ key: "w", meta: true }), PREVIEW, "dev-preview")
    ).toBeUndefined();
    expect(
      findActionForInput(input({ type: "keyUp", key: "r", meta: true }), PREVIEW, "dev-preview")
    ).toBeUndefined();
  });

  it("honours a rebind, and the old key stops matching", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "devPreview.reloadPreview": ["Cmd+Shift+R"] });
    expect(
      findActionForInput(input({ key: "r", meta: true }), PREVIEW, "dev-preview")
    ).toBeUndefined();
    expect(
      findActionForInput(input({ key: "r", meta: true, shift: true }), PREVIEW, "dev-preview")
    ).toBe("devPreview.reloadPreview");
  });

  it("uses Ctrl for the primary modifier off the Mac", () => {
    setProcessPlatform("linux");
    expect(findActionForInput(input({ key: "r", control: true }), PREVIEW, "dev-preview")).toBe(
      "devPreview.reloadPreview"
    );
  });
});

describe("findTerminalCycleAction", () => {
  it("takes Ctrl+Tab and Ctrl+Shift+Tab as the terminal cycle", () => {
    setProcessPlatform("darwin");
    expect(findTerminalCycleAction(input({ key: "Tab", control: true }))).toEqual({
      actionId: "terminal.focusNext",
    });
    expect(findTerminalCycleAction(input({ key: "Tab", control: true, shift: true }))).toEqual({
      actionId: "terminal.focusPrevious",
    });
  });

  it("names no retired portal action a saved rebind still puts on the same key", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "portal.nextTab": ["Ctrl+Tab"] });
    expect(findTerminalCycleAction(input({ key: "Tab", control: true }))).toEqual({
      actionId: "terminal.focusNext",
    });
  });

  it("leaves a cycle rebound off Tab to the renderer, and releases Ctrl+Tab", () => {
    setProcessPlatform("linux");
    storeMock.get.mockReturnValue({ "terminal.focusNext": ["Ctrl+V"] });
    expect(findTerminalCycleAction(input({ key: "v", control: true }))).toBeUndefined();
    expect(findTerminalCycleAction(input({ key: "Tab", control: true }))).toBeUndefined();
  });
});

describe("isDictationKey", () => {
  it("takes the default dictation key", () => {
    setProcessPlatform("darwin");
    expect(isDictationKey(input({ key: "d", meta: true }))).toBe(true);
    expect(isDictationKey(input({ key: ".", meta: true }))).toBe(false);
    expect(isDictationKey(input({ key: "d", meta: true, shift: true }))).toBe(false);
    expect(isDictationKey(input({ type: "keyUp", key: "d", meta: true }))).toBe(false);
  });

  it("never takes a chord's first stroke, and a chord binding never matches one keystroke", () => {
    setProcessPlatform("darwin");
    // Cmd+K Cmd+D is terminal.redraw: its Cmd+K is not the dictation key.
    expect(isDictationKey(input({ key: "k", code: "KeyK", meta: true }))).toBe(false);

    storeMock.get.mockReturnValue({ "voiceInput.toggle": ["Cmd+K Cmd+D"] });
    expect(isDictationKey(input({ key: "k", code: "KeyK", meta: true }))).toBe(false);
    expect(isDictationKey(input({ key: "d", code: "KeyD", meta: true }))).toBe(false);
  });

  it("follows a rebind, and an unbound key takes nothing", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "voiceInput.toggle": ["Cmd+Shift+D"] });
    expect(isDictationKey(input({ key: ".", meta: true }))).toBe(false);
    expect(isDictationKey(input({ key: "d", meta: true, shift: true }))).toBe(true);

    storeMock.get.mockReturnValue({ "voiceInput.toggle": [] });
    expect(isDictationKey(input({ key: "d", meta: true, shift: true }))).toBe(false);
    expect(isDictationKey(input({ key: ".", meta: true }))).toBe(false);
  });

  it("matches a space-bar binding, which Input names by its character", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "voiceInput.toggle": ["Cmd+Shift+Space"] });
    expect(isDictationKey(input({ key: " ", code: "Space", meta: true, shift: true }))).toBe(true);
    expect(isDictationKey(input({ key: " ", code: "Space", meta: true }))).toBe(false);
  });
});

describe("isKeybindingOwnedAction", () => {
  it("owns actions with a shipped default row", () => {
    expect(isKeybindingOwnedAction("nav.toggleSidebar")).toBe(true);
  });

  it("owns actions with a user override — including an explicit unbind", () => {
    storeMock.get.mockReturnValue({ "agent.custom-agent": [] });
    expect(isKeybindingOwnedAction("agent.custom-agent")).toBe(true);
  });

  it("does not own actions outside the keybinding system", () => {
    expect(isKeybindingOwnedAction("agent.some-custom-agent")).toBe(false);
  });
});

describe("isRendererOwnedShortcut", () => {
  it("matches a tracked accelerator on macOS via meta", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar"); // Cmd+B
    expect(isRendererOwnedShortcut(input({ key: "b", meta: true }))).toBe(true);
    expect(isRendererOwnedShortcut(input({ key: "b", control: true }))).toBe(false);
    expect(isRendererOwnedShortcut(input({ key: "b", meta: true, shift: true }))).toBe(false);
  });

  it("does not match untracked keys — Cmd+C stays native", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar");
    expect(isRendererOwnedShortcut(input({ key: "c", meta: true }))).toBe(false);
  });

  it("matches shifted-digit-row layouts by physical code", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "nav.toggleSidebar": ["Cmd+1"] });
    rendererMenuAccelerator("nav.toggleSidebar");
    expect(isRendererOwnedShortcut(input({ key: "&", code: "Digit1", meta: true }))).toBe(true);
  });

  it("matches Option-transformed letters on macOS by physical code", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockReturnValue({ "terminal.new": ["Cmd+Alt+T"] });
    rendererMenuAccelerator("terminal.new");
    // Option+T produces "†" on macOS; the renderer normalizes mac Alt+letter
    // combos through event.code, so suppression must match the same way.
    expect(isRendererOwnedShortcut(input({ key: "†", code: "KeyT", meta: true, alt: true }))).toBe(
      true
    );
  });

  // The Linux replacement defaults are spelled with Ctrl, which converts to an
  // explicit Control rather than CommandOrControl; off macOS that is still the
  // primary key, so the native item must yield to the renderer.
  it("matches a Linux Ctrl-spelled default via control", () => {
    setProcessPlatform("linux");
    rendererMenuAccelerator("terminal.new"); // Ctrl+Shift+Alt+T on Linux
    expect(
      isRendererOwnedShortcut(input({ key: "T", control: true, shift: true, alt: true }))
    ).toBe(true);
    expect(isRendererOwnedShortcut(input({ key: "T", shift: true, alt: true }))).toBe(false);
    expect(isRendererOwnedShortcut(input({ key: "T", control: true, alt: true }))).toBe(false);
  });

  it("resets between menu builds", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar");
    resetRendererOwnedAccelerators();
    expect(isRendererOwnedShortcut(input({ key: "b", meta: true }))).toBe(false);
  });

  it("ignores non-keyDown input", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar");
    expect(isRendererOwnedShortcut(input({ type: "keyUp", key: "b", meta: true }))).toBe(false);
  });
});

// Cmd+W is the renderer's in every app window, the Canopy window's included:
// there it trashes the focused agent's terminal, or closes the window from the
// list (#16618). Close Window's item and the OS control close it regardless.
describe("keepsKeyFromMenu", () => {
  it("keeps Cmd+W from Close Window on macOS, leaving Ctrl+W and Cmd+Alt+W to the menu", () => {
    setProcessPlatform("darwin");
    expect(keepsKeyFromMenu(input({ key: "w", meta: true }))).toBe(true);
    expect(keepsKeyFromMenu(input({ key: "W", meta: true, shift: true }))).toBe(true);
    expect(keepsKeyFromMenu(input({ key: "w", control: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w", meta: true, control: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w", meta: true, alt: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w" }))).toBe(false);
  });

  it.each(["win32", "linux"] as const)("keeps Ctrl+W from the menu on %s, not Meta+W", (os) => {
    setProcessPlatform(os);
    expect(keepsKeyFromMenu(input({ key: "w", control: true }))).toBe(true);
    expect(keepsKeyFromMenu(input({ key: "w", meta: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w", control: true, meta: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w", control: true, alt: true }))).toBe(false);
    expect(keepsKeyFromMenu(input({ key: "w" }))).toBe(false);
  });

  it("hands the menu its key back on release", () => {
    setProcessPlatform("darwin");
    expect(keepsKeyFromMenu(input({ type: "keyUp", key: "w", meta: true }))).toBe(false);
  });

  it("keeps the renderer-owned accelerators too, and nothing else", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar"); // Cmd+B
    expect(keepsKeyFromMenu(input({ key: "b", meta: true }))).toBe(true);
    expect(keepsKeyFromMenu(input({ key: "c", meta: true }))).toBe(false);
  });
});
