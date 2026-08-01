import { describe, expect, it } from "vitest";
import { getRestartBannerVariant, type RestartBannerInput } from "../restartStatus";

const base: RestartBannerInput = {
  isExited: true,
  exitCode: 1,
  dismissedRestartPrompt: false,
  restartError: undefined,
  isRestarting: false,
  isAutoRestarting: false,
  exitBehavior: "keep",
  backendStatus: "connected",
};

describe("getRestartBannerVariant", () => {
  it("returns exit-error for non-zero non-130 exit", () => {
    const result = getRestartBannerVariant(base);
    expect(result).toEqual({ type: "exit-error", exitCode: 1 });
  });

  it("returns auto-restarting when isAutoRestarting is true", () => {
    const result = getRestartBannerVariant({ ...base, isAutoRestarting: true });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("returns auto-restarting over exit-error when both could apply", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      exitBehavior: "keep",
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("returns none when not exited", () => {
    const result = getRestartBannerVariant({ ...base, isExited: false });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when exitCode is null", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: null });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when exitCode is 0", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: 0 });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when exitCode is 130 (SIGINT)", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: 130 });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when restart prompt is dismissed", () => {
    const result = getRestartBannerVariant({ ...base, dismissedRestartPrompt: true });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when restartError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      restartError: {
        message: "failed",
        code: "RESTART_FAILED",
        timestamp: Date.now(),
        recoverable: false,
      },
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns restarting when isRestarting is true and no errors", () => {
    const result = getRestartBannerVariant({ ...base, isRestarting: true });
    expect(result).toEqual({ type: "restarting" });
  });

  it("returns auto-restarting over restarting when both isAutoRestarting and isRestarting are true", () => {
    const result = getRestartBannerVariant({
      ...base,
      isRestarting: true,
      isAutoRestarting: true,
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("returns none when isRestarting is true but restartError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isRestarting: true,
      restartError: {
        message: "failed",
        code: "RESTART_FAILED",
        timestamp: Date.now(),
        recoverable: false,
      },
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when isRestarting is true but reconnectError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isRestarting: true,
      reconnectError: {
        message: "lost connection",
        code: "RECONNECT_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when isRestarting is true but spawnError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isRestarting: true,
      spawnError: {
        message: "spawn failed",
        code: "SPAWN_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when exitBehavior is restart", () => {
    const result = getRestartBannerVariant({ ...base, exitBehavior: "restart" });
    expect(result).toEqual({ type: "none" });
  });

  it("returns exit-error when exitBehavior is undefined", () => {
    const result = getRestartBannerVariant({ ...base, exitBehavior: undefined });
    expect(result).toEqual({ type: "exit-error", exitCode: 1 });
  });

  it("preserves the exit code in the exit-error variant", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: 137 });
    expect(result).toEqual({ type: "exit-error", exitCode: 137 });
  });

  it("returns auto-restarting when isAutoRestarting is true and no other errors are present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      reconnectError: undefined,
      spawnError: undefined,
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("returns none when isAutoRestarting is true but reconnectError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      reconnectError: {
        message: "lost connection",
        code: "RECONNECT_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when isAutoRestarting is true but spawnError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      spawnError: {
        message: "spawn failed",
        code: "SPAWN_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when isAutoRestarting is true but restartError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      restartError: {
        message: "failed",
        code: "RESTART_FAILED",
        timestamp: Date.now(),
        recoverable: false,
      },
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none for exit-error when spawnError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      spawnError: {
        message: "spawn failed",
        code: "SPAWN_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none for exit-error when reconnectError is present", () => {
    const result = getRestartBannerVariant({
      ...base,
      reconnectError: {
        message: "lost connection",
        code: "RECONNECT_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none for exit-error candidate when backendStatus is disconnected", () => {
    const result = getRestartBannerVariant({ ...base, backendStatus: "disconnected" });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none for exit-error candidate when backendStatus is recovering", () => {
    const result = getRestartBannerVariant({ ...base, backendStatus: "recovering" });
    expect(result).toEqual({ type: "none" });
  });

  it("returns auto-restarting when backendStatus is disconnected and auto-restart conditions are met", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      backendStatus: "disconnected",
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("returns auto-restarting when backendStatus is recovering and auto-restart conditions are met", () => {
    const result = getRestartBannerVariant({
      ...base,
      isAutoRestarting: true,
      backendStatus: "recovering",
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });
});

describe("getRestartBannerVariant — session-resume-unavailable (issue #9802)", () => {
  // A panel that resumed cleanly: not exited, no errors. Isolates the
  // sessionLostOnRestore signal from the exit-error path.
  const restored: RestartBannerInput = {
    isExited: false,
    exitCode: null,
    dismissedRestartPrompt: false,
    restartError: undefined,
    isRestarting: false,
    isAutoRestarting: false,
    exitBehavior: "keep",
    backendStatus: "connected",
  };

  it("returns session-resume-unavailable when restore fell through to a fresh launch", () => {
    const result = getRestartBannerVariant({ ...restored, sessionLostOnRestore: true });
    expect(result).toEqual({ type: "session-resume-unavailable" });
  });

  it("returns none when sessionLostOnRestore is absent (resumed normally)", () => {
    const result = getRestartBannerVariant({ ...restored, sessionLostOnRestore: false });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none once dismissal consumed the signal (issues #10823, #11589)", () => {
    // The banner is dismissable, and dismissing it clears `sessionLostOnRestore`
    // in the panel store rather than setting a second flag — so a cleared signal
    // is exactly what an acknowledged banner looks like to this policy.
    const result = getRestartBannerVariant({ ...restored, sessionLostOnRestore: undefined });
    expect(result).toEqual({ type: "none" });
  });

  it("stays visible when only dismissedRestartPrompt is set — independent flags (#10823)", () => {
    // Dismissing an exit-error prompt must not hide a lost-session acknowledgement.
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      dismissedRestartPrompt: true,
    });
    expect(result).toEqual({ type: "session-resume-unavailable" });
  });

  it("surfaces exit-error after the lost-session banner is dismissed (#10823)", () => {
    // Acknowledging the lost session clears only `sessionLostOnRestore` and
    // never touches `dismissedRestartPrompt`, so a crash of the fresh session
    // that followed must still get its own banner.
    const result = getRestartBannerVariant({
      ...restored,
      isExited: true,
      exitCode: 1,
      sessionLostOnRestore: undefined,
      dismissedRestartPrompt: false,
    });
    expect(result).toEqual({ type: "exit-error", exitCode: 1 });
  });

  it("ignores backendStatus — the lost session is independent of host connectivity", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      backendStatus: "disconnected",
    });
    expect(result).toEqual({ type: "session-resume-unavailable" });
  });

  it("yields to an in-flight restart (isRestarting wins)", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      isRestarting: true,
    });
    expect(result).toEqual({ type: "restarting" });
  });

  it("yields to auto-restart (isAutoRestarting wins)", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      isAutoRestarting: true,
    });
    expect(result).toEqual({ type: "auto-restarting" });
  });

  it("suppresses while a restartError is present", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      restartError: {
        message: "failed",
        code: "RESTART_FAILED",
        timestamp: Date.now(),
        recoverable: false,
      },
    });
    expect(result).toEqual({ type: "none" });
  });

  it("suppresses while a reconnectError is present", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      reconnectError: {
        message: "lost connection",
        code: "RECONNECT_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("suppresses while a spawnError is present", () => {
    const result = getRestartBannerVariant({
      ...restored,
      sessionLostOnRestore: true,
      spawnError: {
        message: "spawn failed",
        code: "SPAWN_FAILED",
        timestamp: Date.now(),
      } as never,
    });
    expect(result).toEqual({ type: "none" });
  });

  it("takes precedence over exit-error when both signals are present", () => {
    const result = getRestartBannerVariant({
      ...restored,
      isExited: true,
      exitCode: 1,
      sessionLostOnRestore: true,
    });
    expect(result).toEqual({ type: "session-resume-unavailable" });
  });
});
