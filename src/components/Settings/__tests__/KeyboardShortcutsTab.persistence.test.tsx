// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";

// jsdom ships no matchMedia; InlineStatusBanner reads it to honour reduced motion.
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

// ...nor ResizeObserver, which the dialog's scroll-shadow hook observes with.
class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;

// vi.mock factories are hoisted above the module body, so every mutable handle a
// factory touches has to be created inside vi.hoisted or it is still in TDZ.
//
// `dispatch` is typed at the source rather than cast at each read: casting
// `.mock.calls` would add no-unsafe-type-assertion warnings, which the lint
// ratchet scores per rule.
const { dispatch, notify, overrides, loadOverrides, CAPTURED_COMBO } = vi.hoisted(() => ({
  dispatch:
    vi.fn<
      (
        actionId: string,
        args?: { actionId: string; combo?: string[] },
        opts?: { source?: string; confirmed?: boolean }
      ) => Promise<{ ok: boolean }>
    >(),
  notify: vi.fn(),
  overrides: new Set<string>(),
  loadOverrides: vi.fn().mockResolvedValue(undefined),
  CAPTURED_COMBO: "Cmd+Shift+J",
}));

vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch },
}));

vi.mock("@/lib/notify", () => ({ notify }));

// Stands in for the real capture widget: reports a known combo, so a test can
// prove the *captured* value survives a failed save rather than only that a
// callback fired.
vi.mock("@/components/KeyboardShortcuts", () => ({
  SettingsShortcutCapture: ({
    onCapture,
    onCancel,
  }: {
    onCapture: (combo: string) => void;
    onCancel: () => void;
  }) => (
    <div data-testid="shortcut-capture">
      <button type="button" onClick={() => onCapture(CAPTURED_COMBO)}>
        Capture combo
      </button>
      <button type="button" onClick={() => onCapture("")}>
        Capture unbind
      </button>
      <button type="button" onClick={onCancel}>
        Cancel capture
      </button>
    </div>
  ),
}));

// Exposes the import callback as a button so a test can land an import while a
// save is still in flight.
vi.mock("@/components/Settings/KeybindingProfileActions", () => ({
  KeybindingProfileActions: ({ onImportComplete }: { onImportComplete: () => void }) => (
    <button type="button" onClick={onImportComplete}>
      Finish import
    </button>
  ),
}));

vi.mock("@/services/KeybindingService", () => ({
  keybindingService: {
    getAllBindingsWithEffectiveCombos: () => [
      {
        actionId: "app.save",
        description: "Save file",
        category: "File",
        scope: "global",
        effectiveCombo: "Cmd+S",
      },
    ],
    hasOverride: (actionId: string) => overrides.has(actionId),
    formatComboForDisplay: (combo: string) => combo,
    loadOverrides,
    subscribe: () => () => {},
  },
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { KeyboardShortcutsTab } from "../KeyboardShortcutsTab";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const FAILURE = { ok: false as const, error: { code: "IPC_FAILED", message: "raw ipc detail" } };
const SUCCESS = { ok: true as const, result: undefined };

const row = () => screen.getByTestId("shortcut-row");
const clickText = async (label: string) =>
  act(async () => {
    screen.getByText(label).click();
  });

async function renderTab() {
  // The per-row reset button is a tooltip trigger, so it needs Radix's provider —
  // in the app that comes from the Settings dialog's tree.
  render(
    <TooltipProvider>
      <KeyboardShortcutsTab />
    </TooltipProvider>
  );
  // Flush the mount-time loadOverrides().then(loadBindings) chain.
  await act(async () => {
    await Promise.resolve();
  });
}

const openEditor = () => clickText("Edit");

beforeEach(() => {
  dispatch.mockReset();
  notify.mockClear();
  loadOverrides.mockClear();
  overrides.clear();
});

describe("KeyboardShortcutsTab — failed shortcut save", () => {
  it("keeps the editor open and reports the failure instead of closing as if it saved", async () => {
    dispatch.mockResolvedValue(FAILURE);

    await renderTab();
    await openEditor();
    await clickText("Capture combo");

    // The editor must still be mounted — closing here is exactly the bug: the
    // user would see the old binding with no sign the capture was discarded.
    expect(screen.getByTestId("shortcut-capture")).toBeTruthy();
    expect(within(row()).getByRole("alert")).toBeTruthy();
  });

  it("retries with the combo the user captured, then closes the editor once it lands", async () => {
    dispatch.mockResolvedValueOnce(FAILURE).mockResolvedValueOnce(SUCCESS);

    await renderTab();
    await openEditor();
    await clickText("Capture combo");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());

    const lastCall = dispatch.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("keybinding.setOverride");
    // The captured combo survived the failure — Retry re-sends it, not a default.
    expect(lastCall?.[1]?.combo).toEqual([CAPTURED_COMBO]);
    expect(screen.queryByTestId("shortcut-capture")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves an unbind (empty combo) across a retry rather than resending a key", async () => {
    dispatch.mockResolvedValueOnce(FAILURE).mockResolvedValueOnce(SUCCESS);

    await renderTab();
    await openEditor();
    await clickText("Capture unbind");
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());

    expect(dispatch.mock.calls.at(-1)?.[1]?.combo).toEqual([]);
  });

  it("keeps the raw dispatch error out of the UI", async () => {
    dispatch.mockResolvedValue(FAILURE);

    await renderTab();
    await openEditor();
    await clickText("Capture combo");

    expect(screen.queryByText(/raw ipc detail/)).toBeNull();
    expect(notify).not.toHaveBeenCalled();
  });

  it("does not raise a banner for a save that was superseded by a profile import", async () => {
    const pending = deferred<typeof FAILURE>();
    dispatch.mockReturnValue(pending.promise);

    await renderTab();
    await openEditor();
    await clickText("Capture combo"); // dispatch in flight

    // A profile import lands while that save is still pending. It replaced every
    // binding, so the save's failure is about a binding that no longer exists —
    // and its Retry would overwrite the imported profile with the stale combo.
    await clickText("Finish import");

    await act(async () => {
      pending.resolve(FAILURE);
      await pending.promise;
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("discards the error when the user cancels the editor", async () => {
    dispatch.mockResolvedValue(FAILURE);

    await renderTab();
    await openEditor();
    await clickText("Capture combo");
    expect(screen.getByRole("alert")).toBeTruthy();

    await clickText("Cancel capture");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("shortcut-capture")).toBeNull();
  });
});

describe("KeyboardShortcutsTab — failed shortcut reset", () => {
  it("reports the failure on the row and leaves the custom binding in place", async () => {
    overrides.add("app.save");
    dispatch.mockResolvedValue(FAILURE);

    await renderTab();
    await act(async () => screen.getByLabelText("Reset to default").click());

    expect(within(row()).getByRole("alert")).toBeTruthy();
    // Retry re-issues the reset for that row.
    dispatch.mockResolvedValue(SUCCESS);
    await act(async () => screen.getByRole("button", { name: "Retry" }).click());

    const lastCall = dispatch.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("keybinding.removeOverride");
    expect(lastCall?.[1]?.actionId).toBe("app.save");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("KeyboardShortcutsTab — failed reset all", () => {
  it("holds the dialog open with an inline error and never reloads the overrides", async () => {
    dispatch.mockResolvedValue(FAILURE);

    await renderTab();
    await clickText("Reset all");
    await act(async () => screen.getByRole("button", { name: "Reset shortcuts" }).click());

    // Dialog stays up, explains itself, and its own confirm button is the retry.
    expect(screen.getByRole("button", { name: "Reset shortcuts" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    // Only the mount-time load — a failed reset must not re-read overrides, which
    // would redraw the list as though the reset had happened.
    expect(loadOverrides).toHaveBeenCalledTimes(1);
  });

  it("closes the dialog and reloads overrides only once the reset actually lands", async () => {
    const pending = deferred<typeof SUCCESS>();
    dispatch.mockReturnValue(pending.promise);

    await renderTab();
    await clickText("Reset all");
    await act(async () => screen.getByRole("button", { name: "Reset shortcuts" }).click());

    await act(async () => {
      pending.resolve(SUCCESS);
      await pending.promise;
    });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(loadOverrides).toHaveBeenCalledTimes(2); // mount + successful reset
  });
});
