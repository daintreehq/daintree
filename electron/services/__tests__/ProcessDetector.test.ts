import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.restoreAllMocks();
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
    cache.emitRefresh();

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

  it.each([
    { processName: "npm", expectedIcon: "npm" },
    { processName: "npx", expectedIcon: "npm" },
    { processName: "python3", expectedIcon: "python" },
    { processName: "composer", expectedIcon: "composer" },
  ])("maps $processName to $expectedIcon process icon", ({ processName, expectedIcon }) => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: processName, command: `${processName} run` }]);
    const callback = vi.fn();

    const detector = new ProcessDetector("terminal-map", Date.now(), 100, callback, cache as never);
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        processIconId: expectedIcon,
        processName,
        isBusy: true,
      }),
      expect.any(Number)
    );
  });

  it("prioritizes AI agents over package managers regardless of process order", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "npm", command: "npm install" },
      { pid: 201, comm: "claude", command: "claude --resume" },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-priority-1",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        agentType: "claude",
        processIconId: "claude",
        processName: "claude",
      }),
      expect.any(Number)
    );
  });

  it("prioritizes package managers over other tool icons", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "docker", command: "docker build ." },
      { pid: 201, comm: "pnpm", command: "pnpm install" },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-priority-2",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        processIconId: "pnpm",
        processName: "pnpm",
      }),
      expect.any(Number)
    );
  });

  it("reports busy state with current command for unrecognized processes", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "bash", command: "bash -lc long-script.sh" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-unknown",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: false,
        isBusy: true,
        currentCommand: "bash -lc long-script.sh",
      }),
      expect.any(Number)
    );
  });

  it("emits a state change when a previously detected process exits", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-exit",
      Date.now(),
      100,
      callback,
      cache as never
    );
    // Two polls to commit the ON state (hysteresis threshold).
    detector.start();
    cache.emitRefresh();

    // Two polls with no children to commit the OFF state (hysteresis threshold).
    cache.setChildren(100, []);
    cache.emitRefresh();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(
      expect.objectContaining({
        detected: false,
        isBusy: false,
        currentCommand: undefined,
      }),
      expect.any(Number)
    );
  });

  it("detects Windows grandchild processes and applies priority against direct children", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "npm", command: "npm install" },
      { pid: 201, comm: "cmd.exe", command: "cmd /c" },
    ]);
    cache.setChildren(201, [{ pid: 300, comm: "codex.exe", command: "codex --model o3" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector("terminal-win", Date.now(), 100, callback, cache as never);
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        agentType: "codex",
        processIconId: "codex",
        processName: "codex",
        currentCommand: "codex --model o3",
      }),
      expect.any(Number)
    );
  });

  describe("hysteresis", () => {
    it("does not emit detection after a single agent poll", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-1",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      expect(callback).not.toHaveBeenCalled();
    });

    it("commits detection after two consecutive matching polls and emits once", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-2",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          agentType: "claude",
          processIconId: "claude",
        }),
        expect.any(Number)
      );
    });

    it("does not emit off after a single absent poll; commits after two", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-3",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      cache.setChildren(100, []);
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detected: false,
          isBusy: false,
          currentCommand: undefined,
        }),
        expect.any(Number)
      );
    });

    it("does not commit detection when polls alternate between present and absent", () => {
      const cache = createCacheMock();
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-4",
        Date.now(),
        100,
        callback,
        cache as never
      );

      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      detector.start();

      cache.setChildren(100, []);
      cache.emitRefresh();

      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      cache.emitRefresh();

      cache.setChildren(100, []);
      cache.emitRefresh();

      // Alternation may update busy/command, but the gated agent/icon state must
      // never flip into a detected state while the on-streak keeps resetting.
      const detectedCalls = callback.mock.calls.filter(([result]) => result.detected === true);
      expect(detectedCalls).toHaveLength(0);
      expect(detector.getLastDetected()).toBeNull();
    });

    it("requires two consecutive polls for a new agent when swapping from another", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-5",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentType: "claude" }),
        expect.any(Number)
      );

      cache.setChildren(100, [{ pid: 201, comm: "codex", command: "codex --model o3" }]);
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentType: "codex" }),
        expect.any(Number)
      );
    });

    it("flushes a pending off streak on stop() so teardown does not leave ghost state", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-6",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      cache.setChildren(100, []);
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      detector.stop();

      expect(callback).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({
          detected: false,
          isBusy: false,
          currentCommand: undefined,
        }),
        expect.any(Number)
      );
    });

    it("does not emit a synthetic on event when stop() is called mid on-streak", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-7",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      detector.stop();

      expect(callback).not.toHaveBeenCalled();
    });

    it("does not emit a spurious idle callback after a one-poll blip on an idle terminal", () => {
      const cache = createCacheMock();
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-blip",
        Date.now(),
        100,
        callback,
        cache as never
      );

      // Idle start: emits the baseline { detected:false, isBusy:false } once.
      detector.start();
      const baseline = callback.mock.calls.length;

      // One-poll blip of a short-lived agent process.
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --version" }]);
      cache.emitRefresh();

      // Back to idle — side-channel state must not have been mutated during the
      // suppressed on-streak, so no spurious callback fires here.
      cache.setChildren(100, []);
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledTimes(baseline);
    });

    it("does not emit a spurious command-change callback after an aborted agent swap", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-swap-abort",
        Date.now(),
        100,
        callback,
        cache as never
      );

      // Commit claude.
      detector.start();
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);

      // One-poll blip of codex (swap candidate).
      cache.setChildren(100, [{ pid: 201, comm: "codex", command: "codex --version" }]);
      cache.emitRefresh();

      // Back to claude — committed state matches raw again, and side-channel
      // state was not overwritten by the aborted swap, so no callback fires.
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("does not emit a second off flush on repeated stop() calls", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-hys-8",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();

      cache.setChildren(100, []);
      cache.emitRefresh();
      detector.stop();

      expect(callback).toHaveBeenCalledTimes(2);

      detector.stop();
      expect(callback).toHaveBeenCalledTimes(2);
    });
  });
});
