// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireHelpSessionController,
  releaseHelpSessionController,
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
