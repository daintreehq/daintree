import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalRetentionCoordinator } from "../TerminalRetentionCoordinator.js";
import type { TerminalProcess } from "../TerminalProcess.js";

interface MockTerminalSpec {
  id: string;
  launchAgentId?: string;
  detectedAgentId?: string;
  everDetectedAgent?: boolean;
  agentState?: string;
  activityTier?: "active" | "background";
  hasPreservedSnapshot?: boolean;
  isExited?: boolean;
  wasKilled?: boolean;
}

function mockTerminal(spec: MockTerminalSpec) {
  const applyRetentionTier = vi.fn();
  const terminal = {
    id: spec.id,
    getPublicState: () => ({
      id: spec.id,
      launchAgentId: spec.launchAgentId,
      detectedAgentId: spec.detectedAgentId,
      everDetectedAgent: spec.everDetectedAgent,
      agentState: spec.agentState,
      isExited: spec.isExited,
      wasKilled: spec.wasKilled,
    }),
    getActivityTier: () => spec.activityTier ?? "background",
    hasPreservedSnapshot: () => spec.hasPreservedSnapshot === true,
    applyRetentionTier,
  };
  return { terminal: terminal as unknown as TerminalProcess, applyRetentionTier };
}

describe("TerminalRetentionCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("derives and applies the tier for each terminal on a sweep", () => {
    const focusedWorking = mockTerminal({
      id: "a",
      launchAgentId: "claude",
      agentState: "working",
      activityTier: "active",
    });
    const backgroundWorking = mockTerminal({
      id: "b",
      detectedAgentId: "claude",
      agentState: "working",
    });
    const waiting = mockTerminal({ id: "c", launchAgentId: "claude", agentState: "waiting" });
    const trashed = mockTerminal({ id: "d", agentState: "working", launchAgentId: "claude" });
    const preserved = mockTerminal({
      id: "e",
      everDetectedAgent: true,
      hasPreservedSnapshot: true,
      isExited: true,
    });

    const coordinator = new TerminalRetentionCoordinator({
      getTerminals: () =>
        [focusedWorking, backgroundWorking, waiting, trashed, preserved].map((m) => m.terminal),
      isTrashed: (id) => id === "d",
      isFocused: (id) => id === "a",
    });

    coordinator.sweep();

    expect(focusedWorking.applyRetentionTier).toHaveBeenCalledWith("foreground");
    expect(backgroundWorking.applyRetentionTier).toHaveBeenCalledWith("working");
    expect(waiting.applyRetentionTier).toHaveBeenCalledWith("settled");
    expect(trashed.applyRetentionTier).toHaveBeenCalledWith("archived");
    expect(preserved.applyRetentionTier).toHaveBeenCalledWith("archived");
    coordinator.dispose();
  });

  it("sweeps on its interval after start and stops after dispose", () => {
    const working = mockTerminal({ id: "a", launchAgentId: "claude", agentState: "working" });
    const coordinator = new TerminalRetentionCoordinator(
      {
        getTerminals: () => [working.terminal],
        isTrashed: () => false,
        isFocused: () => false,
      },
      1000
    );

    coordinator.start();
    expect(working.applyRetentionTier).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(working.applyRetentionTier).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(working.applyRetentionTier).toHaveBeenCalledTimes(3);

    coordinator.dispose();
    vi.advanceTimersByTime(5000);
    expect(working.applyRetentionTier).toHaveBeenCalledTimes(3);
  });

  it("isolates a throwing terminal so the rest of the sweep still applies", () => {
    const broken = mockTerminal({ id: "a" });
    (broken.terminal as unknown as { getPublicState: () => never }).getPublicState = () => {
      throw new Error("boom");
    };
    const healthy = mockTerminal({ id: "b", launchAgentId: "claude", agentState: "working" });

    const coordinator = new TerminalRetentionCoordinator({
      getTerminals: () => [broken.terminal, healthy.terminal],
      isTrashed: () => false,
      isFocused: () => false,
    });

    expect(() => coordinator.sweep()).not.toThrow();
    expect(healthy.applyRetentionTier).toHaveBeenCalledWith("working");
    coordinator.dispose();
  });
});
