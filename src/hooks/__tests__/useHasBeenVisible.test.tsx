// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/store", () => {
  let state = { activeDockTerminalId: null as string | null };
  const store = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
    _setState: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
    },
  });
  return { usePanelStore: store };
});

import { usePanelStore } from "@/store";
import { useHasBeenVisible } from "../useHasBeenVisible";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockStore = usePanelStore as any;

describe("useHasBeenVisible", () => {
  beforeEach(() => {
    mockStore._setState({ activeDockTerminalId: null });
  });

  it("returns true immediately for grid panels", () => {
    const { result } = renderHook(() => useHasBeenVisible("panel-1", "grid"));
    expect(result.current).toBe(true);
  });

  it("returns true immediately when location is undefined (defaults to grid behavior)", () => {
    const { result } = renderHook(() => useHasBeenVisible("panel-1", ""));
    expect(result.current).toBe(true);
  });

  it("returns false for dock panels that are not the active dock terminal", () => {
    mockStore._setState({ activeDockTerminalId: "other-panel" });
    const { result } = renderHook(() => useHasBeenVisible("panel-1", "dock"));
    expect(result.current).toBe(false);
  });

  it("returns true for dock panels that are the active dock terminal", () => {
    mockStore._setState({ activeDockTerminalId: "panel-1" });
    const { result } = renderHook(() => useHasBeenVisible("panel-1", "dock"));
    expect(result.current).toBe(true);
  });

  it("latches to true when dock panel becomes active", () => {
    mockStore._setState({ activeDockTerminalId: "other-panel" });
    const { result, rerender } = renderHook(
      ({ panelId, loc }: { panelId: string; loc: string }) => useHasBeenVisible(panelId, loc),
      { initialProps: { panelId: "panel-1", loc: "dock" } }
    );

    expect(result.current).toBe(false);

    act(() => {
      mockStore._setState({ activeDockTerminalId: "panel-1" });
    });
    rerender({ panelId: "panel-1", loc: "dock" });

    expect(result.current).toBe(true);
  });

  it("stays true after active dock terminal changes away", () => {
    mockStore._setState({ activeDockTerminalId: "panel-1" });
    const { result, rerender } = renderHook(
      ({ panelId, loc }: { panelId: string; loc: string }) => useHasBeenVisible(panelId, loc),
      { initialProps: { panelId: "panel-1", loc: "dock" } }
    );

    expect(result.current).toBe(true);

    act(() => {
      mockStore._setState({ activeDockTerminalId: "other-panel" });
    });
    rerender({ panelId: "panel-1", loc: "dock" });

    expect(result.current).toBe(true);
  });

  it("returns true when panel moves from dock to grid", () => {
    mockStore._setState({ activeDockTerminalId: "other-panel" });
    const { result, rerender } = renderHook(
      ({ panelId, loc }: { panelId: string; loc: string }) => useHasBeenVisible(panelId, loc),
      { initialProps: { panelId: "panel-1", loc: "dock" } }
    );

    expect(result.current).toBe(false);

    rerender({ panelId: "panel-1", loc: "grid" });

    expect(result.current).toBe(true);
  });
});
