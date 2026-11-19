// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodexLimitContinueChange,
  CodexLimitContinueEntry,
} from "@shared/types/codexLimitContinuation";
import { useCodexLimitContinueBridge } from "@/hooks/useCodexLimitContinueBridge";
import { useCodexLimitContinueStore } from "@/store/codexLimitContinueStore";
import { notifyHostResync } from "@/store/hostResyncSignal";

let pushChange: ((change: CodexLimitContinueChange) => void) | null = null;
let resolveList: ((entries: CodexLimitContinueEntry[]) => void) | null = null;
const offChanged = vi.fn();

const waiting = { status: "waiting", resetsAt: 1_000, continueAt: 61_000 } as const;

beforeEach(() => {
  offChanged.mockReset();
  useCodexLimitContinueStore.setState({ panes: {}, disarmed: {} });
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      codexLimitContinue: {
        list: () =>
          new Promise<CodexLimitContinueEntry[]>((resolve) => {
            resolveList = resolve;
          }),
        onChanged: (cb: typeof pushChange) => {
          pushChange = cb;
          return offChanged;
        },
      },
    },
  });
});

describe("useCodexLimitContinueBridge (#17909)", () => {
  it("reads main's armed panes on load, so a reloaded view shows where each stands", async () => {
    renderHook(() => useCodexLimitContinueBridge());
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 4, state: waiting }]);
    });
    expect(useCodexLimitContinueStore.getState().panes).toEqual({
      t1: { revision: 4, state: waiting },
    });
  });

  it("keeps a change pushed before the list answered over the list's older entry", async () => {
    renderHook(() => useCodexLimitContinueBridge());
    act(() => {
      pushChange!({ terminalId: "t1", revision: 7, state: null });
      pushChange!({ terminalId: "t2", revision: 8, state: { status: "armed" } });
    });
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 4, state: waiting }]);
    });
    expect(useCodexLimitContinueStore.getState().panes).toEqual({
      t2: { revision: 8, state: { status: "armed" } },
    });
  });

  it("keeps a list entry newer than a push that arrived before it", async () => {
    renderHook(() => useCodexLimitContinueBridge());
    act(() => {
      pushChange!({ terminalId: "t1", revision: 4, state: { status: "armed" } });
    });
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 5, state: waiting }]);
    });
    expect(useCodexLimitContinueStore.getState().panes.t1).toEqual({ revision: 5, state: waiting });
  });

  it("never brings back a pane disarmed after the arm a late push carries", () => {
    renderHook(() => useCodexLimitContinueBridge());
    act(() => {
      pushChange!({ terminalId: "t1", revision: 6, state: null });
      pushChange!({ terminalId: "t1", revision: 5, state: { status: "armed" } });
    });
    expect(useCodexLimitContinueStore.getState().panes).toEqual({});
  });

  it("reads the list again when a remote view's link comes back", async () => {
    renderHook(() => useCodexLimitContinueBridge());
    await act(async () => {
      resolveList!([]);
    });
    act(() => notifyHostResync());
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 9, state: waiting }]);
    });
    expect(useCodexLimitContinueStore.getState().panes).toEqual({
      t1: { revision: 9, state: waiting },
    });
  });

  it("drops a pane disarmed while the link was down, though a stale push lands mid-refresh", async () => {
    useCodexLimitContinueStore.setState({
      panes: { t1: { revision: 5, state: { status: "armed" } } },
      disarmed: {},
    });
    renderHook(() => useCodexLimitContinueBridge());
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 5, state: { status: "armed" } }]);
    });
    act(() => notifyHostResync());
    act(() => {
      pushChange!({ terminalId: "t1", revision: 4, state: { status: "armed" } });
    });
    await act(async () => {
      resolveList!([]);
    });
    expect(useCodexLimitContinueStore.getState().panes).toEqual({});
  });

  it("believes a list from a host restarted with its clock behind the view's last disarm", async () => {
    useCodexLimitContinueStore.setState({ panes: {}, disarmed: { t1: 9_000 } });
    renderHook(() => useCodexLimitContinueBridge());
    await act(async () => {
      resolveList!([{ terminalId: "t1", revision: 4_000, state: waiting }]);
    });
    expect(useCodexLimitContinueStore.getState().panes.t1).toEqual({
      revision: 4_000,
      state: waiting,
    });
  });

  it("ignores a push older than what the view holds", () => {
    renderHook(() => useCodexLimitContinueBridge());
    act(() => {
      pushChange!({ terminalId: "t1", revision: 5, state: waiting });
      pushChange!({ terminalId: "t1", revision: 3, state: { status: "armed" } });
    });
    expect(useCodexLimitContinueStore.getState().panes.t1).toEqual({ revision: 5, state: waiting });
  });

  it("stops listening when the view goes", () => {
    const { unmount } = renderHook(() => useCodexLimitContinueBridge());
    unmount();
    expect(offChanged).toHaveBeenCalledTimes(1);
  });
});
