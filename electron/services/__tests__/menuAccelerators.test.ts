import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storeMock = vi.hoisted(() => ({
  get: vi.fn(() => ({}) as unknown),
}));

vi.mock("../../store.js", () => ({ store: storeMock }));

import {
  comboToAccelerator,
  getEffectiveMenuCombo,
  getMenuAccelerator,
  isKeybindingOwnedAction,
  isRendererOwnedShortcut,
  rendererMenuAccelerator,
  resetRendererOwnedAccelerators,
  trackHostSwitchAccelerator,
  trackRendererOwnedAccelerator,
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

  // Switch host's default is macOS Hide Others: the renderer may only take
  // the keystroke while there is a host to switch to.
  it("claims a conditional accelerator only while its condition holds, read per keystroke", () => {
    setProcessPlatform("darwin");
    let hostsExist = false;
    trackRendererOwnedAccelerator(getMenuAccelerator("host.switch"), () => hostsExist);
    const optionH = input({ key: "˙", code: "KeyH", meta: true, alt: true });
    expect(isRendererOwnedShortcut(optionH)).toBe(false);
    hostsExist = true;
    expect(isRendererOwnedShortcut(optionH)).toBe(true);
  });

  it("keeps matching an unconditional accelerator that shares no combo with a failing condition", () => {
    setProcessPlatform("darwin");
    trackRendererOwnedAccelerator(getMenuAccelerator("host.switch"), () => false);
    rendererMenuAccelerator("nav.toggleSidebar");
    expect(isRendererOwnedShortcut(input({ key: "b", meta: true }))).toBe(true);
  });

  it("hands Cmd+Alt+H to Switch host only while another host is in the list", () => {
    setProcessPlatform("darwin");
    const hosts: unknown[] = [];
    storeMock.get.mockImplementation(((key: string) =>
      key === "remoteHosts" ? { hosts } : {}) as () => unknown);
    trackHostSwitchAccelerator();
    const optionH = input({ key: "˙", code: "KeyH", meta: true, alt: true });
    expect(isRendererOwnedShortcut(optionH)).toBe(false);
    hosts.push({ id: "studio-01" });
    expect(isRendererOwnedShortcut(optionH)).toBe(true);
  });

  it("follows a rebound Switch host, leaving Cmd+Alt+H to Hide Others", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockImplementation(((key: string) =>
      key === "remoteHosts"
        ? { hosts: [{ id: "studio-01" }] }
        : { "host.switch": ["Cmd+Shift+Alt+H"] }) as () => unknown);
    trackHostSwitchAccelerator();
    expect(isRendererOwnedShortcut(input({ key: "˙", code: "KeyH", meta: true, alt: true }))).toBe(
      false
    );
    expect(
      isRendererOwnedShortcut(input({ key: "Ó", code: "KeyH", meta: true, alt: true, shift: true }))
    ).toBe(true);
  });

  it("claims every combo a Switch host override lists, not just the first", () => {
    setProcessPlatform("darwin");
    storeMock.get.mockImplementation(((key: string) =>
      key === "remoteHosts"
        ? { hosts: [{ id: "studio-01" }] }
        : { "host.switch": ["Cmd+Shift+Alt+H", "Cmd+Alt+H"] }) as () => unknown);
    trackHostSwitchAccelerator();
    expect(isRendererOwnedShortcut(input({ key: "˙", code: "KeyH", meta: true, alt: true }))).toBe(
      true
    );
  });

  it("ignores non-keyDown input", () => {
    setProcessPlatform("darwin");
    rendererMenuAccelerator("nav.toggleSidebar");
    expect(isRendererOwnedShortcut(input({ type: "keyUp", key: "b", meta: true }))).toBe(false);
  });
});
