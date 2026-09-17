import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IPty } from "node-pty";
import { TerminalProcess, type TerminalProcessCallbacks } from "../TerminalProcess.js";
import type { SpawnContext } from "../terminalSpawn.js";
import { GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS, GRACEFUL_SHUTDOWN_TIMEOUT_MS } from "../types.js";
import { getAgentConfig } from "../../../../shared/config/agentRegistry.js";
import { PtyPauseCoordinator } from "../../../pty-host/PtyPauseCoordinator.js";
import { GracefulCaptureTracker } from "../../../pty-host/GracefulCaptureTracker.js";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

const CTRL_C = String.fromCharCode(3);

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

function spawnContext(): SpawnContext {
  return { shell: "/bin/zsh", args: ["-l"], env: {} };
}

/**
 * The pty-host side, as `pty-host.ts` wires it: one coordinator per terminal
 * over its raw pause/resume, and TerminalProcess's capture callback driving
 * the tracker.
 */
function createHost() {
  const coordinators = new Map<string, PtyPauseCoordinator>();
  const terminals = new Map<string, TerminalProcess>();
  const captureEvents: Array<[string, boolean]> = [];
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
      onCapture?: TerminalProcessCallbacks["onGracefulCapture"];
    } = {}
  ) {
    const coordinator = new PtyPauseCoordinator({
      pause: () => handles.pty.pause(),
      resume: () => handles.pty.resume(),
    });
    coordinators.set(id, coordinator);
    const callbacks: TerminalProcessCallbacks = { emitData: () => {}, onExit: () => {} };
    if (options.withCapture !== false) {
      callbacks.onGracefulCapture =
        options.onCapture ??
        ((termId, active) => {
          captureEvents.push([termId, active]);
          handles.events.push(active ? "capture-open" : "capture-close");
          if (active) tracker.enter(termId);
          else tracker.end(termId, "settled");
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
  });

  afterEach(() => {
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

  it("reads the footer at the head of a burst larger than the capture buffer", async () => {
    const host = createHost();
    const handles = createPausablePty();
    const { terminal } = host.spawn("t1", handles, { agentId: "codex" });

    const promise = terminal.gracefulShutdown();
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C]);

    handles.output(`  Ctrl+C ${codexGateText()}  ${"\x1b[0m.".repeat(64 * 1024)}`);
    await flushMicrotasks();
    expect(handles.writes).toEqual([CTRL_C, CTRL_C]);

    handles.output("  codex resume burst-gate\n");
    await expect(promise).resolves.toBe("burst-gate");
  });

  it("settles without writing when the resumed reads already carry the hint", async () => {
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
      ["t1", true],
      ["t1", false],
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
        ["t1", true],
        ["t1", false],
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
        handles.output(`claude --resume burst-1\n${"x".repeat(256 * 1024)}`);
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
    const calls: boolean[] = [];
    const { terminal } = host.spawn("t1", handles, {
      agentId: "claude",
      onCapture: (_id, active) => {
        calls.push(active);
        if (active) throw new Error("host unavailable");
      },
    });

    const promise = terminal.gracefulShutdown();
    await vi.advanceTimersByTimeAsync(GRACEFUL_SHUTDOWN_CLEAR_DELAY_MS);
    expect(handles.writes).toContain("/quit\r");
    handles.output("claude --resume no-window\n");

    await expect(promise).resolves.toBe("no-window");
    // The failed open is rolled back once, and never closed a second time.
    expect(calls).toEqual([true, false]);
  });
});
