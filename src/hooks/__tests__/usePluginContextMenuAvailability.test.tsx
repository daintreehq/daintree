// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTEXT_MENU_AVAILABILITY_CHANNEL,
  CONTEXT_MENU_AVAILABILITY_REASON_MAX,
  CONTEXT_MENU_AVAILABILITY_TIMEOUT_MS,
  type ContextMenuAvailabilityRequest,
} from "@shared/types/plugin";

const announceMock = vi.fn();
vi.mock("@/store/accessibilityAnnouncerStore", () => ({
  useAnnouncerStore: { getState: () => ({ announce: announceMock }) },
}));
vi.mock("@/utils/logger", () => ({ logWarn: vi.fn() }));

import {
  contextMenuAvailabilityRequest,
  readContextMenuAvailabilityAnswer,
  usePluginContextMenuAvailability,
} from "../usePluginContextMenuAvailability";

interface Deferred {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

let pending: Deferred[];
const invokeMock = vi.fn();

/** The `index`th invoke the hook made, failing loudly when it never made it. */
function invocation(index: number): Deferred {
  const deferred = pending[index];
  if (!deferred) throw new Error(`invoke #${index} was never made`);
  return deferred;
}

function paneRequest(panelId: string): ContextMenuAvailabilityRequest {
  return { availability: "continue", location: "terminal", panelId, panelKind: "terminal" };
}

function usePane(panelId: string) {
  return usePluginContextMenuAvailability("acme", "Continue", paneRequest(panelId));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

beforeEach(() => {
  pending = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      })
  );
  announceMock.mockReset();
  (window as unknown as { electron: unknown }).electron = { plugin: { invoke: invokeMock } };
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { electron?: unknown }).electron;
});

describe("contextMenuAvailabilityRequest", () => {
  it("withholds a browser page's URL", () => {
    expect(
      contextMenuAvailabilityRequest("continue", "browser", {
        panelId: "p1",
        panelKind: "browser",
        url: "https://example.com/private",
      })
    ).toEqual({
      availability: "continue",
      location: "browser",
      panelId: "p1",
      panelKind: "browser",
    });
  });

  it("names a file by its relative path, never its absolute path or root", () => {
    expect(
      contextMenuAvailabilityRequest("open", "file", {
        path: "/Users/me/repo/src/a.ts",
        worktreePath: "/Users/me/repo",
        relativePath: "src/a.ts",
        isDirectory: false,
        status: "modified",
      })
    ).toEqual({
      availability: "open",
      location: "file",
      relativePath: "src/a.ts",
      isDirectory: false,
    });
    expect(
      contextMenuAvailabilityRequest("open", "file", { path: "/tmp/notes", isDirectory: true })
    ).toEqual({ availability: "open", location: "file", isDirectory: true });
  });

  it("carries the project and worktree ids of their surfaces", () => {
    expect(contextMenuAvailabilityRequest("x", "project", { projectId: "proj-1" })).toEqual({
      availability: "x",
      location: "project",
      projectId: "proj-1",
    });
    expect(contextMenuAvailabilityRequest("x", "worktree", { worktreeId: "wt-1" })).toEqual({
      availability: "x",
      location: "worktree",
      worktreeId: "wt-1",
    });
  });

  it("drops subject fields of the wrong type or empty", () => {
    expect(
      contextMenuAvailabilityRequest("x", "terminal", {
        panelId: "",
        panelKind: 3,
        worktreeId: { id: "wt" },
        isDirectory: "yes",
      })
    ).toEqual({ availability: "x", location: "terminal" });
  });

  it("names no subject when the surface dispatches none", () => {
    expect(contextMenuAvailabilityRequest("x", "worktree", undefined)).toEqual({
      availability: "x",
      location: "worktree",
    });
  });
});

describe("readContextMenuAvailabilityAnswer", () => {
  it("reads null as available and trims a reason", () => {
    expect(readContextMenuAvailabilityAnswer(null)).toBeNull();
    expect(readContextMenuAvailabilityAnswer("  Session file unknown ")).toBe(
      "Session file unknown"
    );
  });

  it.each([
    undefined,
    "",
    "   ",
    "two\nlines",
    "carriage\rreturn",
    `line${LINE_SEPARATOR}separator`,
    `paragraph${PARAGRAPH_SEPARATOR}separator`,
    "x".repeat(CONTEXT_MENU_AVAILABILITY_REASON_MAX + 1),
    false,
    { reason: "no" },
  ])("treats %j as malformed", (value) => {
    expect(readContextMenuAvailabilityAnswer(value)).toBeUndefined();
  });

  it("accepts a reason at the limit", () => {
    const reason = "x".repeat(CONTEXT_MENU_AVAILABILITY_REASON_MAX);
    expect(readContextMenuAvailabilityAnswer(reason)).toBe(reason);
  });
});

describe("usePluginContextMenuAvailability", () => {
  it("asks the plugin's availability channel and shows its reason", async () => {
    const { result } = renderHook(() => usePane("p1"));
    expect(result.current).toEqual({ status: "checking" });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith(
      "acme",
      CONTEXT_MENU_AVAILABILITY_CHANNEL,
      paneRequest("p1")
    );

    invocation(0).resolve("Session file unknown");
    await flush();
    expect(result.current).toEqual({ status: "unavailable", reason: "Session file unknown" });
    expect(announceMock).toHaveBeenCalledTimes(1);
    expect(announceMock).toHaveBeenCalledWith(
      "Continue unavailable, Session file unknown",
      "polite"
    );
  });

  it("is available when the plugin answers null, without announcing", async () => {
    const { result } = renderHook(() => usePane("p1"));
    await flush();
    invocation(0).resolve(null);
    await flush();
    expect(result.current).toEqual({ status: "available" });
    expect(announceMock).not.toHaveBeenCalled();
  });

  it.each([
    ["a rejected invoke", (d: Deferred) => d.reject(new Error("No handler registered"))],
    ["a malformed answer", (d: Deferred) => d.resolve({ unavailable: true })],
  ])("offers the item after %s", async (_name, settle) => {
    const { result } = renderHook(() => usePane("p1"));
    await flush();
    settle(invocation(0));
    await flush();
    expect(result.current).toEqual({ status: "available" });
  });

  it("offers the item when the bridge throws instead of rejecting", async () => {
    invokeMock.mockImplementation(() => {
      throw new Error("bridge gone");
    });
    const { result } = renderHook(() => usePane("p1"));
    await flush();
    expect(result.current).toEqual({ status: "available" });
  });

  it("offers the item when no answer comes within the timeout, and ignores a late one", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePane("p1"));
    await flush();
    act(() => {
      vi.advanceTimersByTime(CONTEXT_MENU_AVAILABILITY_TIMEOUT_MS - 1);
    });
    expect(result.current).toEqual({ status: "checking" });
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toEqual({ status: "available" });

    invocation(0).resolve("Too late");
    await flush();
    expect(result.current).toEqual({ status: "available" });
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("never lets an answer for the previous subject land on the next one", async () => {
    const { result, rerender } = renderHook(
      ({ panelId }: { panelId: string }) => usePane(panelId),
      {
        initialProps: { panelId: "a" },
      }
    );
    await flush();
    rerender({ panelId: "b" });
    expect(result.current).toEqual({ status: "checking" });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(2);

    invocation(1).resolve("This agent isn't supported");
    await flush();
    invocation(0).resolve(null);
    await flush();
    expect(result.current).toEqual({
      status: "unavailable",
      reason: "This agent isn't supported",
    });
    expect(announceMock).toHaveBeenCalledTimes(1);
  });

  it("asks again on returning to a subject, rather than reviving its old answer", async () => {
    const { result, rerender } = renderHook(
      ({ panelId }: { panelId: string }) => usePane(panelId),
      {
        initialProps: { panelId: "a" },
      }
    );
    await flush();
    invocation(0).resolve("Session file unknown");
    await flush();
    expect(result.current).toEqual({ status: "unavailable", reason: "Session file unknown" });

    rerender({ panelId: "b" });
    rerender({ panelId: "a" });
    expect(result.current).toEqual({ status: "checking" });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(invokeMock).toHaveBeenLastCalledWith(
      "acme",
      CONTEXT_MENU_AVAILABILITY_CHANNEL,
      paneRequest("a")
    );
  });

  it("keeps its answer across a rerender with an equal subject", async () => {
    const { result, rerender } = renderHook(() => usePane("p1"));
    await flush();
    invocation(0).resolve("Session file unknown");
    await flush();
    rerender();
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current).toEqual({ status: "unavailable", reason: "Session file unknown" });
  });

  it("asks once under StrictMode's replayed effects", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    renderHook(() => usePane("p1"), { wrapper });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });

  it("never asks, or announces, once the menu closed", async () => {
    const { unmount } = renderHook(() => usePane("p1"));
    unmount();
    await flush();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(announceMock).not.toHaveBeenCalled();
  });

  it("drops an answer that arrives after the menu closed", async () => {
    const { unmount } = renderHook(() => usePane("p1"));
    await flush();
    unmount();
    invocation(0).resolve("Session file unknown");
    await flush();
    expect(announceMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no plugin bridge", undefined],
    ["a plugin bridge without invoke", { plugin: {} }],
  ])("offers the item and asks nothing with %s", async (_name, electron) => {
    (window as unknown as { electron?: unknown }).electron = electron;
    const { result } = renderHook(() => usePane("p1"));
    await flush();
    expect(result.current).toEqual({ status: "available" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
