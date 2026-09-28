import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { loggerCalls, appListeners, cleaningUp } = vi.hoisted(() => ({
  loggerCalls: [] as Array<{ level: string; message: string; context?: Record<string, unknown> }>,
  appListeners: {} as Record<string, Array<(...args: unknown[]) => void>>,
  cleaningUp: { value: false },
}));

vi.mock("electron", () => ({
  app: {
    on: (event: string, fn: (...args: unknown[]) => void) => {
      (appListeners[event] ??= []).push(fn);
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
  isCleaningUp: () => cleaningUp.value,
}));

import {
  PROCESS_DEATH_BURST_WINDOW_MS,
  ProcessDeathLogger,
  initializeProcessDeathLogger,
  resetProcessDeathLoggerForTesting,
} from "../ProcessDeathLogger.js";
import { describeProcessDeath } from "../processDeathDescription.js";

function emit(event: string, ...args: unknown[]): void {
  for (const fn of appListeners[event] ?? []) fn(...args);
}

describe("describeProcessDeath", () => {
  it("names Electron's raw POSIX signal numbers and says it was not a crash", () => {
    expect(describeProcessDeath("killed", 15, "darwin")).toBe(
      "was terminated by SIGTERM from outside the process, not a crash"
    );
    expect(describeProcessDeath("killed", 9, "linux")).toContain("SIGKILL");
    expect(describeProcessDeath("killed", 42, "linux")).toContain("signal 42");
  });

  it("does not claim a signal on Windows", () => {
    const text = describeProcessDeath("killed", 1, "win32");
    expect(text).toContain("terminated from outside the process");
    expect(text).not.toContain("SIG");
  });

  it("keeps real crashes described as crashes", () => {
    expect(describeProcessDeath("crashed", 11, "darwin")).toBe("crashed (exit code 11)");
    expect(describeProcessDeath("oom", 0, "darwin")).toBe("ran out of memory");
    expect(describeProcessDeath("something-new", 3, "darwin")).toContain("something-new");
  });
});

describe("ProcessDeathLogger", () => {
  let now = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    loggerCalls.length = 0;
    cleaningUp.value = false;
    for (const key of Object.keys(appListeners)) delete appListeners[key];
  });

  afterEach(() => {
    resetProcessDeathLoggerForTesting();
    vi.useRealTimers();
  });

  const utility = (name: string, reason = "killed", exitCode = 15) => ({
    kind: "utility" as const,
    type: "Utility",
    name,
    reason,
    exitCode,
  });

  it("logs a lone death once the window closes", () => {
    const deathLogger = new ProcessDeathLogger(
      () => false,
      () => now
    );
    deathLogger.record(utility("Network Service"));
    expect(loggerCalls).toHaveLength(0);

    vi.advanceTimersByTime(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].level).toBe("warn");
    expect(loggerCalls[0].message).toBe(
      "Child process gone: Network Service (Utility) was terminated by SIGTERM from outside the process, not a crash"
    );
    expect(loggerCalls[0].context).toMatchObject({
      name: "Network Service",
      reason: "killed",
      exitCode: 15,
    });
  });

  it("reports five deaths within 700ms as one event", () => {
    const deathLogger = new ProcessDeathLogger(
      () => false,
      () => now
    );
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
      now += 175;
      deathLogger.record(utility(name));
    }

    vi.advanceTimersByTime(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    const [entry] = loggerCalls;
    expect(entry.level).toBe("warn");
    expect(entry.message).toMatch(
      /^5 child processes gone within 700ms — all terminated by a signal from outside the process: /
    );
    for (const name of names) expect(entry.message).toContain(name);
    expect(entry.message).toContain("renderer (window webContents 3)");
    expect(entry.context).toMatchObject({ count: 5, spanMs: 700, signalKills: 5 });
  });

  it("flushes on a fixed deadline from the first death under continuous arrivals", () => {
    const deathLogger = new ProcessDeathLogger(
      () => false,
      () => now
    );
    deathLogger.record(utility("a"));
    vi.advanceTimersByTime(PROCESS_DEATH_BURST_WINDOW_MS - 100);
    deathLogger.record(utility("b", "crashed", 11));
    vi.advanceTimersByTime(100);

    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].message).toContain("2 child processes gone");
    expect(loggerCalls[0].message).toContain("1 terminated by a signal");
    expect(loggerCalls[0].message).toContain("b (Utility) crashed (exit code 11)");
  });

  it("flushes early rather than growing without bound", () => {
    const deathLogger = new ProcessDeathLogger(
      () => false,
      () => now
    );
    for (let i = 0; i < 32; i++) deathLogger.record(utility(`p${i}`));
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].context).toMatchObject({ count: 32 });
  });

  it("logs deaths during a committed quit at info", () => {
    cleaningUp.value = true;
    const deathLogger = new ProcessDeathLogger(
      () => cleaningUp.value,
      () => now
    );
    deathLogger.record(utility("daintree-watchdog"));
    deathLogger.flush();
    expect(loggerCalls[0].level).toBe("info");
    expect(loggerCalls[0].context).toMatchObject({ duringShutdown: true });
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

    vi.advanceTimersByTime(PROCESS_DEATH_BURST_WINDOW_MS);
    expect(loggerCalls).toHaveLength(1);
    expect(loggerCalls[0].message).toContain("2 child processes gone");
    expect(loggerCalls[0].message).toContain("Network Service (Utility)");
    expect(loggerCalls[0].message).toContain("renderer (window webContents 7)");
    expect(loggerCalls[0].message).not.toContain("x (Utility)");
  });

  it("installs its listeners once", () => {
    const first = initializeProcessDeathLogger();
    expect(initializeProcessDeathLogger()).toBe(first);
    expect(appListeners["child-process-gone"]).toHaveLength(1);
    expect(appListeners["render-process-gone"]).toHaveLength(1);
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
