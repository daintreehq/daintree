import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { PluginMcpSupervisor, TOOLS_LIST_MAX_PAGES } from "../PluginMcpSupervisor.js";
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

  function lastCallMethod(): string | undefined {
    const last = stdinLines.at(-1);
    if (!last) return undefined;
    try {
      return (JSON.parse(last) as { method?: string }).method;
    } catch {
      return undefined;
    }
  }

  function lastCallParams(): Record<string, unknown> | undefined {
    const last = stdinLines.at(-1);
    if (!last) return undefined;
    try {
      return (JSON.parse(last) as { params?: Record<string, unknown> }).params;
    } catch {
      return undefined;
    }
  }

  return {
    subprocess,
    handle,
    waitForStdinCount,
    answerInitialize,
    answerLastCall,
    answerLastCallWithError,
    readStdinLines,
    lastCallMethod,
    lastCallParams,
    emitStderr(line: string) {
      stderr.write(line);
    },
    /** Write a raw JSON-RPC message (e.g. a server notification) onto stdout. */
    emitStdout(message: unknown) {
      stdout.write(JSON.stringify(message) + "\n");
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

describe("PluginMcpSupervisor lazy tool discovery (issue #9235)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const CONTRIBUTION = { id: "linear", name: "Linear", command: "node" };

  /** Spawn one server and drive it to `ready`. */
  async function startReady(
    supervisor: PluginMcpSupervisor,
    fake: ReturnType<typeof makeFakeSubprocess>
  ): Promise<void> {
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [CONTRIBUTION],
      resolveSettings: async () => "",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;
  }

  it("resolves a concurrent first-call enumeration that races the lazy spawn", async () => {
    // Regression for the readyPromise-null window: enumerate while the server is
    // still "spawning" (readyPromise not yet assigned). The call must await the
    // in-flight start rather than fast-failing with NOT_READY.
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });

    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [CONTRIBUTION],
      resolveSettings: async () => "",
    });
    // Enumerate immediately — before the handshake completes.
    const listPromise = supervisor.listTools("acme.demo", "linear");

    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await startPromise;
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });

    const result = await listPromise;
    expect(result.tools.map((t) => t.name)).toEqual(["a"]);
  });

  it("does not repopulate the cache when list_changed arrives mid-fetch", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const first = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    // Invalidation lands while the tools/list request is still in flight.
    fake.emitStdout({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await flushMicrotasks();
    // The now-superseded request resolves with the OLD data.
    fake.answerLastCall({ tools: [{ name: "old", inputSchema: {} }] });
    await first;

    // The cache must NOT hold the old data — the next call refetches.
    const second = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(4);
    expect(fake.lastCallMethod()).toBe("tools/list");
    fake.answerLastCall({ tools: [{ name: "fresh", inputSchema: {} }] });
    expect((await second).tools.map((t) => t.name)).toEqual(["fresh"]);
  });

  it("rejects a tools/list that pages past the pagination guard", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const listPromise = supervisor.listTools("acme.demo", "linear");
    listPromise.catch(() => {});
    // Always hand back the same non-empty cursor so the loop never terminates
    // on its own — it must bail out at the page guard.
    for (let i = 0; i < TOOLS_LIST_MAX_PAGES; i++) {
      await fake.waitForStdinCount(3 + i);
      fake.answerLastCall({ tools: [{ name: `t${i}`, inputSchema: {} }], nextCursor: "loop" });
    }
    await expect(listPromise).rejects.toMatchObject({ code: "TOOLS_LIST_PAGINATION" });
  });

  it("releases a stopped server's slice of the global cap budget on shutdown", async () => {
    const fakes = [makeFakeSubprocess({ pid: 1 }), makeFakeSubprocess({ pid: 2 })];
    let nth = 0;
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fakes[nth++]!.handle,
      killTree: () => {},
    });
    const startA = supervisor.start({
      pluginId: "acme.a",
      contributions: [{ id: "s", name: "S", command: "node" }],
      resolveSettings: async () => "",
    });
    await fakes[0]!.waitForStdinCount(1);
    fakes[0]!.answerInitialize();
    await startA;
    const startB = supervisor.start({
      pluginId: "acme.b",
      contributions: [{ id: "s", name: "S", command: "node" }],
      resolveSettings: async () => "",
    });
    await fakes[1]!.waitForStdinCount(1);
    fakes[1]!.answerInitialize();
    await startB;

    // A surfaces 2 of a budget of 3.
    const aPromise = supervisor.listTools("acme.a", "s", 3);
    await fakes[0]!.waitForStdinCount(3);
    fakes[0]!.answerLastCall({
      tools: [
        { name: "a1", inputSchema: {} },
        { name: "a2", inputSchema: {} },
      ],
    });
    await aPromise;

    // Shut A down — its budget slice must be released.
    await supervisor.shutdown({ pluginId: "acme.a" });

    // B now sees the FULL budget of 3, not the leftover 1.
    const bPromise = supervisor.listTools("acme.b", "s", 3);
    await fakes[1]!.waitForStdinCount(3);
    fakes[1]!.answerLastCall({
      tools: [
        { name: "b1", inputSchema: {} },
        { name: "b2", inputSchema: {} },
        { name: "b3", inputSchema: {} },
      ],
    });
    const bResult = await bPromise;
    expect(bResult.tools.map((t) => t.name)).toEqual(["b1", "b2", "b3"]);
    expect(bResult.truncated).toBe(false);
  });

  it("fetches tools/list on first enumeration and returns tier-1 summaries without schemas", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const longDescription = "x".repeat(250);
    const listPromise = supervisor.listTools("acme.demo", "linear");
    // initialize + notifications/initialized + tools/list = 3 frames.
    await fake.waitForStdinCount(3);
    expect(fake.lastCallMethod()).toBe("tools/list");
    expect(fake.lastCallParams()).toEqual({});
    fake.answerLastCall({
      tools: [
        { name: "getIssue", description: "Fetch an issue", inputSchema: { type: "object" } },
        { name: "verbose", description: longDescription, inputSchema: { type: "object" } },
      ],
    });

    const result = await listPromise;
    expect(result.tools).toEqual([
      { name: "getIssue", description: "Fetch an issue" },
      { name: "verbose", description: `${"x".repeat(200)}…` },
    ]);
    // Tier-1 must not leak the input schema.
    for (const tool of result.tools) {
      expect(tool).not.toHaveProperty("inputSchema");
    }
    expect(result.truncated).toBe(false);
    expect(result.maxToolsPerSession).toBe(200);
  });

  it("follows the tools/list pagination cursor across pages", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const listPromise = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    expect(fake.lastCallParams()).toEqual({});
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }], nextCursor: "cursor-2" });

    await fake.waitForStdinCount(4);
    expect(fake.lastCallMethod()).toBe("tools/list");
    expect(fake.lastCallParams()).toEqual({ cursor: "cursor-2" });
    fake.answerLastCall({ tools: [{ name: "b", inputSchema: {} }] });

    const result = await listPromise;
    expect(result.tools.map((t) => t.name)).toEqual(["a", "b"]);
    // No third page requested.
    expect(fake.readStdinLines()).toHaveLength(4);
  });

  it("serves the cached tool list on the second enumeration without a refetch", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const first = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });
    await first;

    const second = await supervisor.listTools("acme.demo", "linear");
    expect(second.tools.map((t) => t.name)).toEqual(["a"]);
    // Still only 3 frames: no second tools/list went out.
    expect(fake.readStdinLines()).toHaveLength(3);
  });

  it("deduplicates concurrent enumerations into one tools/list round (singleflight)", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const p1 = supervisor.listTools("acme.demo", "linear");
    const p2 = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.tools.map((t) => t.name)).toEqual(["a"]);
    expect(r2.tools.map((t) => t.name)).toEqual(["a"]);
    // One tools/list frame only.
    expect(fake.readStdinLines()).toHaveLength(3);
  });

  it("returns the full tool definition from getFullSchema, or not-found for an unknown name", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const schemaPromise = supervisor.getFullSchema("acme.demo", "linear", "getIssue");
    await fake.waitForStdinCount(3);
    fake.answerLastCall({
      tools: [
        {
          name: "getIssue",
          description: "Fetch an issue",
          inputSchema: { type: "object", properties: { id: { type: "string" } } },
          annotations: { readOnly: true },
        },
      ],
    });
    const hit = await schemaPromise;
    expect(hit).toEqual({
      found: true,
      tool: {
        name: "getIssue",
        description: "Fetch an issue",
        inputSchema: { type: "object", properties: { id: { type: "string" } } },
        annotations: { readOnly: true },
      },
    });

    // Second lookup hits the cache (no new frame) and misses on an unknown name.
    const miss = await supervisor.getFullSchema("acme.demo", "linear", "nope");
    expect(miss).toEqual({ found: false });
    expect(fake.readStdinLines()).toHaveLength(3);
  });

  it("invalidates the cache on a notifications/tools/list_changed and refetches", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const first = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });
    await first;

    fake.emitStdout({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    await flushMicrotasks();

    const second = supervisor.listTools("acme.demo", "linear");
    // Cache was dropped — a fresh tools/list goes out (frame 4).
    await fake.waitForStdinCount(4);
    expect(fake.lastCallMethod()).toBe("tools/list");
    fake.answerLastCall({
      tools: [
        { name: "a", inputSchema: {} },
        { name: "b", inputSchema: {} },
      ],
    });
    const result = await second;
    expect(result.tools.map((t) => t.name)).toEqual(["a", "b"]);
  });

  it("ignores unrelated notifications and keeps the cache", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const first = supervisor.listTools("acme.demo", "linear");
    await fake.waitForStdinCount(3);
    fake.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });
    await first;

    fake.emitStdout({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    await flushMicrotasks();

    const second = await supervisor.listTools("acme.demo", "linear");
    expect(second.tools.map((t) => t.name)).toEqual(["a"]);
    // Cache survived — no refetch.
    expect(fake.readStdinLines()).toHaveLength(3);
  });

  it("invalidates the cache on crash and refetches after restart", async () => {
    const fakes = [makeFakeSubprocess({ pid: 1 }), makeFakeSubprocess({ pid: 2 })];
    let nth = 0;
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fakes[nth++]!.handle,
      killTree: () => {},
    });
    await startReady(supervisor, fakes[0]!);

    const first = supervisor.listTools("acme.demo", "linear");
    await fakes[0]!.waitForStdinCount(3);
    fakes[0]!.answerLastCall({ tools: [{ name: "a", inputSchema: {} }] });
    await first;

    // Crash the server: cache must be dropped.
    fakes[0]!.closeStdout();
    await flushMicrotasks();
    expect(supervisor.list()[0]?.status).toBe("crashed");

    // Restart and enumerate again — a fresh tools/list must go out on the new
    // subprocess (the cache did not survive the crash).
    const restartPromise = supervisor.restart({
      pluginId: "acme.demo",
      serverId: "linear",
      contribution: CONTRIBUTION,
      resolveSettings: async () => "",
    });
    await fakes[1]!.waitForStdinCount(1);
    fakes[1]!.answerInitialize();
    await restartPromise;

    const second = supervisor.listTools("acme.demo", "linear");
    await fakes[1]!.waitForStdinCount(3);
    expect(fakes[1]!.lastCallMethod()).toBe("tools/list");
    fakes[1]!.answerLastCall({ tools: [{ name: "b", inputSchema: {} }] });
    const result = await second;
    expect(result.tools.map((t) => t.name)).toEqual(["b"]);
  });

  it("rejects an in-flight enumeration when the server crashes mid-fetch and recovers after restart", async () => {
    const fakes = [makeFakeSubprocess({ pid: 1 }), makeFakeSubprocess({ pid: 2 })];
    let nth = 0;
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fakes[nth++]!.handle,
      killTree: () => {},
    });
    await startReady(supervisor, fakes[0]!);

    const pending = supervisor.listTools("acme.demo", "linear");
    pending.catch(() => {});
    await fakes[0]!.waitForStdinCount(3);
    // Crash before answering tools/list.
    fakes[0]!.closeStdout();
    await flushMicrotasks();
    await expect(pending).rejects.toThrow();

    // The inflight guard must have cleared so a post-restart enumeration runs.
    const restartPromise = supervisor.restart({
      pluginId: "acme.demo",
      serverId: "linear",
      contribution: CONTRIBUTION,
      resolveSettings: async () => "",
    });
    await fakes[1]!.waitForStdinCount(1);
    fakes[1]!.answerInitialize();
    await restartPromise;

    const recovered = supervisor.listTools("acme.demo", "linear");
    await fakes[1]!.waitForStdinCount(3);
    fakes[1]!.answerLastCall({ tools: [{ name: "ok", inputSchema: {} }] });
    expect((await recovered).tools.map((t) => t.name)).toEqual(["ok"]);
  });

  it("enforces the global tool cap and reports truncation", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({ spawner: () => fake.handle, killTree: () => {} });
    await startReady(supervisor, fake);

    const listPromise = supervisor.listTools("acme.demo", "linear", 2);
    await fake.waitForStdinCount(3);
    fake.answerLastCall({
      tools: [
        { name: "a", inputSchema: {} },
        { name: "b", inputSchema: {} },
        { name: "c", inputSchema: {} },
      ],
    });
    const result = await listPromise;
    expect(result.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
    expect(result.maxToolsPerSession).toBe(2);
  });

  it("spreads the global cap budget across multiple servers", async () => {
    const fakes = [makeFakeSubprocess({ pid: 1 }), makeFakeSubprocess({ pid: 2 })];
    let nth = 0;
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fakes[nth++]!.handle,
      killTree: () => {},
    });
    const startPromise = supervisor.start({
      pluginId: "acme.demo",
      contributions: [
        { id: "linear", name: "Linear", command: "node" },
        { id: "github", name: "GitHub", command: "node" },
      ],
      resolveSettings: async () => "",
    });
    await fakes[0]!.waitForStdinCount(1);
    fakes[0]!.answerInitialize();
    await fakes[1]!.waitForStdinCount(1);
    fakes[1]!.answerInitialize();
    await startPromise;

    // First server surfaces 2 of its 2 tools (budget 3 → remaining 3).
    const firstPromise = supervisor.listTools("acme.demo", "linear", 3);
    await fakes[0]!.waitForStdinCount(3);
    fakes[0]!.answerLastCall({
      tools: [
        { name: "l1", inputSchema: {} },
        { name: "l2", inputSchema: {} },
      ],
    });
    const first = await firstPromise;
    expect(first.tools.map((t) => t.name)).toEqual(["l1", "l2"]);
    expect(first.truncated).toBe(false);

    // Second server only has 1 slot of budget left (3 - 2 already surfaced).
    const secondPromise = supervisor.listTools("acme.demo", "github", 3);
    await fakes[1]!.waitForStdinCount(3);
    fakes[1]!.answerLastCall({
      tools: [
        { name: "g1", inputSchema: {} },
        { name: "g2", inputSchema: {} },
      ],
    });
    const second = await secondPromise;
    expect(second.tools.map((t) => t.name)).toEqual(["g1"]);
    expect(second.truncated).toBe(true);
  });
});

describe("PluginMcpSupervisor.notifySettingChanged (issue #10619)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start one server referencing `${settings:apiToken}` in env and drive it to `ready`. */
  async function startReadyServer() {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const contribution = {
      id: "linear",
      name: "Linear",
      command: "node",
      env: { TOKEN: "${settings:apiToken}" },
    };
    const start = supervisor.start({
      pluginId: "acme.demo",
      contributions: [contribution],
      resolveSettings: async () => "old-secret",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await start;
    expect(supervisor.list()[0]?.status).toBe("ready");
    return { supervisor, fake };
  }

  it("restarts a ready server referencing the changed setting after the debounce window", async () => {
    const { supervisor } = await startReadyServer();
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "apiToken", restart);
    // Debounced — nothing fires synchronously.
    expect(restart).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("linear");
  });

  it("does not restart when the changed setting is not referenced", async () => {
    const { supervisor } = await startReadyServer();
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "unrelatedKey", restart);
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("restarts a server exactly once when one of its several referenced settings changes", async () => {
    const fake = makeFakeSubprocess();
    const supervisor = new PluginMcpSupervisor({
      spawner: () => fake.handle,
      killTree: () => {},
    });
    const start = supervisor.start({
      pluginId: "acme.demo",
      contributions: [
        {
          id: "linear",
          name: "Linear",
          command: "node",
          env: { A: "${settings:keyA}", B: "${settings:keyB}" },
        },
      ],
      resolveSettings: async () => "v",
    });
    await fake.waitForStdinCount(1);
    fake.answerInitialize();
    await start;
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "keyA", restart);
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart).toHaveBeenCalledWith("linear");
  });

  it("does not restart a server for a different plugin", async () => {
    const { supervisor } = await startReadyServer();
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("other.plugin", "apiToken", restart);
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("coalesces a burst of changes into a single restart", async () => {
    const { supervisor } = await startReadyServer();
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "apiToken", restart);
    vi.advanceTimersByTime(500);
    supervisor.notifySettingChanged("acme.demo", "apiToken", restart);
    vi.advanceTimersByTime(500);
    // The second change reset the debounce, so 1000ms total hasn't elapsed
    // since it — no restart yet.
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart a stopped (lazy-unstarted / torn-down) server", async () => {
    const { supervisor } = await startReadyServer();
    await supervisor.shutdown({ pluginId: "acme.demo" });
    expect(supervisor.list()[0]?.status).toBe("stopped");
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "apiToken", restart);
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
  });

  it("cancels a pending restart when the server is shut down before the debounce fires", async () => {
    const { supervisor } = await startReadyServer();
    const restart = vi.fn();

    vi.useFakeTimers();
    supervisor.notifySettingChanged("acme.demo", "apiToken", restart);
    vi.advanceTimersByTime(500);
    // Shutdown clears the pending debounce timer; switch back to real timers so
    // shutdown's own async teardown can settle.
    vi.useRealTimers();
    await supervisor.shutdown({ pluginId: "acme.demo" });

    vi.useFakeTimers();
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
  });
});
