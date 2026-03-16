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
      restartError: { message: "failed", code: "RESTART_FAILED", timestamp: Date.now(), recoverable: false },
    });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when isRestarting is true", () => {
    const result = getRestartBannerVariant({ ...base, isRestarting: true });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when exitBehavior is restart", () => {
    const result = getRestartBannerVariant({ ...base, exitBehavior: "restart" });
    expect(result).toEqual({ type: "none" });
  });

  it("preserves the exit code in the exit-error variant", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: 137 });
    expect(result).toEqual({ type: "exit-error", exitCode: 137 });
  });
});
