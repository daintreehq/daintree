// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { switchProjectMock, reopenProjectMock, notifyMock, projectState, useProjectStoreMock } =
  vi.hoisted(() => {
    const switchProjectMock = vi.fn().mockResolvedValue(undefined);
    const reopenProjectMock = vi.fn().mockResolvedValue(undefined);
    const notifyMock = vi.fn().mockReturnValue("");

    const projectState = {
      projects: [
        { id: "p-current", path: "/p-current", name: "Current", emoji: "🌲", lastOpened: 500 },
        { id: "p-recent", path: "/p-recent", name: "Recent", emoji: "🍎", lastOpened: 400 },
        { id: "p-older", path: "/p-older", name: "Older", emoji: "🥕", lastOpened: 300 },
        { id: "p-oldest", path: "/p-oldest", name: "Oldest", emoji: "🌵", lastOpened: 200 },
      ] as Array<{
        id: string;
        path: string;
        name: string;
        emoji: string;
        lastOpened: number;
        status?: "active" | "background" | "closed" | "missing";
      }>,
      currentProject: { id: "p-current" } as { id: string } | null,
      switchProject: switchProjectMock,
      reopenProject: reopenProjectMock,
    };

    const useProjectStoreMock = Object.assign(
      vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
      { getState: () => projectState }
    );

    return {
      switchProjectMock,
      reopenProjectMock,
      notifyMock,
      projectState,
      useProjectStoreMock,
    };
  });

vi.mock("@/store/projectStore", () => ({
  useProjectStore: useProjectStoreMock,
}));

vi.mock("@/lib/notify", () => ({
  notify: notifyMock,
}));

import { _resetForTests as resetEscapeStack, dispatchEscape } from "@/lib/escapeStack";
import { useProjectMruSwitcher } from "../useProjectMruSwitcher";

function keyDown(
  code: "Minus" | "Equal",
  opts: { repeat?: boolean; isComposing?: boolean; target?: Element | null } = {}
) {
  const key = code === "Minus" ? "–" : "≠";
  const event = new KeyboardEvent("keydown", {
    key,
    code,
    metaKey: true,
    altKey: true,
    repeat: opts.repeat ?? false,
    isComposing: opts.isComposing ?? false,
    bubbles: true,
    cancelable: true,
  });
  if (opts.target) {
    Object.defineProperty(event, "target", { value: opts.target, writable: false });
  }
  window.dispatchEvent(event);
  return event;
}

function keyUp(key: "Meta" | "Alt") {
  const event = new KeyboardEvent("keyup", {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("useProjectMruSwitcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetEscapeStack();
    projectState.currentProject = { id: "p-current" };
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "🌲", lastOpened: 500 },
      { id: "p-recent", path: "/p-recent", name: "Recent", emoji: "🍎", lastOpened: 400 },
      { id: "p-older", path: "/p-older", name: "Older", emoji: "🥕", lastOpened: 300 },
      { id: "p-oldest", path: "/p-oldest", name: "Oldest", emoji: "🌵", lastOpened: 200 },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("tap Cmd+Alt+- switches to most recent other project without showing overlay", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    expect(reopenProjectMock).not.toHaveBeenCalled();
    expect(result.current.isVisible).toBe(false);
  });

  it("tap Cmd+Alt+= also switches to the same most recent other project", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Equal");
    });
    act(() => {
      keyUp("Alt");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
  });

  it("single-project state is a no-op", () => {
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "🌲", lastOpened: 500 },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(reopenProjectMock).not.toHaveBeenCalled();
  });

  it("IME composition keydown is ignored", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus", { isComposing: true });
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("Sticky Keys: modifier release without any trigger keydown does not commit", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("holding past threshold shows overlay with selectedIndex 1", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    act(() => {
      vi.advanceTimersByTime(130);
    });

    expect(result.current.isVisible).toBe(true);
    expect(result.current.selectedIndex).toBe(1);
    expect(result.current.projects.map((p) => p.id)).toEqual([
      "p-current",
      "p-recent",
      "p-older",
      "p-oldest",
    ]);
  });

  it("hold + Minus advances older through MRU", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    act(() => {
      keyDown("Minus", { repeat: true });
    });

    expect(result.current.selectedIndex).toBe(2);
  });

  it("hold + Equal from index 1 wraps to last index", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    act(() => {
      keyDown("Equal", { repeat: true });
    });

    expect(result.current.selectedIndex).toBe(3);
  });

  it("hold + Minus at last wraps back to 1", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    act(() => {
      keyDown("Minus", { repeat: true });
      keyDown("Minus", { repeat: true });
      keyDown("Minus", { repeat: true });
    });

    expect(result.current.selectedIndex).toBe(1);
  });

  it("releasing modifier during hold commits highlighted project", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    act(() => {
      keyDown("Minus", { repeat: true });
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-older");
  });

  it("Escape during hold cancels without committing", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    expect(result.current.isVisible).toBe(true);

    act(() => {
      dispatchEscape();
    });

    expect(result.current.isVisible).toBe(false);
    act(() => {
      keyUp("Meta");
    });
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("window blur during hold cancels without committing", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(result.current.isVisible).toBe(false);
    act(() => {
      keyUp("Meta");
    });
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("document hidden during hold cancels", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(result.current.isVisible).toBe(false);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
  });

  it("e.repeat advances without restarting the hold timer", () => {
    const { result } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    // Before threshold, repeat events advance the index but do NOT restart timer
    act(() => {
      vi.advanceTimersByTime(80);
      keyDown("Minus", { repeat: true });
      vi.advanceTimersByTime(60);
    });

    // 80 + 60 = 140 > 120 threshold, so overlay should be visible
    expect(result.current.isVisible).toBe(true);
    expect(result.current.selectedIndex).toBe(2);
  });

  it("commits background project via reopenProject", () => {
    projectState.projects = [
      { id: "p-current", path: "/p-current", name: "Current", emoji: "🌲", lastOpened: 500 },
      {
        id: "p-bg",
        path: "/p-bg",
        name: "BG",
        emoji: "🍃",
        lastOpened: 400,
        status: "background",
      },
    ];
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    act(() => {
      keyUp("Meta");
    });

    expect(reopenProjectMock).toHaveBeenCalledWith("p-bg");
    expect(switchProjectMock).not.toHaveBeenCalled();
  });

  it("no-op when target is an editable input", () => {
    renderHook(() => useProjectMruSwitcher());

    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => {
      keyDown("Minus", { target: input });
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
    input.remove();
  });

  it("still fires inside an .xterm container (terminal panel must work)", () => {
    renderHook(() => useProjectMruSwitcher());

    const term = document.createElement("div");
    term.className = "xterm";
    document.body.appendChild(term);
    act(() => {
      keyDown("Minus", { target: term });
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    term.remove();
  });

  it("switchProject rejection surfaces via notify", async () => {
    const err = new Error("boom");
    switchProjectMock.mockRejectedValueOnce(err);

    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    act(() => {
      keyUp("Meta");
    });

    await vi.waitFor(() => {
      expect(notifyMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", message: "boom" })
      );
    });
  });

  it("unmount mid-hold clears timer and does not commit", () => {
    const { result, unmount } = renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
    });
    unmount();

    act(() => {
      vi.advanceTimersByTime(200);
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
    expect(result.current.isVisible).toBe(false);
  });

  it("calls preventDefault and stopPropagation on handled keydowns", () => {
    renderHook(() => useProjectMruSwitcher());

    const event = new KeyboardEvent("keydown", {
      key: "–",
      code: "Minus",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const pd = vi.spyOn(event, "preventDefault");
    const sp = vi.spyOn(event, "stopPropagation");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(pd).toHaveBeenCalled();
    expect(sp).toHaveBeenCalled();
  });

  it("fires inside xterm helper textarea (common terminal focus state)", () => {
    renderHook(() => useProjectMruSwitcher());

    const term = document.createElement("div");
    term.className = "xterm";
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    term.appendChild(helper);
    document.body.appendChild(term);

    act(() => {
      keyDown("Minus", { target: helper });
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).toHaveBeenCalledWith("p-recent");
    term.remove();
  });

  it("calls stopImmediatePropagation to block sibling capture listeners", () => {
    renderHook(() => useProjectMruSwitcher());

    const event = new KeyboardEvent("keydown", {
      key: "–",
      code: "Minus",
      metaKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    const sip = vi.spyOn(event, "stopImmediatePropagation");

    act(() => {
      window.dispatchEvent(event);
    });

    expect(sip).toHaveBeenCalled();
  });

  it("revalidates target against live store at commit time", () => {
    renderHook(() => useProjectMruSwitcher());

    act(() => {
      keyDown("Minus");
      vi.advanceTimersByTime(130);
    });
    // Mutate the store: remove the selected target (p-recent at index 1)
    projectState.projects = projectState.projects.filter((p) => p.id !== "p-recent");

    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalledWith("p-recent");
  });

  it("ignores keydowns when modifiers are absent", () => {
    renderHook(() => useProjectMruSwitcher());

    const event = new KeyboardEvent("keydown", {
      key: "-",
      code: "Minus",
      metaKey: false,
      altKey: false,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    act(() => {
      keyUp("Meta");
    });

    expect(switchProjectMock).not.toHaveBeenCalled();
  });
});
