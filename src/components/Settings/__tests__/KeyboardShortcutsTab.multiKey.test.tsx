// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";

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
  }: {
    onCapture: (combo: string) => void;
    onCancel: () => void;
    currentCombo?: string;
    validateCombo?: (combo: string) => React.ReactNode | null;
  }) => (
    <div data-testid="shortcut-capture">
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

beforeEach(async () => {
  Object.defineProperty(globalThis.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
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
  await keybindingService.resetAllOverrides();
  captured.combo = "Cmd+Shift+K";
  vi.mocked(actionService.dispatch).mockClear();
});

afterEach(() => {
  delete (window as { electron?: unknown }).electron;
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

/** Each of the action's rows as its label, scope note and keys read. */
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

describe("KeyboardShortcutsTab — an action with two keys", () => {
  it("removing the grid row's key leaves Cmd+J arming the focused terminal", async () => {
    await renderTab();
    await click(editButtons(/^Edit shortcut for Toggle arm focused terminal.*grid only/)[0]!);
    expect(screen.getByTestId("capture-current").textContent).toBe("X");

    await click(screen.getByRole("button", { name: "Remove shortcut" }));

    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(["Cmd+J"]);
  });

  it("recording a new key on one Zoom in row keeps the other default", async () => {
    await renderTab();
    const [, shiftRow] = editButtons(/^Edit shortcut for Zoom in/);
    await click(shiftRow!);
    expect(screen.getByTestId("capture-current").textContent).toBe("Cmd+Shift+=");

    await click(screen.getByRole("button", { name: "Capture combo" }));

    expect(keybindingService.getTriggerCombos("window.zoomIn")).toEqual(["Cmd+=", "Cmd+Shift+K"]);
  });

  it("removing one context-menu key keeps the other", async () => {
    await renderTab();
    const [first] = editButtons(/^Edit shortcut for Open focused panel context menu/);
    await click(first!);

    await click(screen.getByRole("button", { name: "Remove shortcut" }));

    expect(keybindingService.getTriggerCombos("terminal.contextMenu")).toEqual(["ContextMenu"]);
  });

  it("says before a save from the grid row that its key will apply across the app", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByText("A shortcut saved here applies across the app")).toBeTruthy();
  });

  it("names the grid key that a change on the Cmd+J row would widen", async () => {
    await renderTab();
    await click(editButtons(/Join the fleet/)[0]!);
    const editor = screen.getByTestId("shortcut-capture").closest("[data-testid=shortcut-row]")!;
    expect(editor.textContent).toContain("After a change here,");
    expect(editor.textContent).toContain(`${glyphs("X")} applies across the app`);
  });

  it("refuses to record the action's other key on a row", async () => {
    await renderTab();
    // The row's own key is the recorder's "already the current shortcut", not a refusal.
    captured.combo = "X";
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe("");
    await click(screen.getByRole("button", { name: "Cancel capture" }));

    captured.combo = "Cmd+J";
    await click(editButtons(/grid only/)[0]!);
    expect(screen.getByTestId("capture-validation").textContent).toBe(
      "Already a shortcut for this action"
    );
  });

  it("after a save, every row says where its key really applies and focus is on the new one", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await click(screen.getByRole("button", { name: "Capture combo" }));

    const rows = armRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.label === "Toggle arm focused terminal (Join the fleet)")).toBe(
      true
    );
    expect(rows.every((row) => row.text.includes("Across the app"))).toBe(true);
    expect(screen.queryByText("In an expanded worktree card")).toBeNull();
    expect(document.activeElement?.textContent).toContain(glyphs("Cmd+Shift+K"));
  });

  it("after a removal, the remaining key keeps its row and focus", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await click(screen.getByRole("button", { name: "Remove shortcut" }));

    const rows = armRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain(glyphs("Cmd+J"));
    expect(rows[0]!.text).not.toContain("Across the app");
    expect(document.activeElement?.textContent).toContain(glyphs("Cmd+J"));
  });

  it("Reset from either row puts back both default keys and their scopes", async () => {
    await renderTab();
    await click(editButtons(/grid only/)[0]!);
    await click(screen.getByRole("button", { name: "Capture combo" }));

    await click(
      screen.getAllByRole("button", { name: /^Reset Toggle arm focused terminal/ }).at(-1)!
    );

    expect(keybindingService.hasOverride("fleet.armFocused")).toBe(false);
    expect(keybindingService.getTriggerCombos("fleet.armFocused")).toEqual(["Cmd+J", "X"]);
    expect(screen.getByText("In an expanded worktree card")).toBeTruthy();
    expect(editButtons(/grid only/)).toHaveLength(1);
  });

  it("edits a key of an already-overridden action without touching its other key", async () => {
    await keybindingService.setOverride("window.zoomIn", ["Cmd+=", "Cmd+0"]);
    await renderTab();
    const zoomRows = editButtons(/^Edit shortcut for Zoom in/);
    expect(zoomRows).toHaveLength(2);
    await click(zoomRows[0]!);
    expect(screen.getByTestId("capture-current").textContent).toBe("Cmd+=");

    await click(screen.getByRole("button", { name: "Remove shortcut" }));

    expect(keybindingService.getTriggerCombos("window.zoomIn")).toEqual(["Cmd+0"]);
  });
});
