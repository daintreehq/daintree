// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  acquireHelpSessionController,
  releaseHelpSessionController,
  useHelpSessionController,
  __hasHelpSessionControllerForTests,
  __resetHelpSessionControllersForTests,
} from "../helpSessionControllerRegistry";

vi.mock("@/store/helpPanelStore", () => {
  const state = { sessions: {}, activeSlot: 0 };
  const store = (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state);
  store.getState = () => state;
  return { useHelpPanelStore: store, selectSlot: (s: typeof state) => s };
});
vi.mock("@/store", () => ({
  usePanelStore: Object.assign(() => ({}), { getState: () => ({}) }),
  useProjectStore: Object.assign(() => ({}), { getState: () => ({}) }),
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: vi.fn() } }));
vi.mock("@/clients/projectClient", () => ({ projectClient: {} }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn() }));

afterEach(() => {
  // Unmount first: a still-mounted holder would re-mint on the reset's notify.
  cleanup();
  __resetHelpSessionControllersForTests();
});

/**
 * #12108. The registry exists because a lane's controller must outlive the
 * component showing it: a background lane still needs its MCP subscriptions to
 * surface approvals, and its idle timer to hibernate it.
 */
describe("helpSessionControllerRegistry", () => {
  it("hands back the same controller for a lane, and distinct ones across lanes", () => {
    const first = acquireHelpSessionController(0);

    // Re-acquiring must not mint a second controller: two instances on one lane
    // would double-arm the IPC listeners and double-count its launch state.
    expect(acquireHelpSessionController(0)).toBe(first);
    expect(acquireHelpSessionController(1)).not.toBe(first);
    expect(first.slot).toBe(0);
    expect(acquireHelpSessionController(1).slot).toBe(1);
  });

  it("survives being acquired again after the panel switches away and back", () => {
    // The bug this pins: an arm/disarm effect keyed on the ACTIVE controller
    // tore down the outgoing lane on every tab switch. `stop()` is not a
    // neutral pause — it bumps the launch generation, so an in-flight launch in
    // the lane the user tabbed away from would silently bail. Identity has to
    // survive the round trip so the lane keeps whichever launch it had running.
    const laneZero = acquireHelpSessionController(0);
    acquireHelpSessionController(1);

    expect(acquireHelpSessionController(0)).toBe(laneZero);
  });

  it("mints a fresh controller only after the lane is explicitly released", () => {
    const before = acquireHelpSessionController(2);
    releaseHelpSessionController(2);

    expect(acquireHelpSessionController(2)).not.toBe(before);
  });

  it("releasing an unknown lane is a no-op", () => {
    expect(() => releaseHelpSessionController(2)).not.toThrow();
  });
});

/**
 * #13544. A component holding a lane's controller across renders must follow a
 * release. In the build the React Compiler memoizes a render-time acquire on the
 * slot alone, so the component only sees a new controller if the release itself
 * re-renders it — which is exactly what `renderHook` isolates here: nothing else
 * re-renders the hook.
 */
describe("useHelpSessionController", () => {
  it("keeps the registered controller across re-renders", () => {
    const { result, rerender } = renderHook(({ slot }) => useHelpSessionController(slot), {
      initialProps: { slot: 0 },
    });
    const first = result.current;

    rerender({ slot: 0 });

    expect(result.current).toBe(first);
    expect(acquireHelpSessionController(0)).toBe(first);
  });

  it("moves to the fresh controller once its lane is released and the slot reused", () => {
    // Closing the only tab releases slot 0 and recreates it empty. The holder
    // must not keep the stopped instance while call-time acquires (Restart
    // conversation) mint an unsynced second one — that pair is what showed
    // "still loading" on a loaded workspace.
    const { result } = renderHook(() => useHelpSessionController(0));
    const stale = result.current;
    const stopSpy = vi.spyOn(stale, "stop");

    act(() => {
      releaseHelpSessionController(0);
    });

    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(result.current).not.toBe(stale);
    expect(result.current.slot).toBe(0);
    expect(acquireHelpSessionController(0)).toBe(result.current);
  });

  it("ignores the release of another lane", () => {
    const { result } = renderHook(() => useHelpSessionController(0));
    const laneZero = result.current;
    acquireHelpSessionController(1);

    act(() => {
      releaseHelpSessionController(1);
    });

    expect(result.current).toBe(laneZero);
  });

  it("follows a slot change to that lane's controller", () => {
    const laneOne = acquireHelpSessionController(1);
    const { result, rerender } = renderHook(({ slot }) => useHelpSessionController(slot), {
      initialProps: { slot: 0 },
    });

    rerender({ slot: 1 });

    expect(result.current).toBe(laneOne);
  });

  it("hands every holder of a released lane the same replacement", () => {
    const first = renderHook(() => useHelpSessionController(0));
    const second = renderHook(() => useHelpSessionController(0));
    const stale = first.result.current;

    act(() => {
      releaseHelpSessionController(0);
    });

    expect(first.result.current).not.toBe(stale);
    expect(second.result.current).toBe(first.result.current);
  });

  it("leaves nothing behind for a lane that is closed outright", () => {
    // React reads the snapshot synchronously inside the release notification,
    // while the lane is still mounted. A snapshot that acquired would re-mint
    // the controller there, and the lane unmounting a moment later would strand
    // it in the registry for good.
    const lane = renderHook(() => useHelpSessionController(3));
    expect(__hasHelpSessionControllerForTests(3)).toBe(true);

    act(() => {
      releaseHelpSessionController(3);
      lane.unmount();
    });

    expect(__hasHelpSessionControllerForTests(3)).toBe(false);
  });
});
