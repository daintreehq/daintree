// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  _resetPaneDropRoutingForTests,
  clearPaneDragOver,
  notePaneDragOver,
  registerPaneDropTarget,
  resolvePaneDropTarget,
  routePaneDrop,
  usePaneDropHighlight,
  type PaneDropTarget,
} from "../paneDropRouting";

function target(overrides: Partial<PaneDropTarget> = {}): PaneDropTarget {
  return { ownsFocus: () => false, canTake: () => true, take: () => true, ...overrides };
}

afterEach(() => {
  act(() => _resetPaneDropRoutingForTests());
});

describe("resolvePaneDropTarget", () => {
  it.each([
    ["xterm", "hybridInput"],
    ["hybridInput", "xterm"],
  ] as const)(
    "gives a drop let go over %s to %s while it holds the keyboard",
    (droppedOn, holder) => {
      registerPaneDropTarget("t", droppedOn, target());
      registerPaneDropTarget("t", holder, target({ ownsFocus: () => true }));

      expect(resolvePaneDropTarget("t", droppedOn, droppedOn)).toBe(holder);
    }
  );

  it("keeps a drop on the surface it was let go over while that one holds the keyboard", () => {
    registerPaneDropTarget("t", "xterm", target({ ownsFocus: () => true }));
    registerPaneDropTarget("t", "hybridInput", target());

    expect(resolvePaneDropTarget("t", "xterm", "hybridInput")).toBe("xterm");
  });

  it("leaves the drop where it was let go when the surface holding the keyboard can't take it", () => {
    registerPaneDropTarget("t", "xterm", target());
    registerPaneDropTarget(
      "t",
      "hybridInput",
      target({ ownsFocus: () => true, canTake: () => false })
    );

    expect(resolvePaneDropTarget("t", "xterm", "hybridInput")).toBe("xterm");
  });

  it("goes where a click would put the keyboard while nothing in the pane holds it", () => {
    registerPaneDropTarget("t", "xterm", target());
    registerPaneDropTarget("t", "hybridInput", target());

    expect(resolvePaneDropTarget("t", "xterm", "hybridInput")).toBe("hybridInput");
    expect(resolvePaneDropTarget("t", "xterm", "xterm")).toBe("xterm");
    expect(resolvePaneDropTarget("t", "hybridInput")).toBe("hybridInput");
  });

  it("never sends a drop to a click target that is missing or can't take it", () => {
    registerPaneDropTarget("t", "xterm", target());
    expect(resolvePaneDropTarget("t", "xterm", "hybridInput")).toBe("xterm");

    registerPaneDropTarget("t", "hybridInput", target({ canTake: () => false }));
    expect(resolvePaneDropTarget("t", "xterm", "hybridInput")).toBe("xterm");
  });

  it("passes a drop the surface it was let go over can't take to the other one", () => {
    registerPaneDropTarget("t", "xterm", target({ ownsFocus: () => true, canTake: () => false }));
    registerPaneDropTarget("t", "hybridInput", target());

    expect(resolvePaneDropTarget("t", "xterm", "xterm")).toBe("hybridInput");
  });

  it("keeps a drop neither surface can take on the one it was let go over", () => {
    registerPaneDropTarget("t", "xterm", target({ canTake: () => false }));
    registerPaneDropTarget(
      "t",
      "hybridInput",
      target({ ownsFocus: () => true, canTake: () => false })
    );

    expect(resolvePaneDropTarget("t", "hybridInput", "hybridInput")).toBe("hybridInput");
    expect(resolvePaneDropTarget("t", "xterm", "xterm")).toBe("xterm");
  });

  it("keeps panes apart", () => {
    registerPaneDropTarget("other", "hybridInput", target({ ownsFocus: () => true }));
    registerPaneDropTarget("t", "xterm", target());

    expect(resolvePaneDropTarget("t", "xterm", "xterm")).toBe("xterm");
  });
});

describe("routePaneDrop", () => {
  const SOURCES = [{ kind: "local", path: "/Users/me/a.md", name: "a.md", size: 0 }] as const;

  it("hands the drop to the surface's latest registration, which its predecessor can't remove", () => {
    const first = vi.fn(() => true);
    const second = vi.fn(() => true);
    const unregisterFirst = registerPaneDropTarget("t", "hybridInput", target({ take: first }));
    registerPaneDropTarget("t", "hybridInput", target({ take: second }));
    unregisterFirst();

    expect(routePaneDrop("t", "hybridInput", SOURCES)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(SOURCES);
  });

  it("reports a missing or declining surface", () => {
    expect(routePaneDrop("t", "xterm", SOURCES)).toBe(false);
    registerPaneDropTarget("t", "xterm", target({ take: () => false }));
    expect(routePaneDrop("t", "xterm", SOURCES)).toBe(false);
  });
});

describe("usePaneDropHighlight", () => {
  it("lights only the surface the drop would land on, and nothing for a refused one", () => {
    const zone = {};
    const terminal = renderHook(() => usePaneDropHighlight("t", "xterm"));
    const bar = renderHook(() => usePaneDropHighlight("t", "hybridInput"));

    act(() => notePaneDragOver("t", zone, "hybridInput"));
    expect(terminal.result.current).toBe(false);
    expect(bar.result.current).toBe(true);

    act(() => notePaneDragOver("t", zone, null));
    expect(terminal.result.current).toBe(false);
    expect(bar.result.current).toBe(false);

    act(() => notePaneDragOver("t", zone, "xterm"));
    expect(terminal.result.current).toBe(true);
    act(() => clearPaneDragOver("t", zone));
    expect(terminal.result.current).toBe(false);
  });

  it("ignores the late dragleave of the zone the pointer just left", () => {
    const terminalZone = {};
    const barZone = {};
    const bar = renderHook(() => usePaneDropHighlight("t", "hybridInput"));

    act(() => notePaneDragOver("t", terminalZone, "hybridInput"));
    act(() => notePaneDragOver("t", barZone, "hybridInput"));
    act(() => clearPaneDragOver("t", terminalZone));

    expect(bar.result.current).toBe(true);
  });
});
