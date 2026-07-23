import { afterEach, describe, expect, it } from "vitest";
import {
  isTerminalClipboardCopyKey,
  isTerminalClipboardPasteKey,
  isTerminalReservedKey,
  isTuiReservedKey,
  TUI_KEYBINDS,
} from "../terminalReservedKeys";

function setPlatform(platform: string) {
  Object.defineProperty(globalThis, "navigator", {
    value: { platform },
    configurable: true,
    writable: true,
  });
}

function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
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

afterEach(() => {
  setPlatform("MacIntel");
});

describe("isTuiReservedKey", () => {
  it("reserves every readline Ctrl key without other modifiers", () => {
    for (const key of TUI_KEYBINDS) {
      expect(isTuiReservedKey(keyEvent({ key, ctrlKey: true }))).toBe(true);
    }
  });

  it("does not reserve Ctrl+Alt combos — Cmd+Alt bindings on Windows arrive as Ctrl+Alt", () => {
    // The old xterm-side check ignored altKey, which made Ctrl+Alt+P/N/B/K/J
    // (the Cmd+Alt bindings on Windows/Linux) dead inside terminals.
    expect(isTuiReservedKey(keyEvent({ key: "p", ctrlKey: true, altKey: true }))).toBe(false);
    expect(isTuiReservedKey(keyEvent({ key: "n", ctrlKey: true, altKey: true }))).toBe(false);
  });

  it("does not reserve shifted or meta'd Ctrl keys", () => {
    expect(isTuiReservedKey(keyEvent({ key: "p", ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isTuiReservedKey(keyEvent({ key: "p", ctrlKey: true, metaKey: true }))).toBe(false);
  });

  it("does not reserve Ctrl+C — SIGINT never routes through the app at all", () => {
    expect(isTuiReservedKey(keyEvent({ key: "c", ctrlKey: true }))).toBe(false);
  });
});

describe("terminal clipboard keys (Windows/Linux conventions)", () => {
  it("recognizes Ctrl+Shift+C / Ctrl+Shift+V / Shift+Insert on non-mac", () => {
    setPlatform("Win32");
    expect(isTerminalClipboardCopyKey(keyEvent({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(
      true
    );
    expect(isTerminalClipboardPasteKey(keyEvent({ key: "V", ctrlKey: true, shiftKey: true }))).toBe(
      true
    );
    expect(isTerminalClipboardPasteKey(keyEvent({ key: "Insert", shiftKey: true }))).toBe(true);
  });

  it("never claims clipboard keys on macOS — Cmd+C/V via native Edit roles instead", () => {
    setPlatform("MacIntel");
    expect(isTerminalClipboardCopyKey(keyEvent({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(
      false
    );
    expect(isTerminalClipboardPasteKey(keyEvent({ key: "V", ctrlKey: true, shiftKey: true }))).toBe(
      false
    );
  });

  it("requires exact modifiers — Ctrl+Shift+Alt+C is not a clipboard key", () => {
    setPlatform("Win32");
    expect(
      isTerminalClipboardCopyKey(
        keyEvent({ key: "C", ctrlKey: true, shiftKey: true, altKey: true })
      )
    ).toBe(false);
    expect(
      isTerminalClipboardPasteKey(keyEvent({ key: "Insert", ctrlKey: true, shiftKey: true }))
    ).toBe(false);
  });
});

describe("isTerminalReservedKey", () => {
  it("is the union of the TUI and clipboard predicates", () => {
    setPlatform("Win32");
    expect(isTerminalReservedKey(keyEvent({ key: "w", ctrlKey: true }))).toBe(true);
    expect(isTerminalReservedKey(keyEvent({ key: "C", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isTerminalReservedKey(keyEvent({ key: "b", ctrlKey: true, shiftKey: true }))).toBe(
      false
    );
  });
});
