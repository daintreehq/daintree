// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingService } from "../KeybindingService";
import { resetKeyboardLayoutForTests } from "@/lib/keyboardLayout";

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => false,
}));

let slash = "!";
const getLayoutMap = vi.fn(async () => new Map([["Slash", slash]]));

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("KeybindingService display text and the keyboard layout", () => {
  beforeEach(() => {
    slash = "!";
    getLayoutMap.mockClear();
    Object.defineProperty(navigator, "keyboard", {
      value: { getLayoutMap },
      configurable: true,
    });
  });

  afterEach(() => {
    resetKeyboardLayoutForTests();
    Reflect.deleteProperty(navigator, "keyboard");
  });

  it("draws the layout's key and tells subscribers when the layout changes", async () => {
    const service = new KeybindingService();
    expect(service.formatComboForDisplay("Cmd+/")).toBe("Ctrl+/");

    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await flush();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(service.formatComboForDisplay("Cmd+/")).toBe("Ctrl+!");
    expect(service.getDisplayCombo("help.shortcutsAlt")).toBe("Ctrl+!");

    slash = "/";
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(service.formatComboForDisplay("Cmd+/")).toBe("Ctrl+/");
    unsubscribe();
  });

  it("stops watching the layout once nobody listens", async () => {
    const service = new KeybindingService();
    const first = service.subscribe(() => {});
    const second = service.subscribe(() => {});
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(1);

    first();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(2);

    second();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(getLayoutMap).toHaveBeenCalledTimes(2);
  });
});
