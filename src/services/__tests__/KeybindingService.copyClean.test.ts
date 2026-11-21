// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ mac: false, windows: false, linux: false }));

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => platform.mac,
  isWindows: () => platform.windows,
  isLinux: () => platform.linux,
}));

/** A fresh service seeded with the given platform's defaults. */
async function serviceOn(os: "mac" | "windows" | "linux") {
  platform.mac = os === "mac";
  platform.windows = os === "windows";
  platform.linux = os === "linux";
  vi.resetModules();
  const { KeybindingService } = await import("../KeybindingService");
  return new KeybindingService();
}

function keydownIn(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: target });
  return event;
}

function terminalTextarea(): HTMLTextAreaElement {
  const xterm = document.createElement("div");
  xterm.className = "xterm";
  const textarea = document.createElement("textarea");
  xterm.appendChild(textarea);
  document.body.appendChild(xterm);
  return textarea;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the Copy clean text shortcut (#18132)", () => {
  it("resolves ⌥⇧⌘C from a focused terminal on macOS, though Option turns the key into Ç", async () => {
    const service = await serviceOn("mac");
    const result = service.resolveKeybinding(
      keydownIn(terminalTextarea(), {
        key: "Ç",
        code: "KeyC",
        metaKey: true,
        shiftKey: true,
        altKey: true,
      })
    );
    expect(result.match?.actionId).toBe("terminal.copyClean");
    // Consumed whether or not anything is selected, so the key never reaches the PTY.
    expect(result.shouldConsume).toBe(true);
  });

  it("resolves Ctrl+Shift+Alt+C from a focused terminal on Linux", async () => {
    const service = await serviceOn("linux");
    const result = service.resolveKeybinding(
      keydownIn(terminalTextarea(), {
        key: "C",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      })
    );
    expect(result.match?.actionId).toBe("terminal.copyClean");
    expect(result.shouldConsume).toBe(true);
  });

  it("binds nothing on Windows, where Ctrl+Alt+C is AltGr+C, until the user binds it", async () => {
    const service = await serviceOn("windows");
    const ctrlShiftAltC = () =>
      keydownIn(terminalTextarea(), {
        key: "C",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      });
    expect(service.getEffectiveCombo("terminal.copyClean")).toBeFalsy();
    expect(service.resolveKeybinding(ctrlShiftAltC()).match?.actionId).not.toBe(
      "terminal.copyClean"
    );

    const win = window as unknown as { electron?: unknown };
    const previous = win.electron;
    win.electron = {
      keybinding: {
        setOverride: async (actionId: string, combo: string[]) => ({
          revision: 1,
          overrides: { [actionId]: combo },
        }),
      },
    };
    try {
      await service.setOverride("terminal.copyClean", ["Ctrl+Shift+Alt+C"]);
      expect(service.resolveKeybinding(ctrlShiftAltC()).match?.actionId).toBe("terminal.copyClean");
    } finally {
      win.electron = previous;
    }
  });
});
