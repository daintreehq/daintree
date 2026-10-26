// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionContext, ActionSource } from "@shared/types/actions";
import type { ActionCallbacks, ActionRegistry, AnyActionDefinition } from "../../actionTypes";

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
});
