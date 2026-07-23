import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({}) as unknown),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

import {
  comboToAccelerator,
  getEffectiveMenuCombo,
  getMenuAccelerator,
  isRendererOwnedShortcut,
  rendererMenuAccelerator,
  resetRendererOwnedAccelerators,
} from "../menuAccelerators.js";

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
    expect(getEffectiveMenuCombo("nav.toggleSidebar")).toBe("Cmd+B");
    expect(getEffectiveMenuCombo("action.palette.open")).toBe("Cmd+Shift+P");
  });

  it("returns the chord default for chord-bound actions (accelerator then omits it)", () => {
    expect(getEffectiveMenuCombo("worktree.createDialog.open")).toBe("Cmd+K Cmd+N");
    expect(getMenuAccelerator("worktree.createDialog.open")).toBeUndefined();
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
