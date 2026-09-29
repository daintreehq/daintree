import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loggerCalls, appListeners, shutdown } = vi.hoisted(() => ({
  loggerCalls: [] as Array<{ level: string; message: string; context?: Record<string, unknown> }>,
  appListeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
  shutdown: { active: null as null | { phase: string } },
}));

vi.mock("electron", () => ({
  app: {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (appListeners[event] ??= []).push(fn);
    },
    off: (event: string, fn: (...args: unknown[]) => void) => {
      appListeners[event] = (appListeners[event] ?? []).filter((l) => l !== fn);
    },
  },
}));

vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (message: string, context?: Record<string, unknown>) =>
      loggerCalls.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      loggerCalls.push({ level: "warn", message, context }),
    error: vi.fn(),
  }),
}));

vi.mock("../../lifecycle/shutdownCoordinator.js", () => ({
  getActiveShutdown: () => shutdown.active,
}));

import {
  PROCESS_DEATH_BURST_WINDOW_MS,
  ProcessDeathLogger,
  initializeProcessDeathLogger,
  resetProcessDeathLoggerForTesting,
} from "../ProcessDeathLogger.js";
import { describeProcessDeath } from "../processDeathDescription.js";
import {
  noteTerminationIntent,
  resetTerminationIntentsForTesting,
} from "../processTerminationIntent.js";

function emit(event: string, ...args: unknown[]): void {
  for (const fn of appListeners[event] ?? []) fn(...args);
}

describe("describeProcessDeath", () => {
  it("names Electron's raw POSIX signal numbers and says it was not a crash", () => {
    const sigterm = describeProcessDeath("killed", 15, { platform: "darwin" });
    expect(sigterm).toContain("SIGTERM");
    expect(sigterm).toContain("from outside the process");
    expect(sigterm).toContain("not a crash");
    expect(describeProcessDeath("killed", 9, { platform: "linux" })).toContain("SIGKILL");
    expect(describeProcessDeath("killed", 42, { platform: "linux" })).toContain("signal 42");
  });

  it("does not invent a signal number from a non-positive code", () => {
    const text = describeProcessDeath("killed", -1, { platform: "linux" });
    expect(text).toContain("by a signal");
    expect(text).not.toContain("-1");
  });

  it("does not claim a signal on Windows", () => {
    const text = describeProcessDeath("killed", 1, { platform: "win32" });
    expect(text).toContain("from outside the process");
    expect(text).not.toContain("SIG");
  });

  it("attributes a kill Daintree asked for to Daintree", () => {
    const text = describeProcessDeath("killed", 9, {
      platform: "darwin",
      intent: "dispose backstop",
    });
    expect(text).toContain("SIGKILL");
    expect(text).toContain("by Daintree (dispose backstop)");
    expect(text).not.toContain("outside");
  });

  it("keeps real crashes described as crashes", () => {
    expect(describeProcessDeath("crashed", 11, { platform: "darwin" })).toContain("crashed");
    expect(describeProcessDeath("crashed", 11, { platform: "darwin" })).toContain("11");
    expect(describeProcessDeath("something-new", 3, { platform: "darwin" })).toContain(
      "something-new"
    );
  });
});

describe("ProcessDeathLogger", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    loggerCalls.length = 0;
    shutdown.active = null;
    resetTerminationIntentsForTesting();
  });

  afterEach(() => {
    resetProcessDeathLoggerForTesting();
    vi.useRealTimers();
  });

  // Keeps the injected clock and fake timers in step.
  function advance(ms: number): void {
    now += ms;
    vi.advanceTimersByTime(ms);
  }

  const makeLogger = () =>
    new ProcessDeathLogger(
      () => shutdown.active !== null,
      () => now
    );

  const utility = (name: string, reason = "killed", exitCode = 15, intent?: string) => ({
    kind: "utility" as const,
    type: "Utility",
    name,
    reason,
    exitCode,
    intent,
  });

  it("logs a lone death once the window closes", () => {
    const deathLogger = makeLogger();
    deathLogger.record(utility("Network Service"));
    expect(loggerCalls).toHaveLength(0);

    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].level).toBe("warn");
    expect(loggerCalls[0].message).toMatch(/^Child process gone: Network Service \(Utility\) /);
    expect(loggerCalls[0].message).toContain(
      process.platform === "win32" ? "exit code 15" : "SIGTERM"
    );
    expect(loggerCalls[0].context).toMatchObject({
      name: "Network Service",
      reason: "killed",
      exitCode: 15,
    });
  });

  it("reports five deaths within 700ms as one event", () => {
    const deathLogger = makeLogger();
    const names = ["Network Service", "daintree-watchdog", "daintree-pty-host:2", "ws-host"];
    deathLogger.record({
      kind: "renderer",
      type: "window",
      name: "renderer",
      reason: "killed",
      exitCode: 15,
      webContentsId: 3,
    });
    for (const name of names) {
      advance(175);
      deathLogger.record(utility(name));
    }

    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    const [entry] = loggerCalls;
    expect(entry.level).toBe("warn");
    expect(entry.message).toMatch(
      /^5 child processes gone within 700ms — all terminated by a signal from outside the process: /
    );
    for (const name of names) expect(entry.message).toContain(name);
    expect(entry.message).toContain("renderer (window webContents 3)");
    expect(entry.context).toMatchObject({ count: 5, spanMs: 700, externalKills: 5 });
  });

  it("flushes on a fixed deadline from the first death, then starts a new event", () => {
    const deathLogger = makeLogger();
    deathLogger.record(utility("a"));
    advance(PROCESS_DEATH_BURST_WINDOW_MS - 100);
    deathLogger.record(utility("b", "crashed", 11));
    advance(100);

    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].message).toContain("2 child processes gone within 900ms");
    expect(loggerCalls[0].message).toContain("1 terminated by a signal");
    expect(loggerCalls[0].message).toContain("b (Utility) crashed");

    advance(50);
    deathLogger.record(utility("c"));
    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(2);
    expect(loggerCalls[1].message).toMatch(/^Child process gone: c /);
  });

  it("flushes early rather than growing without bound", () => {
    const deathLogger = makeLogger();
    for (let i = 0; i < 32; i++) deathLogger.record(utility(`p${i}`));
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].context).toMatchObject({ count: 32 });
  });

  it("logs deaths during a claimed shutdown at info", () => {
    shutdown.active = { phase: "handoff" };
    const deathLogger = makeLogger();
    deathLogger.record(utility("daintree-watchdog"));
    deathLogger.flush();
    expect(loggerCalls[0].level).toBe("info");
    expect(loggerCalls[0].context).toMatchObject({ duringShutdown: true });
  });

  it("logs Daintree's own kills at info and leaves them out of the external count", () => {
    const deathLogger = makeLogger();
    deathLogger.record(utility("ws-host", "killed", 9, "dispose backstop"));
    deathLogger.flush();
    expect(loggerCalls[0].level).toBe("info");
    expect(loggerCalls[0].context).toMatchObject({ initiatedBy: "daintree" });

    deathLogger.record(utility("ws-host", "killed", 9, "dispose backstop"));
    deathLogger.record(utility("Network Service"));
    deathLogger.flush();
    expect(loggerCalls[1].level).toBe("warn");
    expect(loggerCalls[1].context).toMatchObject({ count: 2, externalKills: 1 });
  });

  it("observes utility and renderer deaths from app events, ignoring clean exits", () => {
    initializeProcessDeathLogger();
    emit(
      "child-process-gone",
      {},
      { type: "Utility", name: "Network Service", reason: "killed", exitCode: 15 }
    );
    emit(
      "child-process-gone",
      {},
      { type: "Utility", name: "x", reason: "clean-exit", exitCode: 0 }
    );
    emit(
      "render-process-gone",
      {},
      { id: 7, getType: () => "window" },
      { reason: "killed", exitCode: 15 }
    );

    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].message).toContain("2 child processes gone");
    expect(loggerCalls[0].message).toContain("Network Service (Utility)");
    expect(loggerCalls[0].message).toContain("renderer (window webContents 7)");
    expect(loggerCalls[0].message).not.toContain("x (Utility)");
  });

  it("applies noted intents and survives missing names and destroyed webContents", () => {
    initializeProcessDeathLogger();
    noteTerminationIntent({ serviceName: "daintree-pty-host" }, "dispose backstop");
    noteTerminationIntent({ webContentsId: 4 }, "user force-restarted view");
    emit(
      "child-process-gone",
      {},
      { type: "Utility", name: "daintree-pty-host", reason: "killed", exitCode: 15 }
    );
    emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: 5 });
    emit(
      "render-process-gone",
      {},
      { id: 4, getType: () => "window" },
      { reason: "killed", exitCode: 9 }
    );
    emit(
      "render-process-gone",
      {},
      {
        getType: () => {
          throw new Error("destroyed");
        },
      },
      { reason: "crashed", exitCode: 1 }
    );

    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    const [entry] = loggerCalls;
    expect(entry.context).toMatchObject({ count: 4, externalKills: 0 });
    expect(entry.message).toContain(
      `daintree-pty-host (Utility) was terminated ${process.platform === "win32" ? "(exit code 15)" : "by SIGTERM"} by Daintree`
    );
    expect(entry.message).toContain("Utility crashed");
    expect(entry.message).toContain("user force-restarted view");
    expect(entry.message).toContain("renderer (unknown) crashed");
  });

  it("never downgrades a real crash that races a noted kill", () => {
    initializeProcessDeathLogger();
    noteTerminationIntent({ serviceName: "ws-host" }, "dispose backstop");
    emit(
      "child-process-gone",
      {},
      { type: "Utility", name: "ws-host", reason: "crashed", exitCode: 11 }
    );
    advance(PROCESS_DEATH_BURST_WINDOW_MS);

    expect(loggerCalls[0].level).toBe("warn");
    expect(loggerCalls[0].message).not.toContain("by Daintree");
    expect(loggerCalls[0].context).not.toHaveProperty("initiatedBy");
  });

  it("does not pin a noted kill on a later death of a same-named replacement", () => {
    initializeProcessDeathLogger();
    noteTerminationIntent({ serviceName: "daintree-plugin-database" }, "query cancelled");
    const killed = {
      type: "Utility",
      name: "daintree-plugin-database",
      reason: "killed",
      exitCode: 9,
    };
    emit("child-process-gone", {}, killed);
    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls[0].level).toBe("info");

    advance(3_000);
    emit("child-process-gone", {}, killed);
    advance(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls[1].level).toBe("warn");
    expect(loggerCalls[1].message).toContain("from outside the process");
  });

  it("installs its listeners once and removes them on reset", () => {
    const first = initializeProcessDeathLogger();
    expect(initializeProcessDeathLogger()).toBe(first);
    expect(appListeners["child-process-gone"]).toHaveLength(1);
    expect(appListeners["render-process-gone"]).toHaveLength(1);

    resetProcessDeathLoggerForTesting();
    initializeProcessDeathLogger();
    expect(appListeners["child-process-gone"]).toHaveLength(1);
    expect(appListeners["render-process-gone"]).toHaveLength(1);
    expect(appListeners["will-quit"]).toHaveLength(1);
  });

  it("flushes pending deaths at will-quit", () => {
    initializeProcessDeathLogger();
    emit(
      "child-process-gone",
      {},
      { type: "Utility", name: "svc", reason: "crashed", exitCode: 1 }
    );
    emit("will-quit");
    expect(loggerCalls).toHaveLength(1);
  });
});
