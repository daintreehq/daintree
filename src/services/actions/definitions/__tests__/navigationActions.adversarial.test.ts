// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDefinition } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry } from "../../actionTypes";
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
  const def = factory() as ActionDefinition<unknown, unknown>;
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

  it("find.inFocusedPanel dispatches a canopy:find-in-panel event", async () => {
    const { actions } = setupActions();
    await call(actions, "find.inFocusedPanel");

    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const event = dispatchSpy.mock.calls[0][0] as unknown as { type: string };
    expect(event.type).toBe("canopy:find-in-panel");
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
      const def = factory!() as ActionDefinition<unknown, unknown>;
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
