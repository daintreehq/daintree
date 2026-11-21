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
  const { buildKeybindingWhenContext } = await import("../keybindingWhenContext");
  const service = new KeybindingService();
  // As useGlobalKeybindings installs it.
  service.setWhenContextProvider(buildKeybindingWhenContext);
  return service;
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

  it("leaves the key alone outside a terminal, where the focused panel's selection is stale", async () => {
    const service = await serviceOn("mac");
    const field = document.createElement("div");
    document.body.appendChild(field);
    const result = service.resolveKeybinding(
      keydownIn(field, { key: "Ç", code: "KeyC", metaKey: true, shiftKey: true, altKey: true })
    );
    expect(result.match?.actionId).not.toBe("terminal.copyClean");
  });

  it("binds nothing on Windows, where Ctrl+Alt+C is AltGr+C, until the user binds it", async () => {
    const service = await serviceOn("windows");
    const altGrC = () =>
      keydownIn(terminalTextarea(), {
        key: "C",
        code: "KeyC",
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      });
    expect(service.getEffectiveCombo("terminal.copyClean")).toBeFalsy();
    expect(service.resolveKeybinding(altGrC()).match?.actionId).not.toBe("terminal.copyClean");

    const win = window as unknown as { electron?: unknown };
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
      expect(service.resolveKeybinding(altGrC()).match?.actionId).toBe("terminal.copyClean");
    } finally {
      delete win.electron;
    }
  });
});
