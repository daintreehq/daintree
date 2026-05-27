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
