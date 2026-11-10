// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

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
  }: {
    onCapture: (combo: string) => void;
    onCancel: () => void;
    currentCombo?: string;
  }) => (
    <div data-testid="shortcut-capture">
      <span data-testid="capture-current">{currentCombo}</span>
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
});
