/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

interface Notice {
  type: string;
  actions: Array<{ onClick: () => void }>;
}

const mocks = vi.hoisted(() => ({
  listener: null as ((payload: { project?: { id: string; name: string } }) => void) | null,
  unsubscribe: vi.fn(),
  restoreViewState: vi.fn(),
  notify: vi.fn<(notice: Notice) => void>(),
  dispatch: vi.fn(),
  dropped: null as string | null,
}));

vi.mock("@/clients/projectClient", () => ({
  projectClient: {
    onSwitch: (cb: (payload: { project?: { id: string; name: string } }) => void) => {
      mocks.listener = cb;
      return mocks.unsubscribe;
    },
  },
}));
vi.mock("@/utils/stateHydration/restoreViewState", () => ({
  restoreViewState: mocks.restoreViewState,
}));
vi.mock("@/lib/notify", () => ({ notify: mocks.notify }));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch: mocks.dispatch } }));
vi.mock("@/utils/logger", () => ({ logError: vi.fn() }));
// The claim's take-once contract, with the store's heavy import graph stubbed out.
vi.mock("@/store/projectStore", () => ({
  claimDroppedViewRestore: (id: string) => {
    if (mocks.dropped !== id) return false;
    mocks.dropped = null;
    return true;
  },
}));

import { useDroppedViewRestore } from "../useDroppedViewRestore";

function dropView(id: string | null) {
  mocks.dropped = id;
}

function emitSwitch(id: string) {
  if (!mocks.listener) throw new Error("hook never subscribed");
  mocks.listener({ project: { id, name: `Project ${id}` } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listener = null;
  mocks.restoreViewState.mockResolvedValue(undefined);
  dropView(null);
});

describe("useDroppedViewRestore", () => {
  it("restores once when the view comes back onto the project it dropped from", () => {
    renderHook(() => useDroppedViewRestore());
    dropView("p1");
    emitSwitch("p1");
    emitSwitch("p1");
    expect(mocks.restoreViewState).toHaveBeenCalledTimes(1);
  });

  it("leaves views that never dropped, or that open a different project, alone", () => {
    renderHook(() => useDroppedViewRestore());
    emitSwitch("p1");
    dropView("p1");
    emitSwitch("p2");
    expect(mocks.restoreViewState).not.toHaveBeenCalled();
  });

  it("offers a restart when the restore fails", async () => {
    mocks.restoreViewState.mockRejectedValue(new Error("boom"));
    renderHook(() => useDroppedViewRestore());
    dropView("p1");
    emitSwitch("p1");
    await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalledTimes(1));
    const notice = mocks.notify.mock.calls[0]![0];
    expect(notice.type).toBe("error");
    notice.actions[0]!.onClick();
    expect(mocks.dispatch).toHaveBeenCalledWith(
      "project.restart",
      { projectId: "p1" },
      { source: "user" }
    );
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useDroppedViewRestore());
    unmount();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
