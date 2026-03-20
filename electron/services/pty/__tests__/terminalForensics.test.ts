import { describe, expect, it } from "vitest";
import { decideTerminalExitForensics, isRoutineExit } from "../terminalForensics.js";

describe("decideTerminalExitForensics", () => {
  it("suppresses logs for expected SIGHUP close with clean exit", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 0,
      signal: 1,
      recentOutput: "✖ 2 errors (F12 for details)",
    });
    expect(decision.shouldLog).toBe(false);
    expect(decision.normalizedSignal).toBe(1);
  });

  it("treats signal 0 as no signal", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 0,
      signal: 0,
      recentOutput: "all good",
    });
    expect(decision.shouldLog).toBe(false);
    expect(decision.normalizedSignal).toBeUndefined();
  });

  it("logs on non-zero exit code", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 2,
      signal: undefined,
      recentOutput: "done",
    });
    expect(decision.shouldLog).toBe(true);
  });

  it("logs on unexpected signal", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 0,
      signal: 9,
      recentOutput: "killed",
    });
    expect(decision.shouldLog).toBe(true);
  });

  it("logs on likely crash text even with clean exit", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 0,
      signal: undefined,
      recentOutput: "Unhandled exception: boom",
    });
    expect(decision.shouldLog).toBe(true);
  });

  it("suppresses logs when termination was requested", () => {
    const decision = decideTerminalExitForensics({
      exitCode: 137,
      signal: 9,
      wasKilled: true,
      recentOutput: "killed by user",
    });
    expect(decision.shouldLog).toBe(false);
  });
});

describe("isRoutineExit", () => {
  it("treats exit code 0 as routine", () => {
    expect(isRoutineExit(0)).toBe(true);
  });

  it("treats routine signals as routine", () => {
    expect(isRoutineExit(0, 1)).toBe(true); // SIGHUP
    expect(isRoutineExit(0, 2)).toBe(true); // SIGINT
    expect(isRoutineExit(0, 13)).toBe(true); // SIGPIPE
    expect(isRoutineExit(0, 15)).toBe(true); // SIGTERM
  });

  it("treats shell-convention routine exit codes as routine", () => {
    expect(isRoutineExit(129)).toBe(true); // 128+SIGHUP
    expect(isRoutineExit(130)).toBe(true); // 128+SIGINT
    expect(isRoutineExit(141)).toBe(true); // 128+SIGPIPE
    expect(isRoutineExit(143)).toBe(true); // 128+SIGTERM
  });

  it("treats crash exit codes as non-routine", () => {
    expect(isRoutineExit(139)).toBe(false); // 128+SIGSEGV
    expect(isRoutineExit(134)).toBe(false); // 128+SIGABRT
    expect(isRoutineExit(137)).toBe(false); // 128+SIGKILL
  });

  it("treats genuine non-zero exit codes as non-routine", () => {
    expect(isRoutineExit(1)).toBe(false);
    expect(isRoutineExit(2)).toBe(false);
    expect(isRoutineExit(127)).toBe(false);
  });

  it("handles undefined/null signal gracefully", () => {
    expect(isRoutineExit(0, undefined)).toBe(true);
    expect(isRoutineExit(0, null)).toBe(true);
    expect(isRoutineExit(1, undefined)).toBe(false);
    expect(isRoutineExit(1, null)).toBe(false);
  });

  it("treats non-zero code with routine signal as routine", () => {
    expect(isRoutineExit(130, 2)).toBe(true); // SIGINT with matching code
    expect(isRoutineExit(1, 2)).toBe(true); // SIGINT signal overrides code
  });
});
