import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { PluginMcpSupervisor } from "../PluginMcpSupervisor.js";
import { PLUGIN_MCP_STDERR_RING_LINES } from "../../../shared/types/ipc/pluginMcp.js";

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/**
 * Fake stdio MCP server. The supervisor talks to it via writable stdin and
 * readable stdout/stderr just like a real execa subprocess; tests drive
 * server-side behavior by writing into the stdout passthrough.
 */
function makeFakeSubprocess(opts?: { pid?: number }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;

  const stdinLines: string[] = [];
  let stdinBuffer = "";
  let stdinResolvers: Array<() => void> = [];
  stdin.on("data", (chunk: Buffer) => {
    stdinBuffer += chunk.toString("utf-8");
    for (;;) {
      const i = stdinBuffer.indexOf("\n");
      if (i < 0) break;
      stdinLines.push(stdinBuffer.slice(0, i));
      stdinBuffer = stdinBuffer.slice(i + 1);
    }
    const resolvers = stdinResolvers;
    stdinResolvers = [];
    for (const r of resolvers) r();
  });

  let exitResolve!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });

  const subprocess = {
    pid: opts?.pid ?? 12345,
    stdin,
    stdout,
    stderr,
    kill() {
      if (killed) return true;
      killed = true;
      stdout.end();
      stderr.end();
      exitResolve();
      return true;
    },
  };
  const handle = { subprocess, exit: exitPromise as Promise<unknown> };

  async function waitForStdinCount(target: number): Promise<void> {
    while (stdinLines.length < target) {
      await new Promise<void>((r) => {
        stdinResolvers.push(r);
      });
    }
  }

  function answerInitialize(): void {
    stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} },
      }) + "\n"
    );
  }

  function answerLastCall(value: unknown): void {
    const last = stdinLines.at(-1);
    if (!last) return;
    const parsed = JSON.parse(last) as { id?: number };
    if (typeof parsed.id !== "number") return;
    stdout.write(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: value }) + "\n");
  }

  function answerLastCallWithError(message: string): void {
    const last = stdinLines.at(-1);
    if (!last) return;
    const parsed = JSON.parse(last) as { id?: number };
    if (typeof parsed.id !== "number") return;
    stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message } }) + "\n"
    );
  }

  function readStdinLines(): string[] {
    return [...stdinLines];
  }

  return {
    subprocess,
    handle,
    waitForStdinCount,
    answerInitialize,
    answerLastCall,
    answerLastCallWithError,
    readStdinLines,
    emitStderr(line: string) {
      stderr.write(line);
    },
    closeStdout() {
      stdout.end();
    },
    get killed() {
      return killed;
    },
  };
}

describe("PluginMcpSupervisor (issue #9233)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes the initialize/initialized handshake and reaches ready", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    const lines = fake.readStdinLines();
    expect(lines).toHaveLength(2);
    const initialize = JSON.parse(lines[0]!) as Record<string, unknown>;
    const notification = JSON.parse(lines[1]!) as Record<string, unknown>;
    expect(initialize.method).toBe("initialize");
    expect(initialize.id).toBe(1);
    expect(notification.method).toBe("notifications/initialized");
    expect(notification).not.toHaveProperty("id");

    const [info] = supervisor.list();
    expect(info?.status).toBe("ready");
    expect(info?.lastError).toBeNull();
    expect(info?.pid).toBe(12345);
  });

  it("rejects tools/call before the server reaches ready with NOT_READY", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    void supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    // Wait until handshake is at least in flight (initialize on stdin) — at
    // which point the server is "spawning", not "ready".
    await fake.waitForStdinCount(1);

    await expect(
      supervisor.callTool({
        pluginId: "acme.demo",
        serverId: "linear",
        tool: "linear.getIssue",
      })
    ).rejects.toMatchObject({ code: "NOT_READY" });
  });

  it("routes tools/call results back to the caller", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    const callPromise = supervisor.callTool({
      pluginId: "acme.demo",
      serverId: "linear",
      tool: "linear.getIssue",
      args: { id: "ENG-1" },
    });
    // initialize + notifications/initialized + tools/call = 3 lines.
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ title: "An issue" });
    await expect(callPromise).resolves.toEqual({ title: "An issue" });
  });

  it("propagates server-reported tool errors as a rejected callTool", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    const callPromise = supervisor.callTool({
      pluginId: "acme.demo",
      serverId: "linear",
      tool: "linear.getIssue",
    });
    await fake.waitForStdinCount(3);
    fake.answerLastCallWithError("issue not found");
    await expect(callPromise).rejects.toThrow("issue not found");
  });

  it("caps stderr at PLUGIN_MCP_STDERR_RING_LINES and tracks totalLines", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    const overflow = PLUGIN_MCP_STDERR_RING_LINES + 50;
    for (let i = 0; i < overflow; i++) fake.emitStderr(`line ${i}\n`);
    await flushMicrotasks();

    const stderr = supervisor.getStderr("acme.demo", "linear");
    expect(stderr.lines).toHaveLength(PLUGIN_MCP_STDERR_RING_LINES);
    expect(stderr.lines[0]).toBe(`line ${overflow - PLUGIN_MCP_STDERR_RING_LINES}`);
    expect(stderr.totalLines).toBe(overflow);
  });

  it("substitutes ${settings:*} into command/args/env at spawn time", async () => {
    const fake = makeFakeSubprocess();
    const seen: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const supervisor = new PluginMcpSupervisor({
      spawner: (config) => {
        seen.push({ command: config.command, args: config.args, env: config.env });
        return fake.handle;
      },
      killTree: () => {},
    });
    const resolver = async (settingId: string) =>
      settingId === "linearToken" ? "lin_abc" : "/usr/bin/node";
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [
        {
          id: "linear",
          name: "Linear",
          command: "${settings:nodeBin}",
          args: ["-y", "@linear/mcp", "--token=${settings:linearToken}"],
          env: { LINEAR_TOKEN: "${settings:linearToken}" },
        },
      ],
      resolveSettings: resolver,
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.command).toBe("/usr/bin/node");
    expect(seen[0]!.args).toEqual(["-y", "@linear/mcp", "--token=lin_abc"]);
    expect(seen[0]!.env).toEqual({ LINEAR_TOKEN: "lin_abc" });
  });

  it("transitions to crashed and rejects pending calls when the subprocess exits unexpectedly", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    const callPromise = supervisor.callTool({
      pluginId: "acme.demo",
      serverId: "linear",
      tool: "linear.getIssue",
    });
    // Pre-attach a no-op catch so Node doesn't fire PromiseRejectionHandledWarning
    // when the test's `rejects.toThrow()` assertion settles asynchronously after
    // the close handler has already rejected the call.
    callPromise.catch(() => {});
    await fake.waitForStdinCount(3);
    fake.closeStdout();
    await flushMicrotasks();

    await expect(callPromise).rejects.toThrow();
    const [info] = supervisor.list();
    expect(info?.status).toBe("crashed");
    expect(info?.pid).toBeNull();
  });

  it("invokes the Windows tree-killer on shutdown", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    try {
      const fake = makeFakeSubprocess({ pid: 9876 });
      const killTree = vi.fn();
      const supervisor = new PluginMcpSupervisor({
        spawner: () => fake.handle,
        killTree,
      });
      const startPromise = supervisor.start({
        pluginId: "acme.demo",
        contributions: [{ id: "linear", name: "Linear", command: "node" }],
        resolveSettings: async () => "",
      });
      await fake.waitForStdinCount(1);
      fake.answerInitialize();
      await startPromise;

      vi.useFakeTimers();
      const shutdownPromise = supervisor.shutdown({ pluginId: "acme.demo" });
      await shutdownPromise;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killTree).toHaveBeenCalledWith(9876);

      const [info] = supervisor.list();
      expect(info?.status).toBe("stopped");
    } finally {
      vi.useRealTimers();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("does not invoke the tree-killer on POSIX", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    try {
      const fake = makeFakeSubprocess({ pid: 4242 });
      const killTree = vi.fn();
      const supervisor = new PluginMcpSupervisor({
        spawner: () => fake.handle,
        killTree,
      });
      const startPromise = supervisor.start({
        pluginId: "acme.demo",
        contributions: [{ id: "linear", name: "Linear", command: "node" }],
        resolveSettings: async () => "",
      });
      await fake.waitForStdinCount(1);
      fake.answerInitialize();
      await startPromise;

      vi.useFakeTimers();
      await supervisor.shutdown({ pluginId: "acme.demo" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(killTree).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("restart re-spawns and appends a restart marker to the stderr ring", async () => {
    const fakes = [makeFakeSubprocess({ pid: 1 }), makeFakeSubprocess({ pid: 2 })];
    let nth = 0;
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fakes[nth++]!.handle,
      killTree: () => {},
    });
    const contribution = { id: "linear", name: "Linear", command: "node" };
    const start = supervisor.start({
      pluginId: "acme.demo",
      contributions: [contribution],
      resolveSettings: async () => "",
    });
    await fakes[0]!.waitForStdinCount(1);
    fakes[0]!.answerInitialize();
    await start;
    fakes[0]!.emitStderr("pre-restart line\n");
    await flushMicrotasks();

    const restartPromise = supervisor.restart({
      pluginId: "acme.demo",
      serverId: "linear",
      contribution,
      resolveSettings: async () => "",
    });
    await fakes[1]!.waitForStdinCount(1);
    fakes[1]!.answerInitialize();
    await restartPromise;

    const stderr = supervisor.getStderr("acme.demo", "linear");
    expect(stderr.lines).toContain("pre-restart line");
    expect(stderr.lines.some((l) => l.startsWith("--- restarted at "))).toBe(true);
    const [info] = supervisor.list();
    expect(info?.status).toBe("ready");
    expect(info?.pid).toBe(2);
  });

  it("rejects ${settings:*} substitution failures without crashing activation", async () => {
    const supervisor = new PluginMcpSupervisor({
      spawner: () => makeFakeSubprocess().handle,
      killTree: () => {},
    });
    await supervisor.start({
      pluginId: "acme.demo",
      contributions: [
        {
          id: "broken",
          name: "Broken",
          command: "${settings:notFound}",
          args: ["-y"],
        },
      ],
      resolveSettings: async () => {
        throw new Error("vault unavailable");
      },
    });
    const [info] = supervisor.list();
    expect(info?.status).toBe("crashed");
    expect(info?.lastError).toContain("vault unavailable");
  });

  it("leaves status as 'stopped' when shutdown lands mid-handshake", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    // Wait for the initialize frame to be on the wire, then shutdown before
    // the server has a chance to answer.
    await fake.waitForStdinCount(1);
    await supervisor.shutdown({ pluginId: "acme.demo" });
    await startPromise;

    const [info] = supervisor.list();
    expect(info?.status).toBe("stopped");
    // No "crashed" leak on lastError either.
    expect(info?.lastError).toBeNull();
  });

  it("kills the previous subprocess when start() is called against a crashed entry", async () => {
    // Models the real leak: the handshake times out but the child process is
    // still alive (its streams are open). The state transitions to "crashed"
    // with state.subprocess still set. A subsequent start() must kill that
    // lingering subprocess before adopting the new one.
    vi.useFakeTimers();
    try {
      const fakes = [makeFakeSubprocess({ pid: 11 }), makeFakeSubprocess({ pid: 22 })];
      let nth = 0;
      const supervisor = new PluginMcpSupervisor({
        spawner: () => fakes[nth++]!.handle,
        killTree: () => {},
      });
      const contribution = { id: "linear", name: "Linear", command: "node" };
      const start1 = supervisor.start({
        pluginId: "acme.demo",
        contributions: [contribution],
        resolveSettings: async () => "",
      });
      // Let the spawn + handshake-write microtasks settle, then advance past
      // the 15s handshake timeout so runHandshake's catch flips to "crashed"
      // while the (fake) subprocess is still live.
      await vi.advanceTimersByTimeAsync(20_000);
      await start1;
      expect(supervisor.list()[0]?.status).toBe("crashed");
      expect(fakes[0]!.killed).toBe(false);

      vi.useRealTimers();
      const start2 = supervisor.start({
        pluginId: "acme.demo",
        contributions: [contribution],
        resolveSettings: async () => "",
      });
      await fakes[1]!.waitForStdinCount(1);
      fakes[1]!.answerInitialize();
      await start2;

      expect(fakes[0]!.killed).toBe(true);
      expect(supervisor.list()[0]?.status).toBe("ready");
      expect(supervisor.list()[0]?.pid).toBe(22);
    } finally {
      vi.useRealTimers();
    }
  });

  it("substitutes duplicate ${settings:*} occurrences across command/args/env", async () => {
    const fake = makeFakeSubprocess();
    const seen: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const supervisor = new PluginMcpSupervisor({
      spawner: (config) => {
        seen.push({ command: config.command, args: config.args, env: config.env });
        return fake.handle;
      },
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [
        {
          id: "dup",
          name: "Dup",
          command: "${settings:bin}",
          args: ["${settings:bin}", "--token=${settings:tok}", "--also=${settings:tok}"],
          env: { ONE: "${settings:tok}", TWO: "${settings:tok}" },
        },
      ],
      resolveSettings: async (settingId) => (settingId === "tok" ? "abc" : "/bin/node"),
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    expect(seen[0]!.command).toBe("/bin/node");
    expect(seen[0]!.args).toEqual(["/bin/node", "--token=abc", "--also=abc"]);
    expect(seen[0]!.env).toEqual({ ONE: "abc", TWO: "abc" });
  });

  it("forwards pluginDir as the spawner cwd", async () => {
    const fake = makeFakeSubprocess();
    let seenCwd: string | undefined;
    const supervisor = new PluginMcpSupervisor({
      spawner: (config) => {
        seenCwd = config.cwd;
        return fake.handle;
      },
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      pluginDir: "/plugins/acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "./dist/server.js" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    expect(seenCwd).toBe("/plugins/acme.demo");
  });

  it("rejects an in-flight callTool with WRITE_FAILED when stdin is closed", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [{ id: "linear", name: "Linear", command: "node" }],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;

    // Close stdin so the next write throws synchronously.
    fake.subprocess.stdin.end();
    const callPromise = supervisor.callTool({
      pluginId: "acme.demo",
      serverId: "linear",
      tool: "linear.getIssue",
    });
    callPromise.catch(() => {});
    await expect(callPromise).rejects.toMatchObject({ code: "WRITE_FAILED" });
  });
});
