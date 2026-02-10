import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessDetector } from "../ProcessDetector.js";

type ProcessNode = { pid: number; comm: string; command?: string };

function createCacheMock() {
  const listeners = new Set<() => void>();
  const children = new Map<number, ProcessNode[]>();

  return {
    getChildren: vi.fn((pid: number) => children.get(pid) ?? []),
    onRefresh: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    setChildren(pid: number, nodes: ProcessNode[]) {
      children.set(pid, nodes);
    },
    emitRefresh() {
      for (const callback of listeners) {
        callback();
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
}

describe("ProcessDetector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects codex from Windows-style process paths", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "C:\\Program Files\\Codex\\codex.exe",
        command: "codex --model o3",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector("terminal-1", Date.now(), 100, callback, cache as never);
    detector.start();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        agentType: "codex",
        processName: "codex",
        isBusy: true,
        currentCommand: "codex --model o3",
      }),
      expect.any(Number)
    );
  });

  it("avoids duplicate callbacks when state has not changed on refresh", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "claude",
        command: "claude --resume",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector("terminal-2", Date.now(), 100, callback, cache as never);
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from cache refresh events on stop", () => {
    const cache = createCacheMock();
    const callback = vi.fn();

    const detector = new ProcessDetector("terminal-3", Date.now(), 100, callback, cache as never);
    detector.start();
    expect(cache.listenerCount()).toBe(1);

    detector.stop();
    expect(cache.listenerCount()).toBe(0);
  });
});
