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

  it("ships the same dictation combo on Windows as on macOS", () => {
    expect(globalCombo(windows, "voiceInput.toggle")).toEqual(
      globalCombo(mac, "voiceInput.toggle")
    );
  });

  it("replaces the Linux dictation default instead of adding a second one", () => {
    const linuxCombos = globalCombo(linux, "voiceInput.toggle");
    expect(linuxCombos).toHaveLength(1);
    expect(linuxCombos).not.toEqual(globalCombo(mac, "voiceInput.toggle"));
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
    expect(changed.sort()).toEqual([
      "canopy.toggle",
      "terminal.focusDown",
      "terminal.focusLeft",
      "terminal.focusRight",
      "terminal.focusUp",
      "terminal.new",
      "terminal.scrollToLastActivity",
      "voiceInput.toggle",
      "worktree.openFileBrowserPanel",
    ]);
  });

  it("gives Canopy the one-modifier E on macOS and keeps All agents on Cmd+Alt+O", () => {
    expect(globalCombo(mac, "canopy.toggle")).toEqual(["Cmd+E"]);
    expect(globalCombo(mac, "pilot.toggle")).toEqual(["Cmd+Alt+O"]);
  });

  it("moves Canopy off Ctrl+E on Windows and Linux, where readline owns it", () => {
    for (const table of [windows, linux]) {
      expect(globalCombo(table, "canopy.toggle")).toEqual(["Ctrl+Shift+O"]);
      expect(table.some((b) => b.scope === "global" && foldCmd(b.combo) === "Ctrl+E")).toBe(false);
    }
  });

  it("keeps Windows in core order with replacements in place and additions after", () => {
    // Remote Hosts appends Switch host to the core list everywhere but Windows.
    const core = mac.filter((b) => b.actionId !== "host.switch");
    const changed = windows
      .slice(0, core.length)
      .filter((b, i) => b !== core[i])
      .map((b) => b.actionId);
    expect(changed).toEqual(["canopy.toggle"]);
    expect(windows.length).toBeGreaterThan(core.length);
  });

  it("keeps Switch host clear of every other global default where it exists", () => {
    for (const table of [mac, linux]) {
      const [hostSwitch] = table.filter((b) => b.actionId === "host.switch");
      expect(hostSwitch).toBeDefined();
      const collisions = table.filter(
        (b) =>
          b !== hostSwitch &&
          b.scope === "global" &&
          foldCmd(b.combo) === foldCmd(hostSwitch!.combo)
      );
      expect(collisions).toEqual([]);
    }
  });

  it("keeps the Canopy replacement clear of every other global default", () => {
    for (const table of [windows, linux]) {
      const [replacement] = table.filter((b) => b.actionId === "canopy.toggle");
      const collisions = table.filter(
        (b) =>
          b !== replacement &&
          b.scope === "global" &&
          foldCmd(b.combo) === foldCmd(replacement!.combo)
      );
      expect(collisions).toEqual([]);
    }
  });

  // Grabbed by GNOME, XFCE or KDE before the window sees them; on XFCE and KDE
  // Ctrl+Alt+L locks the screen.
  it("ships none of the Ctrl+Alt letter combos Linux desktops grab", () => {
    const grabbed = ["T", "L", "F"].map((key) => `Ctrl+Alt+${key}`);
    expect(linux.filter((b) => grabbed.includes(foldCmd(b.combo)))).toEqual([]);
  });

  // GNOME 46 and XFCE switch workspaces on Ctrl+Alt+Left/Right/Up/Down.
  it("ships no Ctrl+Alt+arrow focus keys on Linux, where desktops switch workspaces", () => {
    const grabbed = ["Up", "Down", "Left", "Right"].map((dir) => `Ctrl+Alt+Arrow${dir}`);
    expect(linux.filter((b) => grabbed.includes(foldCmd(b.combo)))).toEqual([]);
    // Ctrl+Shift+arrows select by word in text fields and extend a dialog's
    // selection (the worktree overview); the bindings stay out of both.
    for (const dir of ["Up", "Down", "Left", "Right"]) {
      const binding = linux.find((b) => b.actionId === `terminal.focus${dir}`);
      expect(binding?.combo).toBe(`Ctrl+Shift+Arrow${dir}`);
      expect(binding?.when).toBe("!textInputFocused && !modalOpen");
    }
    expect(globalCombo(mac, "terminal.focusLeft")).toEqual(["Cmd+Alt+ArrowLeft"]);
  });

  // A focused terminal offers a key to the bindings only with Ctrl or Meta held
  // (XtermAdapter), so a Linux replacement without one would type into the shell.
  it("keeps Ctrl in every Linux replacement", () => {
    for (const replacement of linux.filter((b, i) => b !== mac[i])) {
      expect(foldCmd(replacement.combo), replacement.actionId).toMatch(/^Ctrl\+/);
    }
  });

  // Normalized so modifier order, Cmd-vs-Ctrl spelling and letter case can't
  // hide a collision, and compared across scopes (global and a panel scope are
  // live at once) and against chord first steps.
  it("keeps every Linux replacement clear of every other default", () => {
    const step = (combo: string) => {
      const parts = foldCmd(combo).split("+");
      const key = parts.pop()!.toLowerCase();
      return [...parts.sort(), key].join("+");
    };
    const replaced = linux.filter((b, i) => b !== mac[i]);
    for (const replacement of replaced) {
      const mine = step(replacement.combo);
      const collisions = linux.filter((b) => {
        if (b === replacement || !b.combo) return false;
        const [first] = b.combo.split(" ");
        return step(first!) === mine;
      });
      expect(
        collisions.map((b) => `${b.actionId}:${b.scope}`),
        replacement.actionId
      ).toEqual([]);
    }
  });
});
