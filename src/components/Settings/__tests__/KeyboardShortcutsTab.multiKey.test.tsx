// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, within, cleanup } from "@testing-library/react";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

const { captured } = vi.hoisted(() => ({ captured: { combo: "Cmd+Shift+K" } }));

// The real service does the override arithmetic; only the dispatch hop is
// replaced, so what a row's save sends is what the service then resolves.
vi.mock("@/services/ActionService", async () => {
  const { keybindingService } = await import("@/services/KeybindingService");
  return {
    actionService: {
      dispatch: vi.fn(async (id: string, args?: { actionId: string; combo?: string[] }) => {
        if (id === "keybinding.setOverride" && args) {
          await keybindingService.setOverride(args.actionId, args.combo ?? []);
        } else if (id === "keybinding.removeOverride" && args) {
          await keybindingService.removeOverride(args.actionId);
        } else if (id === "keybinding.resetAll") {
          await keybindingService.resetAllOverrides();
        }
        return { ok: true, result: undefined };
      }),
    },
  };
});

vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

vi.mock("@/components/Settings/KeybindingProfileActions", () => ({
  KeybindingProfileActions: () => null,
}));

// Stands in for the recorder: shows the key it was told is current and reports
// a capture or a removal on demand.
vi.mock("@/components/KeyboardShortcuts", () => ({
  SettingsShortcutCapture: ({
    onCapture,
    onCancel,
    currentCombo,
    validateCombo,
    describedBy,
  }: {
    onCapture: (combo: string) => void;
    onCancel: () => void;
    currentCombo?: string;
    validateCombo?: (combo: string) => React.ReactNode | null;
    describedBy?: string;
  }) => (
    <div data-testid="shortcut-capture">
      <span data-testid="capture-described-by">{describedBy}</span>
      <span data-testid="capture-current">{currentCombo}</span>
      <span data-testid="capture-validation">{validateCombo?.(captured.combo)}</span>
      <button type="button" onClick={() => onCapture(captured.combo)}>
        Capture combo
      </button>
      <button type="button" onClick={() => onCapture("")}>
        Remove shortcut
      </button>
      <button type="button" onClick={onCancel}>
        Cancel capture
      </button>
    </div>
  ),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { keybindingService } from "@/services/KeybindingService";
import { actionService } from "@/services/ActionService";
import { parseChord } from "@/lib/kbdShortcut";
import { KeyboardShortcutsTab } from "../KeyboardShortcutsTab";

let store: Record<string, string[]> = {};
let revision = 0;
const snapshot = () => ({ revision: ++revision, overrides: { ...store } });
let originalElectron: typeof window.electron | undefined;

const FAILURE = {
  ok: false as const,
  error: { code: "EXECUTION_ERROR" as const, message: "menu rebuild failed" },
};

beforeEach(async () => {
  Object.defineProperty(globalThis.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  originalElectron = window.electron;
  store = {};
  window.electron = {
    keybinding: {
      getOverrides: vi.fn(async () => ({ revision, overrides: { ...store } })),
      setOverride: vi.fn(async (actionId: string, combo: string[]) => {
        store[actionId] = combo;
        return snapshot();
      }),
      removeOverride: vi.fn(async (actionId: string) => {
        delete store[actionId];
        return snapshot();
      }),
      resetAll: vi.fn(async () => {
        store = {};
        return snapshot();
      }),
    },
  } as unknown as typeof window.electron;
  // The service is a module singleton; a reset through the fake bridge starts
  // every test from the shipped defaults.
  await keybindingService.resetAllOverrides();
  captured.combo = "Cmd+Shift+K";
  vi.mocked(actionService.dispatch).mockClear();
});

afterEach(() => {
  cleanup();
  window.electron = originalElectron as typeof window.electron;
  Reflect.deleteProperty(globalThis.navigator, "platform");
});

async function renderTab() {
  render(
    <TooltipProvider>
      <KeyboardShortcutsTab />
    </TooltipProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
}

const editButtons = (name: RegExp) => screen.getAllByRole("button", { name });
const ARM = /^Edit shortcut for Toggle arm focused terminal/;
const glyphs = (combo: string) => parseChord(combo, true).flat().join("");

/** The edit button whose row shows `combo`, matched on the glyphs the rail draws. */
function editButtonFor(name: RegExp, combo: string): HTMLElement {
  const button = editButtons(name).find((el) => el.textContent?.endsWith(glyphs(combo)));
  if (!button) throw new Error(`no ${String(name)} row on ${combo}`);
  return button;
}

/** Each of the action's rows as its label and its whole text (keys and scope note). */
function armRows() {
  return screen
    .getAllByTestId("shortcut-row")
    .filter((row) => within(row).queryByRole("button", { name: ARM }) !== null)
    .map((row) => ({
      label: row.querySelector("[data-settings-row-label]")?.textContent,
      text: row.textContent ?? "",
    }));
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

const press = (name: string) => click(screen.getByRole("button", { name }));

describe("KeyboardShortcutsTab — an action with two keys", () => {
  it("removing the grid row's key leaves Cmd+J arming the focused terminal", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-current").textContent).toBe("X");

    await press("Remove shortcut");

    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(["Cmd+J"]);
  });

  it("recording a new key on the grid row keeps Cmd+J", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press("Capture combo");

    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual([
      "Cmd+J",
      "Cmd+Shift+K",
    ]);
  });

  it.each([
    ["Zoom in", "window.zoomIn", ["Cmd+=", "Cmd+Shift+="]],
    ["Open focused panel context menu", "terminal.contextMenu", ["Shift+F10", "ContextMenu"]],
  ])(
    "%s: saves and removes one key at a time, and Reset brings both back",
    async (label, actionId, defaults) => {
      const name = new RegExp(`^Edit shortcut for ${label}`);
      await renderTab();

      await click(editButtons(name)[1]!);
      expect(screen.getByTestId("capture-current").textContent).toBe(defaults[1]);
      await press("Capture combo");
      expect(keybindingService.getTriggerCombos(actionId)).toEqual([defaults[0], "Cmd+Shift+K"]);

      await click(editButtonFor(name, defaults[0]!));
      expect(screen.getByTestId("capture-current").textContent).toBe(defaults[0]);
      await press("Remove shortcut");
      expect(keybindingService.getTriggerCombos(actionId)).toEqual(["Cmd+Shift+K"]);

      await click(screen.getByRole("button", { name: `Reset ${label} to default` }));
      expect(keybindingService.hasOverride(actionId)).toBe(false);
      expect(keybindingService.getTriggerCombos(actionId)).toEqual(defaults);
      expect(editButtons(name)).toHaveLength(2);
    }
  );

  it("says before a save from the grid row that its key will apply across the app", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    const note = screen.getByText("A shortcut saved here applies across the app");
    // Handed to the recorder to read with its controls, not only shown beside them.
    expect(screen.getByTestId("capture-described-by").textContent?.split(" ")).toContain(note.id);
  });

  it("names the grid key that a change on the Cmd+J row would widen", async () => {
    await renderTab();
    await click(editButtons(/Join the fleet/)[0]!);
    const editor = screen.getByTestId("shortcut-capture").closest("[data-testid=shortcut-row]")!;
    expect(editor.textContent).toMatch(/After a change here, X+ applies across the app/);
  });

  it("refuses to record the action's other key, or a chord that starts with it", async () => {
    await renderTab();
    // The row's own key is the recorder's "already the current shortcut", not a refusal.
    captured.combo = "X";
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe("");
    await press("Cancel capture");

    captured.combo = "Cmd+J";
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe(
      "Already a shortcut for this action"
    );
    await press("Cancel capture");

    captured.combo = "Cmd+J Y";
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe(
      "Shares its first key with another shortcut for this action"
    );
  });

  it("saves a chord that shares nothing with the other key", async () => {
    captured.combo = "Cmd+Alt+K Y";
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe("");
    await press("Capture combo");

    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual([
      "Cmd+J",
      "Cmd+Alt+K Y",
    ]);
  });

  it("after a save, every row says where its key really applies and focus is on the new one", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press("Capture combo");

    const rows = armRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.label === "Toggle arm focused terminal (Join the fleet)")).toBe(
      true
    );
    expect(rows.every((row) => row.text.includes("Across the app"))).toBe(true);
    expect(screen.queryByText("In an expanded worktree card")).toBeNull();
    expect(document.activeElement).toBe(editButtonFor(ARM, "Cmd+Shift+K"));
  });

  it("after a removal, the remaining key keeps its row and focus, down to the Add row", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press("Remove shortcut");

    const rows = armRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).not.toContain("Across the app");
    expect(document.activeElement).toBe(editButtonFor(ARM, "Cmd+J"));

    await click(editButtonFor(ARM, "Cmd+J"));
    await press("Remove shortcut");
    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual([]);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /^Add shortcut\s?for Toggle arm focused terminal/ })
    );
  });

  it.each([
    [0, "Cmd+J", /Join the fleet/],
    [1, "X", /grid only/],
  ])(
    "Reset from row %i puts back both defaults and their scopes, focusing the %s row",
    async (rowIndex, focusKey, focusName) => {
      await renderTab();
      // Override to [Cmd+Shift+K, X]: one key the defaults lack, one they share.
      await click(editButtons(/Join the fleet/)[0]!);
      await press("Capture combo");
      expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(["Cmd+Shift+K", "X"]);

      const resets = screen.getAllByRole("button", { name: /^Reset Toggle arm focused terminal/ });
      expect(resets).toHaveLength(2);
      await click(resets[rowIndex]!);

      expect(keybindingService.hasOverride("fleet.armFocused")).toBe(false);
      expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(["Cmd+J", "X"]);
      expect(screen.getByText("In an expanded worktree card")).toBeTruthy();
      expect(document.activeElement).toBe(editButtonFor(focusName, focusKey));
    }
  );

  it("counts a two-key override as one customized shortcut", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press("Capture combo");

    expect(screen.getByText("Puts 1 customized shortcut back to its default")).toBeTruthy();
  });

  it("edits a key of an already-overridden action without touching its other key", async () => {
    await keybindingService.setOverride("window.zoomIn", ["Cmd+=", "Cmd+0"]);
    await renderTab();
    const zoomRows = editButtons(/^Edit shortcut for Zoom in/);
    expect(zoomRows).toHaveLength(2);
    await click(zoomRows[0]!);
    expect(screen.getByTestId("capture-current").textContent).toBe("Cmd+=");

    await press("Remove shortcut");

    expect(keybindingService.getTriggerCombos("window.zoomIn")).toEqual(["Cmd+0"]);
  });
});

describe("KeyboardShortcutsTab — a failed save on an action with two keys", () => {
  it.each([
    ["Capture combo", ["Cmd+J", "Cmd+Shift+K"]],
    ["Remove shortcut", ["Cmd+J"]],
  ])("%s: Retry sends the whole key list, never the row's key alone", async (button, expected) => {
    vi.mocked(actionService.dispatch).mockResolvedValueOnce(FAILURE);
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press(button);

    expect(vi.mocked(actionService.dispatch).mock.calls.at(-1)?.[1]).toEqual({
      actionId: "fleet.armFocused",
      combo: expected,
    });
    expect(screen.getByTestId("shortcut-capture")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();

    await press("Retry");

    expect(vi.mocked(actionService.dispatch).mock.calls.at(-1)?.[1]).toEqual({
      actionId: "fleet.armFocused",
      combo: expected,
    });
    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(expected);
    expect(screen.queryByTestId("shortcut-capture")).toBeNull();
  });

  it("Retry redoes the row's edit on top of a key another window added meanwhile", async () => {
    await keybindingService.setOverride("window.zoomIn", ["Cmd+=", "Cmd+0"]);
    vi.mocked(actionService.dispatch).mockResolvedValueOnce(FAILURE);
    await renderTab();
    await click(editButtonFor(/^Edit shortcut for Zoom in/, "Cmd+="));
    await press("Capture combo");
    expect(screen.getByRole("alert")).toBeTruthy();

    await act(async () => {
      await keybindingService.setOverride("window.zoomIn", ["Cmd+=", "Cmd+9"]);
    });
    await press("Retry");

    expect(keybindingService.getTriggerCombos("window.zoomIn")).toEqual(["Cmd+Shift+K", "Cmd+9"]);
  });

  it("treats keys that landed before the reply failed as saved", async () => {
    // Main stores and pushes the keys, then the menu rebuild throws.
    vi.mocked(actionService.dispatch).mockImplementationOnce(async (_id, args) => {
      const { actionId, combo } = args as { actionId: string; combo: string[] };
      await keybindingService.setOverride(actionId, combo);
      return FAILURE;
    });
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await press("Capture combo");

    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual([
      "Cmd+J",
      "Cmd+Shift+K",
    ]);
    expect(screen.queryByTestId("shortcut-capture")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(editButtonFor(ARM, "Cmd+Shift+K"));
  });
});
