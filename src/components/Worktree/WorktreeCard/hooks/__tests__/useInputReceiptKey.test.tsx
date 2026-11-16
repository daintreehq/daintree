/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useInputReceiptKey } from "../useInputReceiptKey";
import { usePanelStore } from "@/store/panelStore";
import { useWorktreeTerminalSummary } from "@/hooks/useWorktreeTerminals";
import type { PtyPanelData } from "@shared/types/panel";

const ping = (id: string) => act(() => usePanelStore.getState().pingTerminal(id));

describe("useInputReceiptKey", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    usePanelStore.setState({ pingedId: null, pingSeq: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it("does not increment on mount when a ping for one of its terminals is already live", () => {
    // Only changes after the subscription starts count as pings. This avoids
    // flashing every card that mounts mid-session with a stale (but still-live)
    // `pingedId`.
    usePanelStore.setState({ pingedId: "t-1", pingSeq: 5 });
    const { result } = renderHook(() => useInputReceiptKey(["t-1"]));
    expect(result.current).toBe(0);
  });

  it("increments when a ping targets one of the card's terminals", () => {
    const { result } = renderHook(() => useInputReceiptKey(["t-1", "t-2"]));
    expect(result.current).toBe(0);

    ping("t-2");
    expect(result.current).toBe(1);
  });

  it("does not increment when the ping belongs to another card", () => {
    const { result } = renderHook(() => useInputReceiptKey(["t-1"]));
    ping("other-terminal");
    expect(result.current).toBe(0);
  });

  it("does not increment on the 1.6s null clear", () => {
    const { result } = renderHook(() => useInputReceiptKey(["t-1"]));

    ping("t-1");
    expect(result.current).toBe(1);

    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(usePanelStore.getState().pingedId).toBeNull();
    expect(result.current).toBe(1);
  });

  it("ignores unrelated store updates while a ping for its terminal is still live", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useInputReceiptKey(["t-1"]);
    });

    ping("t-1");
    expect(result.current).toBe(1);
    const rendersAfterPing = renders;

    // `pingedId` still names this card's terminal, but no new ping happened.
    act(() => {
      usePanelStore.setState({ focusedId: "something-else" });
    });
    expect(result.current).toBe(1);
    expect(renders).toBe(rendersAfterPing);
  });

  it("re-keys on back-to-back pings of the SAME terminal", () => {
    // `pingedId` holds the same value across both taps; only `pingSeq` tells
    // them apart.
    const { result } = renderHook(() => useInputReceiptKey(["t-1"]));

    ping("t-1");
    expect(result.current).toBe(1);

    ping("t-1");
    expect(result.current).toBe(2);
  });

  it("does not re-fire when terminalIds change while the same ping is live", () => {
    const { result, rerender } = renderHook(({ ids }) => useInputReceiptKey(ids), {
      initialProps: { ids: ["t-1"] },
    });

    ping("t-1");
    expect(result.current).toBe(1);

    // Terminal added; the ping that already fired must not flash a second time.
    rerender({ ids: ["t-1", "t-2"] });
    expect(result.current).toBe(1);
  });

  it("does not increment when the card has no terminals", () => {
    const { result } = renderHook(() => useInputReceiptKey([]));
    ping("t-1");
    expect(result.current).toBe(0);
  });

  it("acknowledges only inputs at their moment: a terminal that joins mid-ping does not fire late", () => {
    const { result, rerender } = renderHook(({ ids }) => useInputReceiptKey(ids), {
      initialProps: { ids: [] as string[] },
    });
    ping("t-1");
    expect(result.current).toBe(0);

    rerender({ ids: ["t-1"] });
    expect(result.current).toBe(0);

    // A NEW ping on the now-known terminal does fire.
    ping("t-1");
    expect(result.current).toBe(1);
  });

  it("re-renders only the card that owns the pinged terminal", () => {
    let rendersA = 0;
    let rendersB = 0;
    renderHook(() => {
      rendersA++;
      return useInputReceiptKey(["a-1"]);
    });
    renderHook(() => {
      rendersB++;
      return useInputReceiptKey(["b-1"]);
    });
    const [baseA, baseB] = [rendersA, rendersB];

    ping("a-1");
    expect(rendersA).toBe(baseA + 1);
    expect(rendersB).toBe(baseB);

    // The clear 1.6s later touches neither card.
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(rendersA).toBe(baseA + 1);
    expect(rendersB).toBe(baseB);
  });

  it("drops its store subscription on unmount and when the terminal list changes", () => {
    const subscribe = usePanelStore.subscribe;
    const disposers: Array<ReturnType<typeof vi.fn>> = [];
    vi.spyOn(usePanelStore, "subscribe").mockImplementation(
      (...args: Parameters<typeof subscribe>) => {
        const dispose = vi.fn(subscribe(...args));
        disposers.push(dispose);
        return dispose;
      }
    );

    const { rerender, unmount } = renderHook(({ ids }) => useInputReceiptKey(ids), {
      initialProps: { ids: ["t-1"] },
    });
    expect(disposers).toHaveLength(1);

    rerender({ ids: ["t-1", "t-2"] });
    expect(disposers).toHaveLength(2);
    expect(disposers[0]).toHaveBeenCalledTimes(1);
    expect(disposers[1]).not.toHaveBeenCalled();

    unmount();
    expect(disposers[1]).toHaveBeenCalledTimes(1);
  });

  // Fed the way the card feeds it: output replaces a panel object, and ids
  // re-derived from the panels resubscribed on every write (#17051).
  it("keeps its subscription while the card's terminals stream output", () => {
    const panel = (id: string): PtyPanelData =>
      ({
        id,
        kind: "terminal",
        title: id,
        worktreeId: "wt-1",
        location: "grid",
        cwd: "/repo",
        cols: 80,
        rows: 24,
      }) as PtyPanelData;
    usePanelStore.setState({
      panelsById: { "t-1": panel("t-1"), "t-2": panel("t-2") },
      panelIdsByWorktreeId: { "wt-1": ["t-1", "t-2"] },
    });
    const subscribe = usePanelStore.subscribe;
    let subscriptions = 0;
    vi.spyOn(usePanelStore, "subscribe").mockImplementation(
      (...args: Parameters<typeof subscribe>) => {
        subscriptions += 1;
        return subscribe(...args);
      }
    );

    const { result } = renderHook(() =>
      useInputReceiptKey(useWorktreeTerminalSummary("wt-1").terminalIds)
    );
    const afterMount = subscriptions;

    for (let i = 0; i < 5; i++) {
      act(() => {
        usePanelStore.setState((state) => ({
          panelsById: {
            ...state.panelsById,
            "t-2": { ...panel("t-2"), activityHeadline: `line ${i}`, lastCommand: `make ${i}` },
          },
        }));
      });
    }
    expect(subscriptions).toBe(afterMount);

    ping("t-2");
    expect(result.current).toBe(1);
  });
});
