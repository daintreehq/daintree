import { describe, expect, it } from "vitest";
import { buildDefaultKeybindings } from "../defaultKeybindings.js";
import type { KeybindingConfig } from "../../types/keybinding.js";

function globalCombo(bindings: KeybindingConfig[], actionId: string): string[] {
  return bindings
    .filter((b) => b.actionId === actionId && b.scope === "global")
    .map((b) => b.combo);
}

// Off-Mac the matcher folds Cmd into Ctrl, so two defaults that differ only in
// that spelling fire on the same physical keys.
function foldCmd(combo: string): string {
  return combo.replace(/Cmd\+/g, "Ctrl+");
}

describe("buildDefaultKeybindings", () => {
  const mac = buildDefaultKeybindings(false);
  const windows = buildDefaultKeybindings(true);
  const linux = buildDefaultKeybindings(false, true);

  it("binds voice dictation to ⌘. on macOS and Ctrl+. on Windows", () => {
    expect(globalCombo(mac, "voiceInput.toggle")).toEqual(["Cmd+."]);
    expect(globalCombo(windows, "voiceInput.toggle")).toEqual(["Cmd+."]);
  });

  it("replaces the Linux dictation default instead of adding a second one", () => {
    expect(globalCombo(linux, "voiceInput.toggle")).toEqual(["Ctrl+Alt+,"]);
    expect(linux).toHaveLength(mac.length);
  });

  it("never ships Ctrl+. on Linux, where IBus claims it for the emoji picker", () => {
    const period = linux.filter((b) => foldCmd(b.combo) === "Ctrl+.");
    expect(period).toEqual([]);
  });

  it("keeps the Linux replacement clear of every other global default", () => {
    const [replacement] = linux.filter((b) => b.actionId === "voiceInput.toggle");
    const collisions = linux.filter(
      (b) =>
        b !== replacement &&
        b.scope === "global" &&
        foldCmd(b.combo) === foldCmd(replacement!.combo)
    );
    expect(collisions).toEqual([]);
  });

  it("leaves non-replaced Linux rows identical to the core table", () => {
    const changed = linux.filter((b, i) => b !== mac[i]).map((b) => b.actionId);
    expect(changed).toEqual(["voiceInput.toggle"]);
  });
});
