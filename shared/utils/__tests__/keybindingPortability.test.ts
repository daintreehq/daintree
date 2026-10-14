import { describe, expect, it } from "vitest";
import {
  comboAsReadOn,
  foldCombo,
  readShortcutOn,
  shortcutPlatform,
} from "../keybindingPortability.js";

describe("keybindingPortability", () => {
  it("maps process platforms to shortcut platforms", () => {
    expect(shortcutPlatform("darwin")).toBe("mac");
    expect(shortcutPlatform("win32")).toBe("windows");
    expect(shortcutPlatform("linux")).toBe("linux");
  });

  it("folds Cmd into Ctrl off a Mac, and keeps them apart on one", () => {
    expect(foldCombo("Cmd+Shift+K", "linux")).toBe(foldCombo("Ctrl+Shift+K", "linux"));
    expect(foldCombo("Shift+Cmd+K", "linux")).toBe(foldCombo("Ctrl+Shift+K", "linux"));
    expect(foldCombo("Cmd+K", "mac")).not.toBe(foldCombo("Ctrl+K", "mac"));
    expect(foldCombo("Option+K", "mac")).toBe(foldCombo("Alt+K", "mac"));
  });

  it("folds each stroke of a chord", () => {
    expect(foldCombo("Cmd+K Cmd+S", "windows")).toBe("ctrl+k ctrl+s");
  });

  it("reads a Mac combo as its Ctrl twin elsewhere, without doubling Ctrl", () => {
    expect(comboAsReadOn("Cmd+Alt+P", "linux")).toBe("Ctrl+Alt+P");
    expect(comboAsReadOn("Cmd+Ctrl+P", "windows")).toBe("Ctrl+P");
    expect(comboAsReadOn("Cmd+Alt+P", "mac")).toBe("Cmd+Alt+P");
    expect(comboAsReadOn("Cmd++", "linux")).toBe("Ctrl++");
  });

  it("flags a combination Linux keeps clear for the desktop", () => {
    // terminal.new is Cmd+Alt+T on a Mac and moved on Linux, where Ctrl+Alt+T opens a terminal.
    const reading = readShortcutOn("panel.someAction", ["Cmd+Alt+T"], "linux");
    expect(reading.readsAs).toBe("Ctrl+Alt+T");
    expect(reading.note).toContain("kept clear on Linux");
  });

  it("flags a clash with another action's default on the target", () => {
    const reading = readShortcutOn("panel.someAction", ["Cmd+Alt+T"], "mac");
    expect(reading.note).toMatch(/is also .+ on macOS/);
  });

  it("says how an override was recorded when it reads differently there", () => {
    const reading = readShortcutOn("panel.someAction", ["Cmd+Alt+Shift+F12"], "linux");
    expect(reading).toEqual({
      readsAs: "Ctrl+Alt+Shift+F12",
      note: "Recorded as Cmd+Alt+Shift+F12",
    });
  });

  it("says nothing when a combo reads the same and clashes with nothing", () => {
    expect(readShortcutOn("panel.someAction", ["Ctrl+Alt+Shift+F12"], "linux")).toEqual({
      readsAs: "Ctrl+Alt+Shift+F12",
    });
  });
});
