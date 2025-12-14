import { describe, expect, it } from "vitest";
import { decideTerminalExitForensics } from "../terminalForensics.js";

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
