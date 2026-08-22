/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";

const dropToNoProject = vi.hoisted(() => vi.fn());
const isSelfInitiatedSleepMock = vi.hoisted(() => vi.fn<(projectId: string) => boolean>());
const notifyMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
  currentProject: null as { id: string; name: string } | null,
  dropToNoProject: vi.fn(),
}));
// Callable like the real zustand store, so a selector-style read added to the
// hook later fails loudly here instead of silently reading undefined.
vi.mock("@/store/projectStore", () => ({
  useProjectStore: Object.assign(
    vi.fn((selector: (state: typeof projectState) => unknown) => selector(projectState)),
    { getState: () => projectState, subscribe: () => () => {} }
  ),
  isSelfInitiatedSleep: isSelfInitiatedSleepMock,
}));
vi.mock("@/lib/notify", () => ({ notify: notifyMock }));
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
  isSelfInitiatedSleepMock.mockReturnValue(false);
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
    projectState.currentProject = { id: "proj-1", name: "One" };
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-1");

    expect(dropToNoProject).toHaveBeenCalledTimes(1);
  });

  it("ignores a project this window isn't showing", () => {
    // A second window sleeping its own project must not blank this one.
    projectState.currentProject = { id: "proj-1", name: "One" };
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
    projectState.currentProject = { id: "proj-1", name: "One" };
    renderHook(() => useSleptProjectTransition());

    projectState.currentProject = { id: "proj-2", name: "Two" };
    emitSlept("proj-1");
    expect(dropToNoProject).not.toHaveBeenCalled();

    emitSlept("proj-2");
    expect(dropToNoProject).toHaveBeenCalledTimes(1);
  });

  it("tells the user why their window emptied", () => {
    // The window going blank is visible; the reason is not, and nothing else in
    // this window can supply it.
    projectState.currentProject = { id: "proj-1", name: "One" };
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-1");

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const payload = notifyMock.mock.calls[0]![0] as { message: string };
    expect(payload.message).toContain("One");
  });

  it("stays silent and hands off when this window asked for the sleep", () => {
    // The initiating window runs the ordered teardown in the store (flush →
    // IPC → cancel); the listener's bare drop would race it, and telling the
    // user what they just did is noise.
    projectState.currentProject = { id: "proj-1", name: "One" };
    isSelfInitiatedSleepMock.mockReturnValue(true);
    renderHook(() => useSleptProjectTransition());

    emitSlept("proj-1");

    expect(dropToNoProject).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSleptProjectTransition());

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
