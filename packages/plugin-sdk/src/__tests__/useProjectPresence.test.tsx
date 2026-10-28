// @vitest-environment jsdom
import { StrictMode, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useProjectPresence } from "../react/useProjectPresence.js";
import type { PluginProjectPresence } from "../../../../shared/types/plugin.js";
import { PLUGIN_VIEW_RESYNC_EVENT } from "../../../../shared/utils/pluginProjectPresence.js";

const OWN = "a".repeat(64);
const OTHER = "b".repeat(64);

interface Deferred {
  resolve: (value: PluginProjectPresence | null) => void;
  reject: (error: unknown) => void;
}

function installBridge() {
  const reads: Deferred[] = [];
  const listeners = new Set<(presence: PluginProjectPresence) => void>();
  const bridge = {
    invoke: vi.fn(),
    on: vi.fn(),
    onPanel: vi.fn(),
    getProjectPresence: vi.fn(
      () =>
        new Promise<PluginProjectPresence | null>((resolve, reject) =>
          reads.push({ resolve, reject })
        )
    ),
    onProjectPresenceChanged: vi.fn((cb: (presence: PluginProjectPresence) => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }),
  };
  vi.stubGlobal("electron", { plugin: bridge });
  const push = (presence: PluginProjectPresence) =>
    act(() => {
      for (const cb of [...listeners]) cb(presence);
    });
  const answer = async (index: number, value: PluginProjectPresence | null) => {
    await act(async () => reads[index].resolve(value));
  };
  return { bridge, reads, listeners, push, answer };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useProjectPresence", () => {
  it("reads this view's project from main, then follows pushes for it alone", async () => {
    const { push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    expect(result.current).toBeNull();

    await answer(0, { projectId: OWN, state: "background" });
    expect(result.current).toBe("background");

    push({ projectId: OTHER, state: "foreground" });
    expect(result.current).toBe("background");
    push({ projectId: OWN, state: "foreground" });
    expect(result.current).toBe("foreground");
    unmount();
  });

  it("shares one bridge subscription between every consumer and drops it with the last", async () => {
    const { bridge, listeners, answer } = installBridge();
    const first = renderHook(() => useProjectPresence());
    const second = renderHook(() => useProjectPresence());
    await answer(0, { projectId: OWN, state: "foreground" });

    expect(bridge.onProjectPresenceChanged).toHaveBeenCalledTimes(1);
    expect(second.result.current).toBe("foreground");
    first.unmount();
    expect(listeners.size).toBe(1);
    second.unmount();
    expect(listeners.size).toBe(0);
  });

  it("does not let a read that a push overtook overwrite the push", async () => {
    const { reads, push, answer } = installBridge();
    const { unmount } = renderHook(() => useProjectPresence());
    await answer(0, { projectId: OWN, state: "foreground" });
    unmount();

    // Back again: the remembered project lets a push land before the re-read.
    const again = renderHook(() => useProjectPresence());
    expect(again.result.current).toBe("foreground");
    push({ projectId: OWN, state: "background" });
    await answer(1, { projectId: OWN, state: "foreground" });

    expect(again.result.current).toBe("background");
    expect(reads).toHaveLength(2);
    again.unmount();
  });

  it("lets a push that landed before main named the project win over the read it raced", async () => {
    const { reads, push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    push({ projectId: OTHER, state: "foreground" });
    push({ projectId: OWN, state: "background" });
    await answer(0, { projectId: OWN, state: "foreground" });

    expect(result.current).toBe("background");
    expect(reads).toHaveLength(1);
    unmount();
  });

  it("keeps the last answer when a read fails", async () => {
    const { reads, answer } = installBridge();
    const { unmount } = renderHook(() => useProjectPresence());
    await answer(0, { projectId: OWN, state: "background" });
    unmount();
    const again = renderHook(() => useProjectPresence());
    await act(async () => reads[1].reject(new Error("link down")));

    expect(again.result.current).toBe("background");
    again.unmount();
  });

  it("asks again on the next push after a failed first read", async () => {
    const { reads, push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    await act(async () => reads[0].reject(new Error("link down")));
    expect(reads).toHaveLength(1);
    // Pushed before the next read began, so that read's answer is the newer.
    push({ projectId: OWN, state: "background" });
    expect(reads).toHaveLength(2);
    await answer(1, { projectId: OWN, state: "foreground" });

    expect(result.current).toBe("foreground");
    unmount();
  });

  it("reads once more when a push raced a read that failed, and drops that push", async () => {
    const { reads, push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    push({ projectId: OWN, state: "foreground" });
    await act(async () => reads[0].reject(new Error("link down")));
    expect(reads).toHaveLength(2);
    // The project went to the background while the link was down.
    await answer(1, { projectId: OWN, state: "background" });

    expect(result.current).toBe("background");
    expect(reads).toHaveLength(2);
    unmount();
  });

  it("reads once more when a push raced a read that named no project", async () => {
    const { reads, push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    push({ projectId: OWN, state: "foreground" });
    await answer(0, null);
    expect(reads).toHaveLength(2);
    await answer(1, { projectId: OWN, state: "foreground" });

    expect(result.current).toBe("foreground");
    expect(reads).toHaveLength(2);
    unmount();
  });

  it("asks again after a null answer, for a view registered to its project late", async () => {
    const { reads, push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    await answer(0, null);
    expect(result.current).toBeNull();

    push({ projectId: OWN, state: "foreground" });
    expect(result.current).toBeNull();
    expect(reads).toHaveLength(2);
    await answer(1, { projectId: OWN, state: "foreground" });
    expect(result.current).toBe("foreground");

    push({ projectId: OWN, state: "background" });
    expect(result.current).toBe("background");
    unmount();
  });

  it("stays null in a view main says has no project", async () => {
    const { push, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    await answer(0, null);
    push({ projectId: OWN, state: "foreground" });
    await answer(1, null);

    expect(result.current).toBeNull();
    unmount();
  });

  it("reads again when the host resyncs a remote view", async () => {
    const { reads, answer } = installBridge();
    const { result, unmount } = renderHook(() => useProjectPresence());
    await answer(0, { projectId: OWN, state: "foreground" });

    act(() => {
      window.dispatchEvent(new Event(PLUGIN_VIEW_RESYNC_EVENT));
    });
    expect(reads).toHaveLength(2);
    await answer(1, { projectId: OWN, state: "background" });
    expect(result.current).toBe("background");

    unmount();
    window.dispatchEvent(new Event(PLUGIN_VIEW_RESYNC_EVENT));
    expect(reads).toHaveLength(2);
  });

  it("survives StrictMode's double subscribe", async () => {
    const { listeners, push, reads, answer } = installBridge();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result, unmount } = renderHook(() => useProjectPresence(), { wrapper });
    await answer(reads.length - 1, { projectId: OWN, state: "foreground" });
    expect(listeners.size).toBe(1);
    // The abandoned first subscription's read lands late and must change nothing.
    if (reads.length > 1) await answer(0, { projectId: OWN, state: "closed" });
    expect(result.current).toBe("foreground");

    push({ projectId: OWN, state: "background" });
    expect(result.current).toBe("background");
    unmount();
    expect(listeners.size).toBe(0);
  });

  it("answers null on a host without the presence bridge", () => {
    vi.stubGlobal("electron", { plugin: { invoke: vi.fn(), on: vi.fn(), onPanel: vi.fn() } });
    const { result, unmount } = renderHook(() => useProjectPresence());
    expect(result.current).toBeNull();
    unmount();
  });
});
