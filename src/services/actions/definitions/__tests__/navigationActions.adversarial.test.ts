// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionSource } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

interface LayoutChange {
  actionId: string;
  changed: boolean;
  title: string;
  message: (displayCombo: string) => string;
  onUndo: () => void;
  dispatchSource?: ActionSource;
}

const notifyLayoutChange = vi.fn<(change: LayoutChange) => void>();
vi.mock("../../keyboardLayoutChangeFeedback", () => ({
  notifyUndoableKeyboardLayoutChange: (change: LayoutChange) => notifyLayoutChange(change),
}));

import { useFocusStore } from "@/store/focusStore";
import { registerNavigationActions } from "../navigationActions";

function setupActions() {
  const callbacks = {
    onToggleSidebar: vi.fn(),
    onOpenActionPalette: vi.fn(),
    onToggleFocusMode: vi.fn(),
    onOpenQuickSwitcher: vi.fn(),
    onFocusRegionNext: vi.fn(),
    onFocusRegionPrev: vi.fn(),
  } as unknown as ActionCallbacks & {
    onToggleSidebar: ReturnType<typeof vi.fn>;
    onOpenActionPalette: ReturnType<typeof vi.fn>;
    onToggleFocusMode: ReturnType<typeof vi.fn>;
    onOpenQuickSwitcher: ReturnType<typeof vi.fn>;
    onFocusRegionNext: ReturnType<typeof vi.fn>;
    onFocusRegionPrev: ReturnType<typeof vi.fn>;
  };
  const actions: ActionRegistry = new Map();
  registerNavigationActions(actions, callbacks);
  return { actions, callbacks };
}

const dispatchSpy = vi.fn<(event: Event) => boolean>(() => true);

beforeEach(() => {
  dispatchSpy.mockReset().mockReturnValue(true);
  notifyLayoutChange.mockReset();
  useFocusStore.setState({ gestureSidebarHidden: false });
  Object.defineProperty(globalThis.window, "dispatchEvent", {
    value: dispatchSpy,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

async function call(actions: ActionRegistry, id: string) {
  const factory = actions.get(id);
  if (!factory) throw new Error(`missing ${id}`);
  const def = factory() as AnyActionDefinition;
  return def.run(undefined, {} as never);
}

describe("navigationActions adversarial", () => {
  it("each action dispatches exactly its corresponding callback once", async () => {
    const { actions, callbacks } = setupActions();

    await call(actions, "nav.toggleSidebar");
    expect(callbacks.onToggleSidebar).toHaveBeenCalledTimes(1);

    await call(actions, "action.palette.open");
    expect(callbacks.onOpenActionPalette).toHaveBeenCalledTimes(1);

    await call(actions, "nav.toggleFocusMode");
    expect(callbacks.onToggleFocusMode).toHaveBeenCalledTimes(1);

    await call(actions, "nav.quickSwitcher");
    expect(callbacks.onOpenQuickSwitcher).toHaveBeenCalledTimes(1);

    await call(actions, "nav.focusRegion.next");
    expect(callbacks.onFocusRegionNext).toHaveBeenCalledTimes(1);

    await call(actions, "nav.focusRegion.prev");
    expect(callbacks.onFocusRegionPrev).toHaveBeenCalledTimes(1);
  });

  it("find.inFocusedPanel dispatches a daintree:find-in-panel event", async () => {
    const { actions } = setupActions();
    await call(actions, "find.inFocusedPanel");

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0]![0] as unknown as { type: string };
    expect(event.type).toBe("daintree:find-in-panel");
  });

  it("each action takes no args (verified by Action shape)", () => {
    const { actions } = setupActions();
    for (const id of [
      "nav.toggleSidebar",
      "action.palette.open",
      "nav.toggleFocusMode",
      "nav.quickSwitcher",
      "nav.focusRegion.next",
      "nav.focusRegion.prev",
      "find.inFocusedPanel",
    ]) {
      const factory = actions.get(id);
      expect(factory).toBeDefined();
      const def = factory!() as AnyActionDefinition;
      expect(def.argsSchema).toBeUndefined();
      expect(def.danger).toBe("safe");
    }
  });

  it("callback throws propagate cleanly out of the action run", async () => {
    const { actions, callbacks } = setupActions();
    callbacks.onToggleSidebar.mockImplementationOnce(() => {
      throw new Error("sidebar exploded");
    });

    await expect(call(actions, "nav.toggleSidebar")).rejects.toThrow("sidebar exploded");
  });

  it("registers exactly 7 navigation actions", () => {
    const { actions } = setupActions();
    expect(actions.size).toBe(7);
  });
});

describe("nav.toggleSidebar keyboard feedback (issue #11704)", () => {
  /** Mimics AppLayout's listener: flips the store while the event dispatches. */
  function toggleOnDispatch(callbacks: { onToggleSidebar: ReturnType<typeof vi.fn> }) {
    callbacks.onToggleSidebar.mockImplementation(() => {
      const { gestureSidebarHidden } = useFocusStore.getState();
      useFocusStore.setState({ gestureSidebarHidden: !gestureSidebarHidden });
    });
  }

  async function runToggle(actions: ActionRegistry, source: ActionSource | undefined) {
    const def = actions.get("nav.toggleSidebar")!() as AnyActionDefinition;
    await def.run(undefined, { dispatchSource: source } as ActionContext);
  }

  it("reports the hide direction as the change worth announcing", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);

    await runToggle(actions, "keybinding");

    expect(notifyLayoutChange.mock.calls[0]![0]!.changed).toBe(true);
  });

  it("reports the show direction as nothing to announce", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);
    useFocusStore.setState({ gestureSidebarHidden: true });

    await runToggle(actions, "keybinding");

    expect(notifyLayoutChange.mock.calls[0]![0]!.changed).toBe(false);
  });

  it("reports no change when a guard swallowed the toggle", async () => {
    // AppLayout drops the event when an overlay is open or no workspace is
    // mounted; the store never moves, so the observed transition is the guard.
    const { actions, callbacks } = setupActions();
    callbacks.onToggleSidebar.mockImplementation(() => {});

    await runToggle(actions, "keybinding");

    expect(notifyLayoutChange.mock.calls[0]![0]!.changed).toBe(false);
  });

  it("forwards the dispatch source so non-keyboard paths can be filtered out", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);

    await runToggle(actions, "user");

    expect(notifyLayoutChange.mock.calls[0]![0]!.dispatchSource).toBe("user");
  });

  it("tolerates a context with no dispatch source", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);

    await expect(runToggle(actions, undefined)).resolves.not.toThrow();
    expect(notifyLayoutChange.mock.calls[0]![0]!.dispatchSource).toBeUndefined();
  });

  it("undo toggles back through the same path, keeping AppLayout's guards", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);
    await runToggle(actions, "keybinding");
    expect(useFocusStore.getState().gestureSidebarHidden).toBe(true);

    notifyLayoutChange.mock.calls[0]![0]!.onUndo();

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(callbacks.onToggleSidebar).toHaveBeenCalledTimes(2);
  });

  it("announces under the toggle's own identity, so familiarity is keyed correctly", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);

    await runToggle(actions, "keybinding");

    const change = notifyLayoutChange.mock.calls[0]![0]!;
    expect(change.actionId).toBe("nav.toggleSidebar");
    expect(change.title).toBe("Sidebar hidden");
    // The combo is resolved live rather than hard-coded, so a rebind still
    // names the key the user actually pressed.
    expect(change.message("⌃⇧S")).toContain("⌃⇧S");
  });

  it("undo restores the sidebar even when an overlay swallows the toggle event", async () => {
    // The toast is dismissed by the click either way, so a swallowed event
    // would leave the sidebar hidden with the promised way back gone.
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);
    await runToggle(actions, "keybinding");

    callbacks.onToggleSidebar.mockImplementation(() => {});
    notifyLayoutChange.mock.calls[0]![0]!.onUndo();

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
  });

  it("undo does nothing if the sidebar is already back", async () => {
    const { actions, callbacks } = setupActions();
    toggleOnDispatch(callbacks);
    await runToggle(actions, "keybinding");
    // The user reached for the toolbar button before the toast lapsed.
    useFocusStore.setState({ gestureSidebarHidden: false });

    notifyLayoutChange.mock.calls[0]![0]!.onUndo();

    expect(useFocusStore.getState().gestureSidebarHidden).toBe(false);
    expect(callbacks.onToggleSidebar).toHaveBeenCalledTimes(1);
  });
});
