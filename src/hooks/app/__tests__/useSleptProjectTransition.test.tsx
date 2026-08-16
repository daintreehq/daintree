/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const dropToNoProject = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
  currentProject: null as { id: string } | null,
  dropToNoProject: vi.fn(),
}));
// Callable like the real zustand store, so a selector-style read added to the
// hook later fails loudly here instead of silently reading undefined.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
    { getState: () => projectState, subscribe: () => () => {} }
  ),
}));
vi.mock("@/utils/logger", () => ({ logDebug: vi.fn() }));

import { useSleptProjectTransition } from "../useSleptProjectTransition";

let listener: ((projectId: string) => void) | null = null;
const unsubscribe = vi.fn();
const originalElectron = Object.getOwnPropertyDescriptor(window, "electron");

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  projectState.currentProject = null;
  projectState.dropToNoProject = dropToNoProject;
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      project: {
        onSlept: (cb: (projectId: string) => void) => {
          listener = cb;
          return unsubscribe;
        },
      },
    },
  });
});

afterEach(() => {
  if (originalElectron) {
    Object.defineProperty(window, "electron", originalElectron);
  } else {
    delete (window as Partial<Window>).electron;
  }
});

function emitSlept(projectId: string) {
  if (!listener) throw new Error("hook never subscribed");
  listener(projectId);
}

describe("useSleptProjectTransition", () => {
  it("drops to the no-project state when the project on screen is slept elsewhere", () => {
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-1");

    expect(dropToNoProject).toHaveBeenCalledTimes(1);
  });

  it("ignores a project this window isn't showing", () => {
    // A second window sleeping its own project must not blank this one.
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-2");

    expect(dropToNoProject).not.toHaveBeenCalled();
  });

  it("does nothing when no project is on screen", () => {
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-1");

    expect(dropToNoProject).not.toHaveBeenCalled();
  });

  it("reads the project at delivery, not at subscribe", () => {
    // The effect subscribes once; this window's project changes underneath it,
    // and a closed-over value would make the hook act on a stale project.
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    projectState.currentProject = { id: "proj-2" };
    emitSlept("proj-1");
    expect(dropToNoProject).not.toHaveBeenCalled();

    emitSlept("proj-2");
    expect(dropToNoProject).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSleptProjectTransition());

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
