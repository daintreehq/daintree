/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const dropToNoProject = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({
  currentProject: null as { id: string } | null,
  dropToNoProject: vi.fn(),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectState },
}));
vi.mock("@/utils/logger", () => ({ logDebug: vi.fn() }));

import { useSleptProjectTransition } from "../useSleptProjectTransition";

type ProjectUpdate = { id: string; status: string };

let listener: ((project: ProjectUpdate) => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  projectState.currentProject = null;
  projectState.dropToNoProject = dropToNoProject;
  (globalThis as unknown as { window: Window }).window ??= globalThis as unknown as Window;
  Object.defineProperty(window, "electron", {
    configurable: true,
    value: {
      project: {
        onUpdated: (cb: (project: ProjectUpdate) => void) => {
          listener = cb;
          return unsubscribe;
        },
      },
    },
  });
});

function emit(project: ProjectUpdate) {
  if (!listener) throw new Error("hook never subscribed");
  listener(project);
}

describe("useSleptProjectTransition", () => {
  it("drops to the no-project state when the project on screen is slept elsewhere", () => {
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    emit({ id: "proj-1", status: "closed" });

    expect(dropToNoProject).toHaveBeenCalledTimes(1);
  });

  it("ignores a project this window isn't showing", () => {
    // A second window sleeping its own project must not blank this one.
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    emit({ id: "proj-2", status: "closed" });

    expect(dropToNoProject).not.toHaveBeenCalled();
  });

  it("ignores updates that aren't a shutdown", () => {
    // Renames, colour changes and status bumps all ride the same broadcast.
    projectState.currentProject = { id: "proj-1" };
    renderHook(() => useSleptProjectTransition());

    emit({ id: "proj-1", status: "active" });
    emit({ id: "proj-1", status: "background" });

    expect(dropToNoProject).not.toHaveBeenCalled();
  });

  it("does nothing when no project is on screen", () => {
    renderHook(() => useSleptProjectTransition());

    emit({ id: "proj-1", status: "closed" });

    expect(dropToNoProject).not.toHaveBeenCalled();
  });

  it("unsubscribes on unmount", () => {
    const { unmount } = renderHook(() => useSleptProjectTransition());

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
