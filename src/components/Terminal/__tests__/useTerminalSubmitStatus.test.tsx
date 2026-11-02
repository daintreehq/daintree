// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

type Payload = { id: string; state: "slow" | "stalled" | "settled" | "failed" };
const listeners = new Set<(payload: Payload) => void>();

vi.mock("@/clients", () => ({
  terminalClient: {
    onSubmitStatus: (cb: (payload: Payload) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  },
}));

import { useTerminalSubmitStatus } from "../useTerminalSubmitStatus";
import { _resetPanelFailureStoreForTest, usePanelFailureStore } from "@/store/panelFailureStore";

function emit(payload: Payload) {
  act(() => {
    for (const listener of listeners) listener(payload);
  });
}

const submitToken = (id: string) => usePanelFailureStore.getState().occurrences[id]?.submit?.token;

afterEach(() => {
  listeners.clear();
  _resetPanelFailureStoreForTest();
});

describe("useTerminalSubmitStatus", () => {
  it("records each failed submit as its own failure, back to back", () => {
    const { result } = renderHook(() => useTerminalSubmitStatus("t-1"));

    for (const state of ["slow", "stalled", "settled"] as const) {
      emit({ id: "t-1", state });
      expect(submitToken("t-1"), state).toBeUndefined();
    }

    emit({ id: "t-1", state: "failed" });
    expect(result.current).toBe("failed");
    const first = submitToken("t-1");
    expect(first).toBeDefined();

    emit({ id: "t-1", state: "failed" });
    expect(submitToken("t-1")).toBeDefined();
    expect(submitToken("t-1")).not.toBe(first);
  });

  it("leaves another terminal's failed submit to that terminal's pane", () => {
    const { result, unmount } = renderHook(() => useTerminalSubmitStatus("t-1"));
    emit({ id: "t-1", state: "failed" });
    const own = submitToken("t-1");
    expect(own).toBeDefined();

    emit({ id: "t-2", state: "failed" });
    expect(submitToken("t-1")).toBe(own);
    expect(submitToken("t-2")).toBeUndefined();
    expect(result.current).toBe("failed");

    unmount();
    expect(listeners.size).toBe(0);
  });
});
