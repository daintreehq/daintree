import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProcessDetector,
  detectCommandIdentity,
  extractCommandNameCandidates,
  extractScriptBasenameFromCommand,
  redactArgv,
} from "../ProcessDetector.js";
import {
  clearPluginProcessToolRegistryForTests,
  setPluginProcessToolRegistry,
} from "../../../shared/config/pluginProcessToolRegistry.js";
import { AGENT_CLI_NAMES } from "../ProcessDetector/registries.js";
import { AGENT_REGISTRY } from "../../../shared/config/agentRegistry.js";
import { buildDetectedCandidate } from "../ProcessDetector/candidateHelpers.js";
import {
  executablePositionLimit,
  isChromiumChildProcess,
} from "../ProcessDetector/commandParser.js";
import { logInfo } from "../../utils/logger.js";

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

/** Commit-diagnostic lines emitted so far, newest last. */
function agentCommitLogs(): string[] {
  return vi
    .mocked(logInfo)
    .mock.calls.map(([message]) => message)
    .filter((message) => message.includes("agent identity committed"));
}

type ProcessNode = { pid: number; comm: string; command: string };

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

    // Basename python3 maps to process icon "python" via getProcessIconMap();
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

  it("uses package managers only as a fallback against a named tool", () => {
    // A package manager names the launcher, not the work. When something more
    // specific is running, that is what the pane should say. #11612
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
        processIconId: "docker",
        processName: "docker",
      }),
      expect.any(Number)
    );
  });

  it("still reports the package manager when nothing identifiable runs below it", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm install" }]);
    cache.setChildren(200, [{ pid: 300, comm: "sh", command: "sh -c postinstall.sh" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-pm-fallback",
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
      }),
      expect.any(Number)
    );
  });

  it("sees past an sh -c wrapper to the tool the package manager launched", () => {
    // npm inserts `sh -c` as soon as a run-script contains a metacharacter,
    // which put the real tool out of reach of the old two-level scan. #11612
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm run dev" }]);
    // The wrapper's argv names a script, not the tool, so only reaching the
    // depth-3 node can identify Vite. Naming it in the `sh -c` argv would let
    // the old grandchild-only scan pass this test too.
    cache.setChildren(200, [{ pid: 300, comm: "sh", command: "sh -c ./scripts/start-dev.sh" }]);
    cache.setChildren(300, [{ pid: 400, comm: "vite", command: "vite --host" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-deep-vite",
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
        processIconId: "vite",
        processName: "vite",
      }),
      expect.any(Number)
    );
  });

  it("reaches a tool five wrapper levels below the pty", () => {
    // Mirrors this repo's own `npm run check`: npm → sh -c → npm → cross-env
    // → npm before anything identifiable appears.
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm run check" }]);
    cache.setChildren(200, [{ pid: 300, comm: "sh", command: "sh -c npm run typecheck" }]);
    cache.setChildren(300, [{ pid: 400, comm: "npm", command: "npm run typecheck" }]);
    cache.setChildren(400, [{ pid: 500, comm: "node", command: "node cross-env tsc -b" }]);
    cache.setChildren(500, [{ pid: 600, comm: "tsc", command: "tsc -b --pretty" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-deep-tsc",
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
        processIconId: "typescript",
        processName: "tsc",
      }),
      expect.any(Number)
    );
  });

  it("prefers the script a runtime is hosting over the runtime itself", () => {
    // `node .../vite.js` reports comm=node; without the argv preference every
    // dev server in every pane would show the same Node mark.
    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "node", command: "node /repo/node_modules/.bin/vitest --watch" },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-runtime-host",
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
        processIconId: "vitest",
        processName: "vitest",
      }),
      expect.any(Number)
    );
  });

  it("does not descend past an identified agent into its worker processes", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "claude", command: "claude --resume" }]);
    cache.setChildren(200, [{ pid: 300, comm: "node", command: "node /worker.js" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-agent-stop",
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
    expect(cache.getChildren).not.toHaveBeenCalledWith(200);
  });

  it("does not descend into a defunct wrapper", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm run dev" }]);
    cache.setChildren(200, [{ pid: 300, comm: "sh", command: "sh <defunct>" }]);
    cache.setChildren(300, [{ pid: 400, comm: "vite", command: "vite --host" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-defunct-deep",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(cache.getChildren).not.toHaveBeenCalledWith(300);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ processIconId: "npm" }),
      expect.any(Number)
    );
  });

  it("terminates on a process tree that reports itself as its own descendant", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm run dev" }]);
    cache.setChildren(200, [{ pid: 300, comm: "sh", command: "sh -c start" }]);
    // An inconsistent `ps` snapshot can report a cycle; the walk must not hang.
    cache.setChildren(300, [{ pid: 200, comm: "npm", command: "npm run dev" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-cycle",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    // The cycle guard is per-pass, so count expansions within one pass — but
    // the callback needs a second poll to clear hysteresis.
    cache.getChildren.mockClear();
    cache.emitRefresh();

    // Termination alone is guaranteed by the depth cap; what proves the guard
    // works is that the revisited PID is never expanded twice in a pass.
    const expansionsOf200 = cache.getChildren.mock.calls.filter(([pid]) => pid === 200);
    expect(expansionsOf200).toHaveLength(1);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ detected: true, processIconId: "npm" }),
      expect.any(Number)
    );
  });

  it("does not let an argument to a script masquerade as the tool", () => {
    // `npm run docker` runs a package script the user named "docker"; the tool
    // actually running is whatever that script spawns.
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm run docker" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-script-name",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ detected: true, processIconId: "npm", processName: "npm" }),
      expect.any(Number)
    );
  });

  it("does not let a runtime's positional argument masquerade as the tool", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "node", command: "node server.js vite --port 3000" },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-positional-arg",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ detected: true, processIconId: "node", processName: "node" }),
      expect.any(Number)
    );
  });

  it("scans every direct child for an agent even past the descent budget", () => {
    // The node budget bounds how deep the walk expands, not whether a direct
    // child is looked at — dropping one could hide an agent entirely.
    const cache = createCacheMock();
    const siblings = Array.from({ length: 200 }, (_, i) => ({
      pid: 1000 + i,
      comm: "sh",
      command: "sh -c worker",
    }));
    cache.setChildren(100, [
      ...siblings,
      { pid: 5000, comm: "claude", command: "claude --resume" },
    ]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-wide-agent",
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

  it("still descends past a first level wide enough to exhaust the node budget", () => {
    // Counting direct children against the descent budget would make a PTY
    // with many children blind to everything below them.
    const cache = createCacheMock();
    const siblings = Array.from({ length: 200 }, (_, i) => ({
      pid: 1000 + i,
      comm: "sh",
      command: "sh -c worker",
    }));
    cache.setChildren(100, siblings);
    cache.setChildren(1000, [{ pid: 9000, comm: "vite", command: "vite --host" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-wide-descend",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ detected: true, processIconId: "vite" }),
      expect.any(Number)
    );
  });

  it("stops descending once the descendant budget is exhausted", () => {
    const cache = createCacheMock();
    cache.setChildren(100, [{ pid: 200, comm: "sh", command: "sh -c fan-out" }]);
    // A single direct child fans out past the budget at depth 2, so the walk
    // must stop before expanding the tail of that level.
    const wide = Array.from({ length: 200 }, (_, i) => ({
      pid: 1000 + i,
      comm: "sh",
      command: "sh -c worker",
    }));
    cache.setChildren(200, wide);
    // Hangs off the last depth-2 node, so it is only reachable if the walk
    // ignores its own budget.
    cache.setChildren(1199, [{ pid: 9000, comm: "vite", command: "vite --host" }]);
    const callback = vi.fn();

    const detector = new ProcessDetector(
      "terminal-wide",
      Date.now(),
      100,
      callback,
      cache as never
    );
    detector.start();
    cache.emitRefresh();

    expect(cache.getChildren).not.toHaveBeenCalledWith(1199);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ detected: false, isBusy: true }),
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

  describe("argument paths are not executables (#11931)", () => {
    // This repo is full of file paths that name agents, so a process that
    // merely *opens* one must not inherit that agent's identity.
    const agentPath = "/repo/shared/config/agents/opencode.ts";

    it.each([
      { label: "cat", comm: "cat", command: `cat ${agentPath}` },
      { label: "git log", comm: "git", command: `git log -- ${agentPath}` },
      { label: "an editor", comm: "nvim", command: `nvim ${agentPath}` },
      { label: "a grep", comm: "rg", command: `rg opencode ${agentPath}` },
    ])("does not brand the terminal OpenCode from $label", ({ label, comm, command }) => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm, command }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        `terminal-argpath-${label.replace(/\s+/g, "-")}`,
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      // Witness that the walk actually ran, so the absence below is a verdict
      // rather than a detector that never started.
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ isBusy: true }),
        expect.any(Number)
      );
      expect(detector.getLastDetected()).toBeNull();
      for (const [result] of callback.mock.calls) {
        expect(result.agentType).toBeUndefined();
        expect(result.processIconId).not.toBe("opencode");
      }
    });

    it("still resolves an agent a runtime is hosting", () => {
      // The guard must not cost the real case it exists alongside: `claude`
      // installed as a Node CLI shows comm="node" with the agent at argv[1].
      const cache = createCacheMock();
      cache.setChildren(100, [
        { pid: 200, comm: "node", command: "node /opt/bin/opencode --continue" },
      ]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-argpath-runtime",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("opencode");
    });
  });

  describe("nested app process boundary (#11931)", () => {
    /** The reported repro: `npx electron .` running Daintree from the repo. */
    function seedNestedDaintree(cache: ReturnType<typeof createCacheMock>) {
      cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm exec electron ." }]);
      cache.setChildren(200, [
        { pid: 300, comm: "node", command: "node /repo/node_modules/electron/cli.js ." },
      ]);
      cache.setChildren(300, [
        { pid: 400, comm: "Electron", command: "/repo/node_modules/electron/dist/Electron ." },
      ]);
      cache.setChildren(400, [
        {
          pid: 500,
          // `ProcessTreeCache.parseUnixLine` captures comm as `\S+`, so a real
          // helper's comm arrives without the spaces its bundle path has.
          comm: "Electron",
          command:
            "/repo/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper --type=utility --utility-sub-type=node.mojom.NodeService",
        },
      ]);
      cache.setChildren(500, [{ pid: 600, comm: "zsh", command: "/bin/zsh -l" }]);
      cache.setChildren(600, [{ pid: 700, comm: "opencode", command: "opencode" }]);
    }

    it("does not inherit the inner instance's agent through its pty-host", () => {
      const cache = createCacheMock();
      seedNestedDaintree(cache);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-nested-daintree",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      // The walk ran and descended: it reached the boundary node's parent.
      expect(cache.getChildren).toHaveBeenCalledWith(400);
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ isBusy: true }),
        expect.any(Number)
      );
      expect(detector.getLastDetected()).toBeNull();
      for (const [result] of callback.mock.calls) {
        expect(result.agentType).toBeUndefined();
      }
      // ...and stopped there: the boundary node's subtree is never fetched.
      expect(cache.getChildren).not.toHaveBeenCalledWith(500);
    });

    it("still reaches an agent that is not behind a Chromium helper", () => {
      // Same depth, same shape — only the boundary node is missing. Proves the
      // prune is what stopped the walk above, not the depth budget.
      const cache = createCacheMock();
      seedNestedDaintree(cache);
      cache.setChildren(400, [{ pid: 500, comm: "zsh", command: "/bin/zsh -l" }]);
      cache.setChildren(500, [{ pid: 700, comm: "opencode", command: "opencode" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-nested-control",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      expect(detector.getLastDetected()).toBe("opencode");
    });

    it("never matches or probes the boundary node itself", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [
        {
          pid: 200,
          comm: "Electron",
          command:
            "/repo/node_modules/electron/dist/Electron Helper --type=utility --utility-sub-type=node.mojom.NodeService",
        },
      ]);
      cache.setChildren(200, [{ pid: 300, comm: "opencode", command: "opencode" }]);
      // Returning an agent basename here fails the test if the node is probed.
      const imagePathProbe = {
        readBasename: vi.fn((pid: number) => (pid === 200 ? "opencode" : null)),
        evict: vi.fn(),
        dispose: vi.fn(),
      };
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-boundary-node",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      // A pruned child is still a running process: the terminal stays busy.
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ isBusy: true }),
        expect.any(Number)
      );
      expect(detector.getLastDetected()).toBeNull();
      expect(imagePathProbe.readBasename).not.toHaveBeenCalledWith(200);
      expect(cache.getChildren).not.toHaveBeenCalledWith(200);
    });
  });

  describe("agent commit diagnostics (#11931)", () => {
    it("logs the winning process once when a tree-sourced agent commits", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "sh", command: "sh -c launch" }]);
      cache.setChildren(200, [
        { pid: 300, comm: "node", command: "node /opt/bin/opencode --api-key=do-not-log" },
      ]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-log",
        Date.now(),
        100,
        callback,
        cache as never,
        false
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();
      // A third agreeing poll must not log again — the commit already happened.
      cache.emitRefresh();

      const logs = agentCommitLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("agent=opencode");
      expect(logs[0]).toContain("evidence=process_tree");
      expect(logs[0]).toContain("match=argv");
      expect(logs[0]).toContain("pid=300");
      expect(logs[0]).toContain('comm="node"');
      expect(logs[0]).toContain('argv0="node"');
      expect(logs[0]).toContain("depth=2");
    });

    it("never puts raw argv in the log", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [
        { pid: 200, comm: "node", command: "node /opt/bin/opencode --api-key=sk-secret" },
      ]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-redaction",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      const [line] = agentCommitLogs();
      expect(line).toBeDefined();
      expect(line).not.toContain("sk-secret");
      expect(line).not.toContain("/opt/bin/opencode");
    });

    it("reports comm as the match source when the process names itself", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "opencode", command: "opencode" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-comm",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      const [line] = agentCommitLogs();
      expect(line).toContain("match=comm");
      expect(line).toContain("pid=200");
      expect(line).toContain("depth=1");
    });

    it("claims no process provenance for a shell-sourced commit", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm install" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-shell",
        Date.now(),
        100,
        callback,
        cache as never,
        false
      );
      detector.start();
      cache.emitRefresh();

      detector.injectShellCommandEvidence(
        { agentType: "opencode", processIconId: "opencode", processName: "opencode" },
        "opencode"
      );

      const [line] = agentCommitLogs();
      expect(line).toContain("agent=opencode");
      expect(line).toContain("evidence=shell_command");
      expect(line).toContain("match=<none>");
      expect(line).toContain("pid=<none>");
      expect(line).toContain("depth=<none>");
      expect(line).not.toContain("pid=200");
    });

    it("keeps tree provenance when both signals agree", () => {
      const cache = createCacheMock();
      // The wrapper must not name the agent itself, or it wins at depth 1 and
      // the walk never reaches the process this test is about.
      cache.setChildren(100, [{ pid: 200, comm: "sh", command: "sh -c launch" }]);
      cache.setChildren(200, [{ pid: 300, comm: "node", command: "node /opt/bin/opencode" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-both",
        Date.now(),
        100,
        callback,
        cache as never,
        false
      );
      detector.injectShellCommandEvidence(
        { agentType: "opencode", processIconId: "opencode", processName: "opencode" },
        "opencode"
      );
      detector.start();
      cache.emitRefresh();

      const [line] = agentCommitLogs();
      expect(line).toContain("evidence=both");
      expect(line).toContain("pid=300");
      expect(line).toContain("depth=2");
    });

    it("names the image path when that is what identified the process", () => {
      // The #8790 shape: the CLI rewrote comm and argv, and only the on-disk
      // binary still says what it is.
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "Ask anything", command: "Ask anything" }]);
      const imagePathProbe = {
        readBasename: vi.fn((pid: number) => (pid === 200 ? "opencode" : null)),
        evict: vi.fn(),
        dispose: vi.fn(),
      };
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-image",
        Date.now(),
        100,
        callback,
        cache as never,
        true,
        imagePathProbe as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      const [line] = agentCommitLogs();
      expect(line).toContain("agent=opencode");
      expect(line).toContain("match=image_path");
      expect(line).toContain("pid=200");
    });

    it("does not leak a Windows path through the redacted argv0", () => {
      // `splitShellLikeCommand` eats backslashes as escapes, which would flatten
      // the path into one separator-less token and persist the whole thing —
      // home directory and project name included — to the log file.
      const cache = createCacheMock();
      cache.setChildren(100, [
        {
          pid: 200,
          comm: "opencode.cmd",
          command: '"C:\\Users\\alice\\secret-project\\opencode.cmd" --resume',
        },
      ]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-winpath",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      const [line] = agentCommitLogs();
      expect(line).toContain('argv0="opencode.cmd"');
      expect(line).not.toContain("alice");
      expect(line).not.toContain("secret-project");
    });

    it("does not log an agent commit for a non-agent icon", () => {
      const cache = createCacheMock();
      cache.setChildren(100, [{ pid: 200, comm: "npm", command: "npm install" }]);
      const callback = vi.fn();

      const detector = new ProcessDetector(
        "terminal-commit-icon-only",
        Date.now(),
        100,
        callback,
        cache as never
      );
      detector.start();
      cache.emitRefresh();
      cache.emitRefresh();

      // npm committed — the detector ran and reached a verdict; it just was
      // not an agent, so nothing is logged.
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ processIconId: "npm", isBusy: true }),
        expect.any(Number)
      );
      expect(agentCommitLogs()).toHaveLength(0);
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

describe("executable position bounds (#11931)", () => {
  const agentPath = "/repo/shared/config/agents/opencode.ts";

  it("allows only argv[0] for a command that takes file operands", () => {
    expect(executablePositionLimit(["cat", "opencode"])).toBe(0);
    expect(executablePositionLimit(["nvim", "opencode"])).toBe(0);
    expect(executablePositionLimit(["git", "log", "opencode"])).toBe(0);
  });

  it("allows argv[1] for shells, runtimes, package managers and prefixes", () => {
    for (const executor of ["sh", "node", "python3", "npx", "bunx", "env", "sudo", "mise"]) {
      expect(executablePositionLimit([executor, "opencode"]), executor).toBe(1);
    }
  });

  it("allows argv[2] only behind a package manager's exec subcommand", () => {
    expect(executablePositionLimit(["pnpm", "exec", "opencode"])).toBe(2);
    expect(executablePositionLimit(["npm", "exec", "opencode"])).toBe(2);
    // `exec` after a non-executor is not a package-manager subcommand.
    expect(executablePositionLimit(["docker", "exec", "opencode"])).toBe(0);
    // `run` names a user-defined script, not a binary.
    expect(executablePositionLimit(["npm", "run", "opencode"])).toBe(1);
  });

  it("does not treat an inherited Object member as an executor", () => {
    expect(executablePositionLimit(["constructor", "opencode"])).toBe(0);
    expect(executablePositionLimit(["toString", "opencode"])).toBe(0);
  });

  it("stops detectCommandIdentity promoting an agent named by an argument", () => {
    // Compared against the same command over a neutral file: naming an agent
    // in an operand must change nothing about how the command resolves.
    for (const [agentArg, neutralArg] of [
      [`cat ${agentPath}`, "cat /repo/README.md"],
      [`git log -- ${agentPath}`, "git log -- /repo/README.md"],
      [`nvim ${agentPath}`, "nvim /repo/README.md"],
      ["npm run opencode", "npm run build"],
      ["uv run opencode", "uv run build"],
    ]) {
      expect(detectCommandIdentity(agentArg), agentArg).toEqual(detectCommandIdentity(neutralArg));
    }
  });

  it("keeps every supported agent launch form resolving", () => {
    for (const command of [
      "opencode --continue",
      "/Users/me/.local/bin/opencode",
      "node /opt/bin/opencode",
      "npx opencode",
      "bunx opencode",
      "pnpm exec opencode",
      "npm exec -- opencode",
      "sh -c opencode",
      "env FOO=bar opencode",
      "sudo opencode",
    ]) {
      expect(detectCommandIdentity(command)?.agentType, command).toBe("opencode");
    }
  });

  it("stops buildDetectedCandidate branding a file-reading process", () => {
    expect(buildDetectedCandidate("cat", `cat ${agentPath}`, 0)).toBeNull();
    // Neovim keeps whatever identity it has over any other file; opening an
    // agent-named one just does not change it.
    const identityOf = (command: string) => {
      const candidate = buildDetectedCandidate("nvim", command, 0);
      expect(candidate, command).not.toBeNull();
      return {
        agentType: candidate?.agentType,
        processIconId: candidate?.processIconId,
        processName: candidate?.processName,
      };
    };
    expect(identityOf(`nvim ${agentPath}`)).toEqual(identityOf("nvim /repo/README.md"));
  });

  it("records where the winning name was read from", () => {
    const origin = { pid: 42, depth: 3, comm: "node", source: "comm" } as const;
    expect(buildDetectedCandidate("node", "node /opt/bin/opencode", 0, origin)?.provenance).toEqual(
      { pid: 42, depth: 3, comm: "node", matchSource: "argv" }
    );
    expect(
      buildDetectedCandidate("opencode", "opencode", 0, { ...origin, comm: "opencode" })?.provenance
        ?.matchSource
    ).toBe("comm");
    expect(
      buildDetectedCandidate("opencode", "Claude Code", 0, { ...origin, source: "image_path" })
        ?.provenance?.matchSource
    ).toBe("image_path");
  });

  it("omits provenance when no origin is supplied", () => {
    const candidate = buildDetectedCandidate("opencode", "opencode", 0);
    expect(candidate).not.toBeNull();
    expect(candidate?.provenance).toBeUndefined();
  });
});

describe("agent CLI name aliases", () => {
  it("registers no alias that does not name its own agent", () => {
    // The invariant, not a copy of any list: every registered name must carry
    // its agent's id or command as a token. `@ampcode/cli` yielded the bare
    // alias `cli`, which made every Node CLI launched as `node …/cli.js` — the
    // Electron launcher `npx electron .` runs included — an Amp terminal. #11931
    for (const [alias, agentId] of Object.entries(AGENT_CLI_NAMES)) {
      const command = AGENT_REGISTRY[agentId].command.toLowerCase();
      const lowerAlias = alias.toLowerCase();
      const lowerId = agentId.toLowerCase();
      const tokens = lowerAlias.split(/[^a-z0-9]+/);
      const namesItsAgent =
        lowerAlias === lowerId ||
        lowerAlias === command ||
        tokens.includes(lowerId) ||
        tokens.includes(command);
      expect(namesItsAgent, `${alias} -> ${agentId}`).toBe(true);
    }
  });

  it("keeps every agent reachable by its own command and id", () => {
    for (const [agentId, config] of Object.entries(AGENT_REGISTRY)) {
      expect(AGENT_CLI_NAMES[config.command], config.command).toBe(agentId);
      expect(AGENT_CLI_NAMES[agentId], agentId).toBe(agentId);
    }
  });

  it("does not resolve an agent from a generic Node CLI entry point", () => {
    // The end-to-end shape of the `cli` regression, through the real registry.
    expect(detectCommandIdentity("node /repo/node_modules/electron/cli.js .")).toEqual(
      detectCommandIdentity("node /repo/node_modules/electron/launcher.js .")
    );
    expect(detectCommandIdentity("node /repo/node_modules/electron/cli.js .")?.agentType).toBe(
      undefined
    );
  });
});

describe("redactArgv", () => {
  it("reduces a launch path to its basename on both platforms", () => {
    expect(redactArgv('"C:\\Users\\alice\\secret-project\\opencode.cmd" --resume')).toBe(
      '"opencode.cmd"'
    );
    expect(redactArgv("/Users/alice/secret-project/opencode --resume")).toBe('"opencode"');
    // A quote groups the token, it does not end it.
    expect(redactArgv("'/Users/alice/secret-project'/opencode --resume")).toBe('"opencode"');
  });

  it("emits nothing rather than guess at unbalanced quoting", () => {
    // Returning the remainder here is how an inline secret reaches the log.
    expect(redactArgv('"C:\\Users\\alice\\opencode.cmd --api-key=sk-secret')).toBe("");
    expect(redactArgv("'/Users/alice/opencode --api-key=sk-secret")).toBe("");
  });

  it("never carries anything past argv[0]", () => {
    for (const command of [
      "opencode --api-key=sk-secret",
      '"/opt/bin/opencode" --api-key=sk-secret',
      "node /opt/bin/opencode --api-key=sk-secret",
    ]) {
      expect(redactArgv(command), command).not.toContain("sk-secret");
    }
  });

  it("returns nothing for empty input", () => {
    expect(redactArgv(undefined)).toBe("");
    expect(redactArgv("")).toBe("");
    expect(redactArgv("   ")).toBe("");
  });
});

describe("isChromiumChildProcess", () => {
  it("recognizes Chromium's own helper processes", () => {
    for (const command of [
      '"/Applications/Daintree.app/Contents/MacOS/Daintree Helper" --type=utility --utility-sub-type=node.mojom.NodeService',
      "/opt/app/electron --type=renderer --lang=en-GB",
      "/opt/app/electron --type=gpu-process",
      "/opt/app/electron --type=zygote",
      "/opt/app/electron --type=sandbox-ipc",
      "/opt/app/electron --type=crashpad-handler",
    ]) {
      expect(isChromiumChildProcess(command), command).toBe(true);
    }
  });

  it("treats the switch alone as sufficient, by design", () => {
    // A non-Chromium process taking an exact `--type=utility` loses its
    // subtree. That is the accepted cost of never missing a real boundary —
    // a false negative here is the nested-instance bug returning. #11931
    expect(isChromiumChildProcess("node orchestrator.js --type=utility")).toBe(true);
  });

  it("ignores unrelated, partial or operand `--type=` text", () => {
    for (const command of [
      "jq --type=json .",
      "mytool --type=utility-worker",
      "mytool prefix--type=utility",
      "cat /opt/notes/--type=utility.txt",
      "mytool -- --type=utility",
      "opencode",
      undefined,
    ]) {
      expect(isChromiumChildProcess(command), String(command)).toBe(false);
    }
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

  it("prefers the tool a package manager is executing over the package manager", () => {
    // The shell-observation path is a separate implementation from the
    // process-tree walk and has to make the same call. #11612
    expect(detectCommandIdentity("npx vitest --watch")).toMatchObject({
      processIconId: "vitest",
      processName: "vitest",
    });
  });

  it("keeps the package manager when its argument is a script name, not a tool", () => {
    expect(detectCommandIdentity("npm run docker")).toMatchObject({
      processIconId: "npm",
      processName: "npm",
    });
  });

  it("looks past an exec subcommand, which names a binary rather than a script", () => {
    expect(detectCommandIdentity("pnpm exec vitest --watch")).toMatchObject({
      processIconId: "vitest",
      processName: "vitest",
    });
    expect(detectCommandIdentity("pnpm dlx prisma migrate dev")).toMatchObject({
      processIconId: "prisma",
    });
  });

  it("keeps an agent ahead of any tool named later in the command", () => {
    expect(detectCommandIdentity("npx claude --resume")).toMatchObject({
      agentType: "claude",
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

describe("plugin-contributed process detections (#11613)", () => {
  beforeEach(() => {
    clearPluginProcessToolRegistryForTests();
  });

  afterEach(() => {
    clearPluginProcessToolRegistryForTests();
  });

  function runTreeDetection(terminalId: string) {
    const cache = createCacheMock();
    cache.setChildren(100, [
      { pid: 200, comm: "acme-cli", command: "/usr/local/bin/acme-cli run" },
    ]);
    const callback = vi.fn();
    const detector = new ProcessDetector(terminalId, Date.now(), 100, callback, cache as never);
    detector.start();
    cache.emitRefresh();
    detector.stop();
    return callback;
  }

  it("detects a plugin-contributed command from the process tree", () => {
    // Nothing resolves before the registry is mirrored in — the same tree, run
    // twice, is what isolates the registry as the cause.
    expect(runTreeDetection("t-plugin-before")).toHaveBeenCalledWith(
      expect.objectContaining({ detected: false }),
      expect.any(Number)
    );

    setPluginProcessToolRegistry({ "acme-cli": "sparkles" });

    expect(runTreeDetection("t-plugin-after")).toHaveBeenCalledWith(
      expect.objectContaining({ detected: true, processIconId: "sparkles" }),
      expect.any(Number)
    );
  });

  it("resolves a plugin-contributed command from a shell command line", () => {
    expect(detectCommandIdentity("acme-cli serve --port 3000")).toBeNull();

    setPluginProcessToolRegistry({ "acme-cli": "sparkles" });

    expect(detectCommandIdentity("acme-cli serve --port 3000")).toEqual({
      processIconId: "sparkles",
      processName: "acme-cli",
    });
  });

  it("stops resolving once the plugin's entry is mirrored away", () => {
    setPluginProcessToolRegistry({ "acme-cli": "sparkles" });
    expect(detectCommandIdentity("acme-cli serve")).not.toBeNull();

    // Proves the merged map tracks the snapshot rather than caching a stale
    // module-level const built at import time.
    setPluginProcessToolRegistry({});
    expect(detectCommandIdentity("acme-cli serve")).toBeNull();
  });

  it("keeps built-in tools winning over a colliding plugin command", () => {
    // Compare against the pre-injection result rather than Vite's literal icon
    // id: the invariant under test is that a colliding plugin entry changes
    // nothing, not what Vite happens to be called.
    const builtIn = detectCommandIdentity("vite build")?.processIconId;
    expect(builtIn).toBeDefined();

    setPluginProcessToolRegistry({ vite: "sparkles" });

    expect(detectCommandIdentity("vite build")?.processIconId).toBe(builtIn);
  });

  it("keeps built-in agents winning over a colliding plugin command", () => {
    const [agentCommand, agentId] = Object.entries(AGENT_CLI_NAMES)[0];
    setPluginProcessToolRegistry({ [agentCommand]: "sparkles" });

    const identity = detectCommandIdentity(`${agentCommand} --help`);
    expect(identity?.agentType).toBe(agentId);
    expect(identity?.processIconId).not.toBe("sparkles");
  });

  it("ranks a plugin detection at tool tier, so it beats a package manager host", () => {
    setPluginProcessToolRegistry({ "acme-cli": "sparkles" });
    // `npm` is package-manager tier and loses to anything more specific.
    expect(detectCommandIdentity("npm exec acme-cli")?.processIconId).toBe("sparkles");
  });

  it("never resolves an inherited Object member as a detection", () => {
    // Both lookup tables are null-prototype (`registries.ts`) precisely so a
    // process literally named `constructor`/`toString` indexes nothing instead
    // of hitting an inherited function and being reported as a detected agent.
    for (const name of ["constructor", "toString", "valueOf"]) {
      expect(buildDetectedCandidate(name, undefined, 0), name).toBeNull();
    }

    setPluginProcessToolRegistry({ "acme-cli": "sparkles" });

    // The merged map is rebuilt from the plugin snapshot here — proven by the
    // plugin command resolving — so the nulls below are the prototype guard
    // holding across the rebuild, not a registry that was never populated.
    expect(buildDetectedCandidate("acme-cli", undefined, 0)).not.toBeNull();
    for (const name of ["constructor", "toString", "valueOf"]) {
      expect(buildDetectedCandidate(name, undefined, 0), name).toBeNull();
    }
  });
});
