import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessDetector, extractScriptBasenameFromCommand } from "../ProcessDetector.js";

type ProcessNode = { pid: number; comm: string; command?: string };

function createCacheMock() {
  const listeners = new Set<() => void>();
  const children = new Map<number, ProcessNode[]>();
  let lastError: Error | null = null;

  return {
    getChildren: vi.fn((pid: number) => children.get(pid) ?? []),
    getLastError: vi.fn(() => lastError),
    onRefresh: vi.fn((callback: () => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    setChildren(pid: number, nodes: ProcessNode[]) {
      children.set(pid, nodes);
    },
    setLastError(err: Error | null) {
      lastError = err;
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

  it("detects npm when the process title is rewritten to the full runner command", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "npm run dev",
        command: "npm run dev",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-npm-title-rewrite",
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
        processIconId: "npm",
        processName: "npm",
        isBusy: true,
        currentCommand: "npm run dev",
      }),
      expect.any(Number)
    );
  });

  it("detects Claude when it runs via Node as a shebang script", () => {
    // This is the real-world macOS case: `claude` is a Node CLI installed via
    // npm, so `comm` is "node" and the agent identity lives in argv[1].
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "node",
        command: "node /Users/greg/.npm-global/bin/claude --resume",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-node-claude",
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
        processName: "claude",
        isBusy: true,
      }),
      expect.any(Number)
    );
  });

  it("detects Python-hosted CLIs from argv (when they're in AGENT_CLI_NAMES)", () => {
    // Same mechanism — a Python agent appears as comm="python3" with script in argv[1].
    // No agent is currently Python-hosted, so this test asserts the runtime-host
    // recovery path doesn't crash and still identifies a known process icon.
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "python3",
        command: "/usr/bin/python3 /opt/somescript.py",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-python-fallback",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    // Basename python3 maps to process icon "python" via PROCESS_ICON_MAP;
    // argv[1] is not in AGENT_CLI_NAMES so the basename match stands.
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        processIconId: "python",
      }),
      expect.any(Number)
    );
  });

  it("prefers native-binary claude over argv-derived claude when both would match", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "claude",
        command: "/usr/local/bin/claude",
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-native-claude",
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
        processName: "claude",
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

  // Four-state detection: unknown / no_agent / agent / ambiguous. These tests
  // cover the specific failure modes called out in #5809 — blind ps, title-
  // rewriting CLIs, short-lived subprocess thrash under sticky TTL, utility-
  // process fd starvation — and guard against silent regressions where a
  // blind signal would demote a confident detection.
  describe("detection state (first-class ambiguity)", () => {
    it("returns unknown (not no_agent) when ps cache is in error state with empty children", () => {
      const cache = createCacheMock();
      cache.setLastError(new Error("ps: spawn EMFILE"));
      // Children is empty AND cache has live error → this is blindness, not
      // negative evidence. Detector must hold committed state rather than
      // emit a demotion. Unknown states are held, so no callback fires.
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-blind-ps",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();

      const detectedCalls = callback.mock.calls.filter(([r]) => r.detected === true);
      const demoteCalls = callback.mock.calls.filter(([r]) => r.detectionState === "no_agent");
      expect(detectedCalls).toHaveLength(0);
      expect(demoteCalls).toHaveLength(0);
    });

    it("holds committed agent through a blind-ps cycle (no demotion when lastError set)", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-blind-ps-hold",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenLastCalledWith(
        expect.objectContaining({ detectionState: "agent", agentType: "claude" }),
        expect.any(Number)
      );

      // ps goes blind — empty children with live error. Two more refreshes
      // must NOT demote; legacy behaviour would have committed no_agent after
      // two empty polls.
      cache.setChildren(100, []);
      cache.setLastError(new Error("ps: I/O error"));
      cache.emitRefresh();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledTimes(1);
      expect(detector.getLastDetected()).toBe("claude");
    });

    it("resolves to agent with evidenceSource 'shell_command' when tree is blind", () => {
      // Title-rewriting / blind-`ps` case: process tree has nothing, shell
      // evidence says `claude`. Must commit agent immediately (fast-commit
      // path) with evidenceSource 'shell_command'.
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-shell-only",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume"
      );

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detectionState: "agent",
          agentType: "claude",
          evidenceSource: "shell_command",
        }),
        expect.any(Number)
      );
    });

    it("resolves to agent with evidenceSource 'both' when tree and shell agree", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-both",
        Date.now(),
        100,
        callback,
        cache as never
      );
      // Inject before start so the first detect() sees both signals and
      // commits with evidenceSource 'both' on the first pass.
      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume"
      );
      detector.start();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detectionState: "agent",
          agentType: "claude",
          evidenceSource: "both",
        }),
        expect.any(Number)
      );
    });

    it("returns ambiguous when tree and shell report different agent identities", () => {
      // Genuine two-positive-signals conflict: tree says codex, shell says
      // claude. Must hold in ambiguous rather than pick one. No callback
      // fires for ambiguous (it's a HOLD state, no committed change).
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "codex", command: "codex --model gpt-5" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-ambiguous",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude"
      );
      detector.start();

      // With conflict, nothing should commit.
      expect(callback.mock.calls.filter(([r]) => r.detectionState === "agent")).toHaveLength(0);
      expect(detector.getLastDetected()).toBeNull();
    });

    it("holds committed state through short-lived subprocess thrash within sticky TTL", () => {
      // User ran `claude --resume` — shell evidence injected. A short-lived
      // subprocess (e.g. a grep the user ran mid-session) appears and exits
      // between cache polls. The sticky TTL must suppress off-streak counting
      // so the detector holds `claude`.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector("terminal-thrash", base, 100, callback, cache as never);
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume",
        base
      );
      expect(detector.getLastDetected()).toBe("claude");
      // Reset call history so only post-inject emissions are counted against
      // the demote assertion. Initial start() may have emitted a no_agent
      // baseline when no children existed, which is not a demotion.
      callback.mockClear();

      // Half a second later, children are empty (subprocess thrash). Must not
      // demote because sticky TTL (~12 s) is still active.
      vi.setSystemTime(base + 500);
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("claude");
      const demoteCalls = callback.mock.calls.filter(([r]) => r.detectionState === "no_agent");
      expect(demoteCalls).toHaveLength(0);
      vi.useRealTimers();
    });

    it("allows demotion after shell evidence expires past the upper bound", () => {
      // Absolute upper bound (~30 s) guards against a synthetic shell identity
      // holding `agent` forever when the process never actually started.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector("terminal-expiry", base, 100, callback, cache as never);
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume",
        base
      );
      expect(detector.getLastDetected()).toBe("claude");

      // Advance past expiry (30 s upper bound) — shell evidence should now be
      // expired and a blind tree can demote the commit via normal hysteresis.
      vi.setSystemTime(base + 31_000);
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("clearShellCommandEvidence releases the TTL so the tree path can demote", () => {
      // On prompt-return, TerminalProcess clears shell evidence. The next
      // detector pass with empty tree then moves through normal off-streak
      // hysteresis and commits no_agent after two confirmations.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector("terminal-cleared", base, 100, callback, cache as never);
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume",
        base
      );
      expect(detector.getLastDetected()).toBe("claude");

      detector.clearShellCommandEvidence();
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("promotes shell-command evidence even when ps is in error state with empty children", () => {
      // Primary regression guard for #5809: when the cache is BLIND (ps
      // failed) AND the user just typed `claude`, the shell evidence must
      // promote the committed state. The earlier "tree is blind" test used
      // a healthy-empty cache; this test uses an error-state cache, which
      // is the actual failure mode the feature targets. A naive `unknown`
      // early-return would discard shell evidence here.
      const cache = createCacheMock();
      cache.setLastError(new Error("ps: spawn EMFILE"));
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-blind-plus-shell",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume"
      );

      const agentCalls = callback.mock.calls.filter(([r]) => r.detectionState === "agent");
      expect(agentCalls.length).toBeGreaterThan(0);
      expect(agentCalls[agentCalls.length - 1][0]).toMatchObject({
        detectionState: "agent",
        agentType: "claude",
        evidenceSource: "shell_command",
      });
      expect(detector.getLastDetected()).toBe("claude");
    });

    it("upgrades committed evidence source when tree later corroborates a shell-only commit", () => {
      // Regression guard for #5809: after shell commits `claude`, a
      // subsequent cache refresh with the tree also showing `claude` must
      // upgrade lastEvidenceSource to "both". If it stays "shell_command",
      // clearShellCommandEvidence would then emit a spurious synchronous
      // demotion on prompt-return even though the tree still has the agent.
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-upgrade-source",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      // Step 1: shell-only commit (tree empty, healthy cache).
      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume"
      );
      expect(detector.getLastDetected()).toBe("claude");

      // Step 2: tree refresh now shows claude — committed state unchanged,
      // but evidence source should upgrade to "both".
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      cache.emitRefresh();

      // Step 3: clear shell evidence (simulates prompt-return). The committed
      // state must PERSIST because the tree still supports it.
      callback.mockClear();
      detector.clearShellCommandEvidence();

      const demoteCalls = callback.mock.calls.filter(([r]) => r.detectionState === "no_agent");
      expect(demoteCalls).toHaveLength(0);
      expect(detector.getLastDetected()).toBe("claude");
    });

    it("holds agent identity at 12s sticky boundary but demotes past 30s expiry", () => {
      // The sticky TTL (12 s) and expiry TTL (30 s) must be distinct — at
      // the sticky boundary the badge persists, only at the absolute expiry
      // can the tree path demote.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-ttl-boundary",
        base,
        100,
        callback,
        cache as never
      );
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude --resume",
        base
      );
      expect(detector.getLastDetected()).toBe("claude");

      // Just past the sticky boundary but well before expiry — shell
      // evidence still present, just not anchoring off-streak anymore. An
      // empty tree would demote after hysteresis, but shell is still fresh
      // in merge logic, so tree sees "agent shell_command" and no demote
      // fires.
      vi.setSystemTime(base + 12_001);
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();
      expect(detector.getLastDetected()).toBe("claude");

      // Past absolute expiry — shell evidence cleared on next detect, tree
      // is empty and healthy, normal off-streak hysteresis runs and commits
      // no_agent.
      vi.setSystemTime(base + 30_001);
      cache.emitRefresh();
      cache.emitRefresh();
      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("emits detectionState on the legacy committed callback", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-state-field",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detectionState: "agent",
          detected: true,
          evidenceSource: "process_tree",
        }),
        expect.any(Number)
      );
    });
  });
});

describe("extractScriptBasenameFromCommand", () => {
  it("extracts claude from `node /path/to/claude`", () => {
    expect(extractScriptBasenameFromCommand("node /Users/foo/.npm-global/bin/claude")).toBe(
      "claude"
    );
  });

  it("extracts claude when trailing flags are present", () => {
    expect(extractScriptBasenameFromCommand("node /path/to/claude --resume --model opus")).toBe(
      "claude"
    );
  });

  it("strips .js / .mjs / .cjs / .ts / .py / .rb extensions", () => {
    expect(extractScriptBasenameFromCommand("node /path/to/gemini.mjs")).toBe("gemini");
    expect(extractScriptBasenameFromCommand("python3 /opt/script.py")).toBe("script");
    expect(extractScriptBasenameFromCommand("ruby /opt/tool.rb")).toBe("tool");
    expect(extractScriptBasenameFromCommand("deno /opt/thing.ts")).toBe("thing");
  });

  it("skips leading flags", () => {
    expect(extractScriptBasenameFromCommand("node --inspect /path/to/claude")).toBe("claude");
  });

  it("returns null for a bare runtime (no argv[1])", () => {
    expect(extractScriptBasenameFromCommand("node")).toBeNull();
    expect(extractScriptBasenameFromCommand("python3")).toBeNull();
  });

  it("returns null for undefined / empty input", () => {
    expect(extractScriptBasenameFromCommand(undefined)).toBeNull();
    expect(extractScriptBasenameFromCommand("")).toBeNull();
  });
});
