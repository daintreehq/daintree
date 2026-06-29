// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

const onViewRevealedMock = vi.hoisted(() => vi.fn<(cb: () => void) => () => void>());
const clearSwitchingMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("window", {
  ...globalThis.window,
  electron: {
    app: {
      onViewRevealed: onViewRevealedMock,
    },
  },
});

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ clearSwitching: clearSwitchingMock }),
  },
}));

import { useClearSwitchBusyStateOnReveal } from "../useClearSwitchBusyStateOnReveal";

describe("useClearSwitchBusyStateOnReveal", () => {
  let revealCallback: (() => void) | null = null;
  let offReveal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    offReveal = vi.fn();
    revealCallback = null;
    onViewRevealedMock.mockImplementation((cb) => {
      revealCallback = cb;
      return offReveal as () => void;
    });
  });

  it("subscribes to the reveal signal on mount", () => {
    renderHook(() => useClearSwitchBusyStateOnReveal());
    expect(onViewRevealedMock).toHaveBeenCalledTimes(1);
  });

  it("clears the switch flag when the cached view is revealed", () => {
    renderHook(() => useClearSwitchBusyStateOnReveal());

    expect(clearSwitchingMock).not.toHaveBeenCalled();
    act(() => {
      revealCallback?.();
    });

    expect(clearSwitchingMock).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from the reveal signal on unmount", () => {
    const { unmount } = renderHook(() => useClearSwitchBusyStateOnReveal());
    unmount();

    expect(offReveal).toHaveBeenCalledTimes(1);
  });
});
