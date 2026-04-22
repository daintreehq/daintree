import { describe, expect, it } from "vitest";
import {
  getRestartBannerVariant,
  getDegradedBannerVariant,
  type RestartBannerInput,
  type DegradedBannerInput,
} from "../restartStatus";

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
      restartError: {
        message: "failed",
        code: "RESTART_FAILED",
        timestamp: Date.now(),
        recoverable: false,
      },
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

  it("returns exit-error when exitBehavior is undefined", () => {
    const result = getRestartBannerVariant({ ...base, exitBehavior: undefined });
    expect(result).toEqual({ type: "exit-error", exitCode: 1 });
  });

  it("preserves the exit code in the exit-error variant", () => {
    const result = getRestartBannerVariant({ ...base, exitCode: 137 });
    expect(result).toEqual({ type: "exit-error", exitCode: 137 });
  });
});

const degradedBase: DegradedBannerInput = {
  spawnAgentId: undefined,
  everDetectedAgent: true,
  detectedAgentId: "claude",
  dismissedDegradedBanner: false,
  isExited: false,
  isRestarting: false,
};

describe("getDegradedBannerVariant", () => {
  it("shows for a plain terminal that has hosted an agent and still has a detected agent", () => {
    const result = getDegradedBannerVariant(degradedBase);
    expect(result).toEqual({ type: "degraded-mode", agentId: "claude" });
  });

  it("returns none when spawnAgentId is set (cold-spawned agents have correct env+scrollback)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, spawnAgentId: "claude" });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when spawnAgentId is set to a different agent than detected (still cold-spawned)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, spawnAgentId: "gemini" });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when everDetectedAgent is false (no promotion ever happened)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, everDetectedAgent: false });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when detectedAgentId is missing (agent already exited)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, detectedAgentId: undefined });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none when the user has dismissed the banner", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, dismissedDegradedBanner: true });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none while exited (the exit banner takes precedence)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, isExited: true });
    expect(result).toEqual({ type: "none" });
  });

  it("returns none while restarting (avoid flashing the banner during convert)", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, isRestarting: true });
    expect(result).toEqual({ type: "none" });
  });

  it("preserves the detected agent id in the variant", () => {
    const result = getDegradedBannerVariant({ ...degradedBase, detectedAgentId: "gemini" });
    expect(result).toEqual({ type: "degraded-mode", agentId: "gemini" });
  });
});
