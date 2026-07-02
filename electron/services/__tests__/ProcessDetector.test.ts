import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessDetector,
  detectCommandIdentity,
  extractCommandNameCandidates,
  extractScriptBasenameFromCommand,
} from "../ProcessDetector.js";

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

  it("detects agent npm command shims from Windows process paths", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      {
        pid: 200,
        comm: "C:\\npm\\prefix\\claude.cmd",
        command: '"C:\\npm\\prefix\\claude.cmd" --resume',
      },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-windows-shim",
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
        currentCommand: '"C:\\npm\\prefix\\claude.cmd" --resume',
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

  it.each([
    { wrapper: "npx @anthropic-ai/claude-code", expectedAgent: "claude" },
    { wrapper: "pnpm dlx @anthropic-ai/claude-code", expectedAgent: "claude" },
    { wrapper: "bunx @anthropic-ai/claude-code", expectedAgent: "claude" },
    { wrapper: "npx @google/gemini-cli", expectedAgent: "gemini" },
    { wrapper: "pnpm dlx @google/gemini-cli", expectedAgent: "gemini" },
    { wrapper: "npx @openai/codex", expectedAgent: "codex" },
  ])(
    "detects $expectedAgent via npm-package-tail alias ($wrapper)",
    ({ wrapper, expectedAgent }) => {
      // npx/dlx/bunx typically show the package name in argv after the runner.
      // The extractor strips `@scope/` to the tail, so `claude-code`,
      // `gemini-cli`, `codex` must all resolve back to the right agent id.
      const cache = createCacheMock();
      const [runner] = wrapper.split(/\s+/);
      cache.setChildren(100, [{ pid: 200, comm: runner, command: wrapper }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        `terminal-wrapper-${expectedAgent}`,
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
          agentType: expectedAgent,
        }),
        expect.any(Number)
      );
    }
  );

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

  it("does not demote a previously detected agent from process-tree absence", () => {
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

    // Process-tree absence is no longer an agent-exit signal.
    cache.setChildren(100, []);
    cache.emitRefresh();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(detector.getLastDetected()).toBe("claude");
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

  it("promotes shell-command process evidence even when the PTY pid is invalid", () => {
    const cache = createCacheMock();
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-invalid-pid-node",
      Date.now(),
      0,
      callback,
      cache as never
    );
    detector.start();
    detector.injectShellCommandEvidence(
      { processIconId: "node", processName: "node" },
      `node -e "setTimeout(()=>{}, 8000)"`
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        detectionState: "agent",
        processIconId: "node",
        processName: "node",
        evidenceSource: "shell_command",
      }),
      expect.any(Number)
    );
  });

  it("promotes shell-command agent evidence even when the PTY pid is invalid", () => {
    const cache = createCacheMock();
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-invalid-pid-claude",
      Date.now(),
      0,
      callback,
      cache as never
    );
    detector.start();
    detector.injectShellCommandEvidence(
      { agentType: "claude", processIconId: "claude", processName: "claude" },
      "& 'C:\\npm\\prefix\\claude.cmd'"
    );

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        detected: true,
        detectionState: "agent",
        agentType: "claude",
        processIconId: "claude",
        processName: "claude",
        evidenceSource: "shell_command",
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

    it("does not demote an agent after absent process-tree polls", () => {
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
      expect(callback).toHaveBeenCalledTimes(1);
      expect(detector.getLastDetected()).toBe("claude");
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

    it("does not synthesize agent demotion on detector stop without explicit exit", () => {
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

      expect(callback).toHaveBeenCalledTimes(1);
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

    it("does not emit an agent off flush on repeated stop() calls", () => {
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

      expect(callback).toHaveBeenCalledTimes(1);

      detector.stop();
      expect(callback).toHaveBeenCalledTimes(1);
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

    it("retains agent shell evidence after expiry until explicit prompt return", () => {
      // Timer expiry is not an exit signal for agents. Idle CLIs can disappear
      // from process scans while still owning the terminal; the shell prompt
      // returning is the explicit exit signal.
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

      // Advance past expiry (30 s upper bound) with an empty tree. This used
      // to demote; it must now hold until prompt-return cleanup.
      vi.setSystemTime(base + 31_000);
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("claude");

      detector.clearShellCommandEvidence("prompt-return");
      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("retains runtime-promoted shell-agent evidence through idle empty-tree polls", () => {
      // A user can type `claude` into a plain shell. On Windows the idle TUI can
      // look like an empty process tree even though Claude still owns the
      // terminal, so unanchored/runtime promotion must still honor shell-agent
      // evidence until prompt-return clears it.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-runtime-idle",
        base,
        100,
        callback,
        cache as never,
        false
      );
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "claude", processIconId: "claude", processName: "claude" },
        "claude",
        base
      );
      expect(detector.getLastDetected()).toBe("claude");
      callback.mockClear();

      vi.setSystemTime(base + 45_000);
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("claude");
      expect(callback.mock.calls.filter(([r]) => r.detectionState === "no_agent")).toHaveLength(0);

      detector.clearShellCommandEvidence("prompt-return");
      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("anchors a runtime-promoted agent once the process tree corroborates it (#10911)", () => {
      // User typed `codex` into a plain shell (no launchAgentId ⇒ isLaunchAnchored
      // starts false). Once the process tree confirms a real codex process, the
      // agent must become sticky so process-tree-absence ticks (idle TUI, argv
      // rewrite) can't flap it back to a plain terminal.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "codex", command: "codex" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-runtime-anchor",
        Date.now(),
        100,
        callback,
        cache as never,
        false
      );
      detector.start();
      cache.emitRefresh(); // second poll commits via process-tree hysteresis
      expect(detector.getLastDetected()).toBe("codex");
      callback.mockClear();

      // Empty tree would demote an un-anchored runtime promotion after the
      // hysteresis window; anchoring must hold it instead.
      cache.setChildren(100, []);
      cache.emitRefresh();
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("codex");
      expect(callback.mock.calls.filter(([r]) => r.detectionState === "no_agent")).toHaveLength(0);
    });

    it("does not anchor a runtime-promoted agent on shell-command-only evidence (#10911)", () => {
      // Anchoring must require process-tree corroboration. A shell-command-only
      // commit (no matching process in the tree) must stay un-anchored so it
      // can still demote via the off-streak path once its sticky evidence is
      // gone — otherwise a mistyped/aliased command would stick forever.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      cache.setChildren(100, []); // no corroborating process
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-shell-only-noanchor",
        base,
        100,
        callback,
        cache as never,
        false
      );
      detector.start();

      detector.injectShellCommandEvidence(
        { agentType: "codex", processIconId: "codex", processName: "codex" },
        "codex",
        base
      );
      expect(detector.getLastDetected()).toBe("codex");

      // Drop the shell evidence (manual clear keeps the committed agent but
      // removes the sticky TTL), then let empty-tree polls run past hysteresis.
      // An un-anchored agent must demote; an incorrectly anchored one would hold.
      detector.clearShellCommandEvidence();
      cache.emitRefresh();
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("prompt-return still demotes a runtime-promoted agent anchored by the process tree (#10911)", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "codex", command: "codex" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-runtime-anchor-demote",
        Date.now(),
        100,
        callback,
        cache as never,
        false
      );
      detector.start();
      cache.emitRefresh();
      expect(detector.getLastDetected()).toBe("codex");

      // Explicit lifecycle signal must override the anchor.
      detector.clearShellCommandEvidence("prompt-return");
      expect(detector.getLastDetected()).toBeNull();
    });

    it("retains expired shell-agent evidence while the PTY still has a live child", () => {
      // Real agent CLIs can rewrite argv/comm so process-tree matching never
      // corroborates the shell command, but a live child still proves the
      // launched command has not returned to the shell. The 30s shell-evidence
      // expiry must not demote in that state.
      const base = Date.now();
      vi.setSystemTime(base);
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-expired-live-child",
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
      callback.mockClear();

      vi.setSystemTime(base + 31_000);
      cache.setChildren(100, [{ pid: 200, comm: "node", command: "node /tmp/runtime.js" }]);
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("claude");
      expect(callback.mock.calls.filter(([r]) => r.detectionState === "no_agent")).toHaveLength(0);

      cache.setChildren(100, []);
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("claude");

      detector.clearShellCommandEvidence("prompt-return");
      expect(detector.getLastDetected()).toBeNull();
      vi.useRealTimers();
    });

    it("prompt-return clear demotes an agent synchronously", () => {
      // On prompt-return, TerminalProcess clears shell evidence with the
      // explicit lifecycle reason. That is the demotion signal; no process-tree
      // confirmation is required.
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

      detector.clearShellCommandEvidence("prompt-return");

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

      // Step 3: clear shell evidence without a lifecycle reason. The committed
      // state must PERSIST because the tree still supports it.
      callback.mockClear();
      detector.clearShellCommandEvidence();

      const demoteCalls = callback.mock.calls.filter(([r]) => r.detectionState === "no_agent");
      expect(demoteCalls).toHaveLength(0);
      expect(detector.getLastDetected()).toBe("claude");
    });

    it("prompt-return demotes even after process-tree corroboration", () => {
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-prompt-return-corroborated",
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
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      cache.emitRefresh();
      expect(detector.getLastDetected()).toBe("claude");

      detector.clearShellCommandEvidence("prompt-return");

      expect(detector.getLastDetected()).toBeNull();
      expect(callback.mock.calls.some(([r]) => r.detectionState === "no_agent")).toBe(true);
    });

    it("prompt-return demotes a tree-corroborated process icon (no agent)", () => {
      // Regression guard for #5813: when the user types `node -e ...`, the
      // process tree picks up the node child first and commits with
      // `evidenceSource: "process_tree"`, then the IdentityWatcher's shell
      // injection arrives ~1.2s later. If the next process-tree poll fires
      // BEFORE the IdentityWatcher's prompt-return cleanup, an upgrade path
      // can rewrite `lastEvidenceSource` to "shell_command" and the demotion
      // works. But under load (slow `ps`, adaptive backoff) the poll can run
      // after the prompt-return cleanup — leaving `lastEvidenceSource` at
      // "process_tree" — and the earlier `shellWasSoleSupport` gate then
      // refused to demote the icon. The badge stays stuck for the full poll
      // cycle (up to 15s with backoff) or indefinitely if the cache is in
      // error state.
      const cache = createCacheMock();
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-process-icon-prompt-return",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();

      // Tree commits "node" first via process_tree evidence (the typical
      // race winner because the process spawns within ~150ms of submit but
      // the IdentityWatcher waits 1200ms before injecting).
      cache.setChildren(100, [{ pid: 200, comm: "node", command: "node -e setTimeout" }]);
      cache.emitRefresh();
      cache.emitRefresh();

      // Shell evidence arrives ~1.2s later. Tree still corroborates.
      detector.injectShellCommandEvidence(
        { processIconId: "node", processName: "node" },
        'node -e "setTimeout(()=>{}, 8000)"'
      );

      // Process exits. The IdentityWatcher's prompt-return cleanup runs
      // BEFORE the next ProcessTreeCache poll picks up the empty tree —
      // simulating the race that strands the badge.
      callback.mockClear();
      detector.clearShellCommandEvidence("prompt-return");

      const noAgentCalls = callback.mock.calls.filter(([r]) => r.detectionState === "no_agent");
      expect(noAgentCalls.length).toBeGreaterThan(0);
    });

    it("holds agent identity at sticky and expiry boundaries until prompt return", () => {
      // Sticky TTL (12 s) still suppresses off-streaks for all shell evidence,
      // but agent evidence also survives the old 30 s expiry. Demotion now
      // requires prompt return.
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

      // Past the old absolute expiry — empty tree is still not enough to
      // demote an agent.
      vi.setSystemTime(base + 30_001);
      cache.emitRefresh();
      cache.emitRefresh();
      expect(detector.getLastDetected()).toBe("claude");

      detector.clearShellCommandEvidence("prompt-return");
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

  describe("zombie child filtering", () => {
    it("does not set isBusy when children are all defunct", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "node", command: "<defunct>" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-zombie-only",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      // No children after filtering → should be no_agent (negative evidence)
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: false,
          detectionState: "no_agent",
        }),
        expect.any(Number)
      );
    });

    it("reports isBusy: true with mixed live and defunct children", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [
        { pid: 200, comm: "node", command: "<defunct>" },
        { pid: 201, comm: "claude", command: "claude --resume" },
      ]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-mixed-defunct",
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
          detectionState: "agent",
        }),
        expect.any(Number)
      );
    });

    it("unmatched-children diagnostic skips defunct entries", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "bash", command: "<defunct>" }]);
      const callback = vi.fn();
      const detector = new ProcessDetector(
        "terminal-defunct-diag",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      // No live children → no_agent. The defunct child is filtered before
      // the processes mapping, so the diagnostic never sees it.
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: false,
          detectionState: "no_agent",
        }),
        expect.any(Number)
      );
    });
  });

  describe("image-path evidence (#8790)", () => {
    function createImagePathProbeMock(map: Record<number, string | null>) {
      return {
        readBasename: vi.fn((pid: number) => map[pid] ?? null),
        evict: vi.fn(),
        dispose: vi.fn(),
      };
    }

    it("identifies an agent when comm is rewritten but image basename is the agent", () => {
      // The exact failure mode #8790 targets: agent CLI rewrote its own
      // process title to a marketing name, so `comm`/`command` look like
      // "app-runner" with no AGENT_CLI_NAMES match — but the on-disk image
      // is /opt/homebrew/bin/claude. Image-path evidence must rescue it.
      const cache = createCacheMock();
      cache.setChildren(100, [
        {
          pid: 200,
          comm: "app-runner",
          command: "app-runner",
        },
      ]);
      const imagePathProbe = createImagePathProbeMock({ 200: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-image-rewrite",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          detectionState: "agent",
          agentType: "claude",
          evidenceSource: "process_tree",
        }),
        expect.any(Number)
      );
      expect(imagePathProbe.readBasename).toHaveBeenCalledWith(200);
    });

    it("ignores image-path basename when it returns null", () => {
      // Probe hasn't resolved yet (or platform unsupported). Detection must
      // behave exactly as before — fall through to the existing comm/argv
      // path. No regression on a process the detector already identifies.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: null });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-image-null",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          agentType: "claude",
        }),
        expect.any(Number)
      );
    });

    it("works when no image-path probe is wired (backwards compat)", () => {
      // Existing call sites pass only the 6-arg constructor signature. The
      // detector must work identically when the probe is omitted.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-no-probe",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ detected: true, agentType: "claude" }),
        expect.any(Number)
      );
    });

    it("prefers image-path agent over a comm-only generic icon", () => {
      // Node-hosted agent: kernel reports comm="node", argv has been blanked,
      // so without image-path the detector would settle on the generic
      // "node" process icon. Image basename "claude" should win via the
      // agent-priority promotion in selectPreferredCandidate.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "node", command: "node" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-node-hosted",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          agentType: "claude",
        }),
        expect.any(Number)
      );
    });

    it("does not regress when image-path basename matches an existing agent comm", () => {
      // Both signals agree on `claude`. Detector should commit `claude`
      // with process_tree evidence — no double-count, no priority inversion.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-both-agree",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          agentType: "claude",
          evidenceSource: "process_tree",
        }),
        expect.any(Number)
      );
    });

    it("evicts ImagePathProbe entries for children that disappear between passes", () => {
      // PID-reuse safety: if pid 200 was probed last pass and is gone this
      // pass, the detector must evict its image-path cache entry so a future
      // process with the recycled PID doesn't inherit the stale basename.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-evict",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();
      expect(imagePathProbe.readBasename).toHaveBeenCalledWith(200);

      // Child disappears.
      cache.setChildren(100, []);
      cache.emitRefresh();
      expect(imagePathProbe.evict).toHaveBeenCalledWith(200);
    });

    it("evicts ImagePathProbe entries for the terminal's last-seen children on stop()", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-evict-stop",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();
      detector.stop();

      expect(imagePathProbe.evict).toHaveBeenCalledWith(200);
    });

    it("resolves grandchild image paths when the direct child is only an icon match", () => {
      // Grandchild fallback path: zsh → bash → renamed-claude. The direct
      // child has only an icon (priority > 0 triggers grandchild scan); the
      // grandchild's image basename "claude" promotes the result to agent
      // even though both the grandchild comm and argv have been rewritten.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "bash", command: "bash login_script.sh" }]);
      cache.setChildren(200, [{ pid: 300, comm: "app-runner", command: "app-runner" }]);
      const imagePathProbe = createImagePathProbeMock({ 200: null, 300: "claude" });
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-image-grandchild",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          detected: true,
          agentType: "claude",
        }),
        expect.any(Number)
      );
      expect(imagePathProbe.readBasename).toHaveBeenCalledWith(300);
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

  it("strips .js / .mjs / .cjs / .ts / .py / .rb / .tsx / .jsx extensions", () => {
    expect(extractScriptBasenameFromCommand("node /path/to/gemini.mjs")).toBe("gemini");
    expect(extractScriptBasenameFromCommand("python3 /opt/script.py")).toBe("script");
    expect(extractScriptBasenameFromCommand("ruby /opt/tool.rb")).toBe("tool");
    expect(extractScriptBasenameFromCommand("deno /opt/thing.ts")).toBe("thing");
    expect(extractScriptBasenameFromCommand("node /path/to/claude.tsx --flag")).toBe("claude");
    expect(extractScriptBasenameFromCommand("node /path/to/claude.jsx --flag")).toBe("claude");
    expect(extractScriptBasenameFromCommand("node /path/to/claude.mjsx --flag")).toBe("claude");
  });

  it("extracts command basenames from quoted absolute launch paths", () => {
    expect(
      extractCommandNameCandidates(
        "'/Users/gpriday/.local/bin/claude' --dangerously-skip-permissions"
      )
    ).toEqual(["claude"]);
    expect(
      extractCommandNameCandidates('"/tmp/Daintree Test/bin/claude" --dangerously-skip-permissions')
    ).toEqual(["claude"]);
  });

  it("detects agents from quoted absolute launch paths", () => {
    expect(
      detectCommandIdentity("'/Users/gpriday/.local/bin/claude' --dangerously-skip-permissions")
    ).toMatchObject({
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
    });
  });

  it("detects agents from PowerShell launch commands that call Windows shims", () => {
    expect(
      extractCommandNameCandidates("& 'C:\\npm\\prefix\\claude.cmd' --dangerously-skip-permissions")
    ).toEqual(["claude"]);
    expect(
      detectCommandIdentity("& 'C:\\npm\\prefix\\claude.cmd' --dangerously-skip-permissions")
    ).toMatchObject({
      agentType: "claude",
      processIconId: "claude",
      processName: "claude",
    });
  });

  it("skips leading flags", () => {
    expect(extractScriptBasenameFromCommand("node --inspect /path/to/claude")).toBe("claude");
  });

  it("bumps candidate cap to 5 and skips pure-numeric tokens", () => {
    expect(extractCommandNameCandidates("time nice -n 10 claude")).toContain("claude");
    expect(extractCommandNameCandidates("time nice -n 10 claude")).not.toContain("10");
    expect(extractCommandNameCandidates("time nice -n 10 -adjust 3.14 npx claude")).toEqual([
      "time",
      "nice",
      "npx",
      "claude",
    ]);
  });

  it("fills all 5 candidate slots from a deep wrapper stack", () => {
    // 6 non-flag, non-numeric tokens before the agent — cap of 5 verified
    // (slot 6 'codex' should be excluded by the cap)
    const candidates = extractCommandNameCandidates("env FOO=bar direnv exec mise x npx codex");
    expect(candidates).toHaveLength(5);
    expect(candidates).toEqual(["env", "direnv", "exec", "mise", "x"]);
  });

  it("preserves names containing digits (not pure-numeric)", () => {
    const candidates = extractCommandNameCandidates("node20 /path/to/claude2 --flag");
    expect(candidates).toContain("node20");
    expect(candidates).toContain("claude2");
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
