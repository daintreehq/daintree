import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess, type TerminalProcessCallbacks } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import {
  GRACEFUL_SHUTDOWN_BUFFER_SIZE,
  GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS,
  GRACEFUL_SHUTDOWN_TIMEOUT_MS,
  IPC_HIGH_WATERMARK_PERCENT,
  IPC_MAX_QUEUE_BYTES,
} from "../types.js";
import { headlessMirrorScheduler } from "../HeadlessMirrorScheduler.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { PtyPauseCoordinator } from "../../../pty-host/PtyPauseCoordinator.js";
import { GracefulCaptureTracker } from "../../../pty-host/GracefulCaptureTracker.js";
import { IpcQueueManager } from "../../../pty-host/ipcQueue.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

// Sizes of what the graceful teardown's matcher is asked to scan — the
// passive end-of-agent scan takes the last match, so it is filtered out.
const gracefulMatcherInputs = vi.hoisted(() => [] as number[]);

vi.mock("../sessionIdCapture.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sessionIdCapture.js")>();
  return {
    ...actual,
    createSessionIdMatcher: (pattern: string | undefined) => {
      const matcher = actual.createSessionIdMatcher(pattern);
      if (!matcher) return matcher;
      const recording: typeof matcher = (raw, options) => {
        if (options.occurrence === "first") gracefulMatcherInputs.push(raw.length);
        return matcher(raw, options);
      };
      return recording;
    },
  };
});

const CTRL_C = String.fromCharCode(3);
const NATIVE_READ_BYTES = 64 * 1024;

function codexGateText(): string {
  const resume = getAgentConfig("codex")?.resume;
  if (resume?.kind !== "session-id" || !resume.shutdownSignal) {
    throw new Error("codex must declare a gated shutdown signal");
  }
  return resume.shutdownSignal.gateText;
}

/**
 * A PTY that behaves like node-pty under flow control: while paused, what the
 * agent prints waits (in the kernel buffer, for real) and reaches listeners
 * only once reads resume. A test that merely invoked the capture callback
 * would pass against the original bug; this one has to actually unblock reads.
 *
 * The backlog is flushed synchronously on resume, which is stricter than
 * node-pty (its stream delivers on the next tick).
 */
function createPausablePty(options?: { writeThrows?: boolean }) {
  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const backlog: string[] = [];
  const events: string[] = [];
  const writes: string[] = [];
  let paused = false;

  const deliver = (data: string) => {
    for (const listener of [...dataListeners]) listener(data);
  };

  const pty: Partial<IPty> = {
    // pid 0 keeps ProcessTreeKiller from signalling a real process.
    pid: 0,
    cols: 80,
    rows: 24,
    write: (data: string) => {
      events.push("write");
      if (options?.writeThrows) throw new Error("EIO");
      writes.push(data);
    },
    resize: () => {},
    kill: vi.fn(),
    pause: () => {
      paused = true;
      events.push("pause");
    },
    resume: () => {
      paused = false;
      events.push("resume");
      while (!paused && backlog.length > 0) deliver(backlog.shift()!);
    },
    onData: (listener: (data: string) => void) => {
      dataListeners.add(listener);
      events.push("listen");
      return { dispose: () => dataListeners.delete(listener) };
    },
    onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
  };

  return {
    pty: pty as IPty,
    events,
    writes,
    output(data: string) {
      if (paused) backlog.push(data);
      else deliver(data);
    },
    exit(exitCode: number) {
      for (const listener of [...exitListeners]) listener({ exitCode });
    },
    get paused() {
      return paused;
    },
    get backlog() {
      return backlog.length;
    },
  };
}

type PausablePty = ReturnType<typeof createPausablePty>;

const spawnedTerminals: TerminalProcess[] = [];

function spawnContext(): SpawnContext {
  return { shell: "/bin/zsh", args: ["-l"], env: {} };
}

/**
 * The pty-host side, as `pty-host.ts` wires it: one coordinator per terminal
 * over its raw pause/resume, and the tracker handing out capture windows.
 */
function createHost() {
  const coordinators = new Map<string, PtyPauseCoordinator>();
  const terminals = new Map<string, TerminalProcess>();
  const captureEvents: Array<[string, "open" | "close"]> = [];
  const tracker = new GracefulCaptureTracker({
    getPauseCoordinator: (id) => coordinators.get(id),
    getOrCreatePauseCoordinator: (id) => coordinators.get(id),
    isTerminalLive: (id) => {
      const info = terminals.get(id)?.getInfo();
      return info !== undefined && !info.wasKilled && !info.isExited;
    },
    emitDataLoss: vi.fn(),
  });

  function spawn(
    id: string,
    handles: PausablePty,
    options: {
      agentId?: string;
      agentSessionId?: string;
      withCapture?: boolean;
      openCapture?: TerminalProcessCallbacks["openGracefulCapture"];
      emitData?: (data: string) => void;
    } = {}
  ) {
    const coordinator = new PtyPauseCoordinator({
      pause: () => handles.pty.pause(),
      resume: () => handles.pty.resume(),
    });
    coordinators.set(id, coordinator);
    const callbacks: TerminalProcessCallbacks = {
      emitData: (_termId, data) => options.emitData?.(String(data)),
      onExit: () => {},
    };
    if (options.withCapture !== false) {
      callbacks.openGracefulCapture =
        options.openCapture ??
        ((termId) => {
          // Logged before opening: opening is what resumes reads.
          handles.events.push("capture-open");
          const lease = tracker.open(termId);
          if (!lease) {
            handles.events.pop();
            return null;
          }
          captureEvents.push([termId, "open"]);
          return {
            shouldDiscard: (data) => lease.shouldDiscard(data),
            close: () => {
              captureEvents.push([termId, "close"]);
              handles.events.push("capture-close");
              lease.close();
            },
          };
        });
    }
    const terminal = new TerminalProcess(
      id,
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 24,
        kind: "terminal",
        launchAgentId: options.agentId,
        agentSessionId: options.agentSessionId,
      },
      callbacks,
      {
        agentStateService: {
          handleActivityState: () => {},
          updateAgentState: () => {},
          emitAgentKilled: () => {},
          // Reached here, unlike in the single-listener mock elsewhere: every
          // exit listener fires, TerminalProcess's own included.
          emitAgentCompleted: () => {},
        } as never,
        ptyPool: null,
        processTreeCache: null,
      },
      spawnContext(),
      handles.pty
    );
    terminals.set(id, terminal);
    spawnedTerminals.push(terminal);
    handles.events.length = 0;
    return { terminal, coordinator };
  }

  return { tracker, spawn, captureEvents };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalProcess.gracefulShutdown — capture window (#12432)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gracefulMatcherInputs.length = 0;
  });

  afterEach(async () => {
    // Let the shared headless scheduler run its pending tick before timers are
    // cleared: a cancelled tick leaves it convinced one is still coming.
    await vi.advanceTimersByTimeAsync(0);
    for (const terminal of spawnedTerminals.splice(0)) terminal.dispose();
    await vi.advanceTimersByTimeAsync(0);
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("captures through a governor hold that predates the teardown", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
    coordinator.pause("resource-governor");
    expect(handles.paused).toBe(true);

    const startedAt = Date.now();
    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toContain("/quit\r");

    handles.output("claude --resume held-1\n");

    await expect(promise).resolves.toBe("held-1");
    expect(Date.now() - startedAt).toBeLessThan(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    expect(coordinator.isCapturing).toBe(false);
  });

  it("times out on the same hold when nothing opens a capture window", async () => {
    // The control for the test above: the harness really does withhold output.
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      withCapture: false,
    });
    coordinator.pause("resource-governor");

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    handles.output("claude --resume held-2\n");
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

    await expect(promise).resolves.toBeNull();
    expect(handles.backlog).toBe(1);
  });

  it("opens the window after its listeners exist and before the first write", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "codex" });
    coordinator.pause("port-queue-2");

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();

    const { events } = handles;
    expect(events.indexOf("listen")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("listen")).toBeLessThan(events.indexOf("capture-open"));
    expect(events.indexOf("capture-open")).toBeLessThan(events.indexOf("resume"));
    expect(events.indexOf("resume")).toBeLessThan(events.indexOf("write"));

    handles.output("  codex resume ordered-1\n");
    await expect(promise).resolves.toBe("ordered-1");
    expect(events.indexOf("capture-close")).toBeGreaterThan(events.indexOf("write"));
  });

  it("keeps draining through another pressure sample while an unrelated terminal stays paused", async () => {
    const host = createHost();
    const capturing = createPausablePty();
    const bystander = createPausablePty();
    const a = host.spawn("t1", capturing, { agentId: "codex" });
    const b = host.spawn("t2", bystander, { agentId: "codex" });
    a.coordinator.pause("resource-governor");
    b.coordinator.pause("resource-governor");

    const promise = a.terminal.gracefulShutdown();
    await flushMicrotasks();
    expect(capturing.writes).toEqual([CTRL_C]);

    // The governor disengages and re-engages mid-handshake.
    for (const { coordinator } of [a, b]) coordinator.resume("resource-governor");
    for (const { coordinator } of [a, b]) coordinator.pause("resource-governor");

    expect(capturing.paused).toBe(false);
    expect(bystander.paused).toBe(true);
    bystander.output("still held\n");
    expect(bystander.backlog).toBe(1);

    // Fresh footer output reaches the gate, so the escalation can continue.
    capturing.output(`\x1b[2K  Ctrl+C ${codexGateText()}  \x1b[0m`);
    await flushMicrotasks();
    expect(capturing.writes).toEqual([CTRL_C, CTRL_C]);

    capturing.output("  codex resume drained-1\n");
    await expect(promise).resolves.toBe("drained-1");
    expect(bystander.paused).toBe(true);
    expect(b.coordinator.isCapturing).toBe(false);
  });

  it("keeps held output out of the rest of the pipeline", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const delivered: string[] = [];
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => delivered.push(data),
    });
    const mirrorFeeds = vi.spyOn(headlessMirrorScheduler, "enqueue");

    handles.output("history line\n");
    expect(delivered).toEqual(["history line\n"]);
    expect(mirrorFeeds).toHaveBeenCalled();

    coordinator.pause("resource-governor");
    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    delivered.length = 0;
    mirrorFeeds.mockClear();
    for (let i = 0; i < 20; i++) handles.output("x".repeat(NATIVE_READ_BYTES));
    expect(delivered).toEqual([]);
    expect(mirrorFeeds).not.toHaveBeenCalled();

    // Once nothing holds it any more, output flows everywhere as usual.
    coordinator.resume("resource-governor");
    handles.output("visible goodbye\n");
    expect(delivered).toEqual(["visible goodbye\n"]);
    expect(mirrorFeeds).toHaveBeenCalled();

    handles.output("claude --resume shed-1\n");
    await expect(promise).resolves.toBe("shed-1");
  });

  it("still answers a colour query the held output carries", async () => {
    // A TUI blocks on this reply for longer than the teardown budget, so a
    // discarded query would cost the hint it prints afterwards.
    const host = createHost();
    const handles = createPausablePty();
    const delivered: string[] = [];
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => delivered.push(data),
    });
    coordinator.pause("resource-governor");

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    const writesBefore = handles.writes.length;

    handles.output("\x1b]11;?\x07");

    const replies = handles.writes.slice(writesBefore);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.startsWith("\x1b]11;rgb:")).toBe(true);
    expect(delivered).toEqual([]);

    handles.output("claude --resume answered-1\n");
    await expect(promise).resolves.toBe("answered-1");
  });

  it("captures while a renderer that never acknowledges stays within its queue watermark", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const coordinatorRef: { current?: PtyPauseCoordinator } = {};
    const queue = new IpcQueueManager({
      getTerminal: () => undefined,
      getPauseCoordinator: () => coordinatorRef.current,
      sendEvent: vi.fn(),
      metricsEnabled: () => false,
      emitTerminalStatus: vi.fn(),
      emitReliabilityMetric: vi.fn(),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The host's IPC fallback: post, account, and let the watermark decide.
    const { terminal, coordinator } = host.spawn("t1", handles, {
      agentId: "claude",
      emitData: (data) => {
        const bytes = Buffer.byteLength(data, "utf8");
        queue.addBytes("t1", bytes);
        queue.applyBackpressure("t1", queue.getUtilization("t1"));
      },
    });
    coordinatorRef.current = coordinator;

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);

    // Several times the queue's hard cap, and not one acknowledgement.
    for (let i = 0; i < 150; i++) {
      handles.output("y".repeat(NATIVE_READ_BYTES));
      expect(handles.paused).toBe(false);
    }
    const highWatermarkBytes = (IPC_MAX_QUEUE_BYTES * IPC_HIGH_WATERMARK_PERCENT) / 100;
    expect(coordinator.hasToken("ipc-queue")).toBe(true);
    expect(queue.getQueuedBytes("t1")).toBeLessThan(highWatermarkBytes + NATIVE_READ_BYTES);

    handles.output("claude --resume unacked-1\n");
    await expect(promise).resolves.toBe("unacked-1");
    queue.dispose();
  });

  it("scans a bounded window however much the agent prints before its hint", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, { agentId: "claude" });

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    for (let i = 0; i < 40; i++) handles.output("z".repeat(NATIVE_READ_BYTES));
    handles.output("claude --resume frag-");
    handles.output("ment-1\n");

    await expect(promise).resolves.toBe("frag-ment-1");
    expect(gracefulMatcherInputs.length).toBeGreaterThan(40);
    expect(Math.max(...gracefulMatcherInputs)).toBeLessThanOrEqual(
      GRACEFUL_SHUTDOWN_BUFFER_SIZE + NATIVE_READ_BYTES
    );
  });

  it("reads the footer at the head of a burst larger than the capture buffer", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, { agentId: "codex" });

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C]);

    handles.output(`  Ctrl+C ${codexGateText()}  ${"\x1b[0m.".repeat(8 * 1024)}`);
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C, CTRL_C]);

    handles.output("  codex resume burst-gate\n");
    await expect(promise).resolves.toBe("burst-gate");
  });

  it("settles without writing when the agent was already on its way out", async () => {
    // The hint was printed while the terminal was held — the agent was quit a
    // moment before the teardown began. Resumed reads can deliver it before a
    // single byte is written, and nothing must be sent after it.
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
    coordinator.pause("resource-governor");
    handles.output("claude --resume already-1\n");

    const promise = terminal.gracefulShutdown();

    await expect(promise).resolves.toBe("already-1");
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toEqual([]);
    expect(host.captureEvents).toEqual([
      ["t1", "open"],
      ["t1", "close"],
    ]);
  });

  it("puts a surviving terminal back under its holds when its close fails", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "codex" });
    coordinator.pause("resource-governor");
    vi.spyOn(terminal, "kill").mockImplementation(() => {
      throw new Error("kill exploded");
    });

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();
    handles.output("  codex resume survivor-1\n");
    await expect(promise).resolves.toBe("survivor-1");

    expect(terminal.getInfo().wasKilled).toBeFalsy();
    expect(coordinator.isCapturing).toBe(false);
    expect(host.tracker.isCapturing("t1")).toBe(false);
    expect(handles.paused).toBe(true);

    // Output produced now waits for the governor, as it would for any terminal.
    handles.output("after the failed close\n");
    expect(handles.backlog).toBe(1);
  });

  describe("under a system-sleep hold", () => {
    it("never reads past it, so a teardown asleep through its deadline times out", async () => {
      const host = createHost();
      const handles = createPausablePty();
      const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
      coordinator.pause("system-sleep");

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.output("claude --resume asleep-1\n");
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      await expect(promise).resolves.toBeNull();
      expect(handles.backlog).toBe(1);
      expect(coordinator.hasToken("system-sleep")).toBe(true);
    });

    it("captures once the machine wakes, even with other holds still recorded", async () => {
      const host = createHost();
      const handles = createPausablePty();
      const { terminal, coordinator } = host.spawn("t1", handles, { agentId: "claude" });
      coordinator.pause("system-sleep");
      coordinator.pause("resource-governor");

      const promise = terminal.gracefulShutdown();
      await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
      handles.output("claude --resume woke-1\n");
      expect(handles.backlog).toBe(1);

      coordinator.resume("system-sleep");

      await expect(promise).resolves.toBe("woke-1");
    });
  });

  describe("opens and closes the window exactly once", () => {
    async function expectOneWindow(
      run: (ctx: { terminal: TerminalProcess; handles: PausablePty }) => Promise<unknown>,
      options: { agentId?: string; writeThrows?: boolean } = {}
    ) {
      const host = createHost();
      const handles = createPausablePty({ writeThrows: options.writeThrows });
      const { terminal, coordinator } = host.spawn("t1", handles, {
        agentId: options.agentId ?? "claude",
      });
      coordinator.pause("resource-governor");

      await run({ terminal, handles });

      expect(host.captureEvents).toEqual([
        ["t1", "open"],
        ["t1", "close"],
      ]);
      expect(coordinator.isCapturing).toBe(false);
      expect(host.tracker.isCapturing("t1")).toBe(false);
    }

    it("when the agent prints nothing", async () => {
      await expectOneWindow(async ({ terminal }) => {
        const promise = terminal.gracefulShutdown();
        await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_TIMEOUT_MS);
        await expect(promise).resolves.toBeNull();
      });
    });

    it("when the process exits early", async () => {
      await expectOneWindow(async ({ terminal, handles }) => {
        const promise = terminal.gracefulShutdown();
        await flushMicrotasks();
        handles.exit(0);
        await expect(promise).resolves.toBeNull();
      });
    });

    it("when the hint arrives in fragments", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          const promise = terminal.gracefulShutdown();
          await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
          handles.output("Resume with: gemini --resume fc1c3a37-2294-4");
          await flushMicrotasks();
          handles.output("c8d-9abc-1234567890ab\n");
          await expect(promise).resolves.toBe("fc1c3a37-2294-4c8d-9abc-1234567890ab");
        },
        { agentId: "gemini" }
      );
    });

    it("when the prelude write fails", async () => {
      await expectOneWindow(
        async ({ terminal }) => {
          await expect(terminal.gracefulShutdown()).resolves.toBeNull();
        },
        { writeThrows: true }
      );
    });

    it("when the gated press fails to write", async () => {
      await expectOneWindow(
        async ({ terminal }) => {
          await expect(terminal.gracefulShutdown()).resolves.toBeNull();
        },
        { agentId: "codex", writeThrows: true }
      );
    });

    it("when the kill on the way out throws", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          vi.spyOn(terminal, "kill").mockImplementation(() => {
            throw new Error("kill exploded");
          });
          const promise = terminal.gracefulShutdown();
          await flushMicrotasks();
          handles.output("  codex resume kill-throws\n");
          await expect(promise).resolves.toBe("kill-throws");
        },
        { agentId: "codex" }
      );
    });

    it("when close requests overlap", async () => {
      await expectOneWindow(
        async ({ terminal, handles }) => {
          const first = terminal.gracefulShutdown();
          const second = terminal.gracefulShutdown();
          await flushMicrotasks();
          const third = terminal.gracefulShutdown();
          handles.output("  codex resume overlap-1\n");
          await expect(Promise.all([first, second, third])).resolves.toEqual([
            "overlap-1",
            "overlap-1",
            "overlap-1",
          ]);
          expect(handles.writes).toEqual([CTRL_C]);
        },
        { agentId: "codex" }
      );
    });

    it("when a burst larger than the capture buffer carries the hint at its head", async () => {
      await expectOneWindow(async ({ terminal, handles }) => {
        const promise = terminal.gracefulShutdown();
        await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
        handles.output(`claude --resume burst-1\n${"x".repeat(NATIVE_READ_BYTES)}`);
        await expect(promise).resolves.toBe("burst-1");
      });
    });
  });

  it("opens no window for a teardown that writes nothing", async () => {
    const host = createHost();
    const plain = createPausablePty();
    const assigned = createPausablePty();
    const plainTerminal = host.spawn("plain", plain).terminal;
    const assignedTerminal = host.spawn("assigned", assigned, {
      agentId: "claude",
      agentSessionId: "assigned-1",
    }).terminal;

    await expect(plainTerminal.gracefulShutdown()).resolves.toBeNull();
    await expect(assignedTerminal.gracefulShutdown()).resolves.toBe("assigned-1");

    expect(host.captureEvents).toEqual([]);
  });

  it("still tears down when the host cannot open the window", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, {
      agentId: "claude",
      openCapture: () => {
        throw new Error("host unavailable");
      },
    });

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toContain("/quit\r");
    handles.output("claude --resume no-window\n");

    await expect(promise).resolves.toBe("no-window");
  });
});
