import { describe, it, expect } from "vitest";
import { getTerminalRefreshTier } from "../panelStore";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { TerminalInstance } from "@shared/types";

// Pure unit tests for the refresh-tier gate that decides which panels are
// eligible to hibernate. Uses durable agent affinity so a toolbar-launched or
// restored agent terminal stays active until a strong exit signal arrives.

function makeTerminal(overrides: Partial<TerminalInstance>): TerminalInstance {
  return {
    id: overrides.id ?? "t-1",
    title: "test",
    cwd: "/test",
    location: "grid",
    isVisible: true,
    cols: 80,
    rows: 24,
    ...overrides,
  } as TerminalInstance;
}

describe("getTerminalRefreshTier - runtime agent identity", () => {
  it("keeps a launch-affinity agent terminal VISIBLE when detection is not currently set", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: undefined,
      everDetectedAgent: true,
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("keeps a promoted shell (kind:terminal + detectedAgentId) at VISIBLE", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: "claude",
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("drops a demoted launch-affinity terminal after explicit agent exit", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: undefined,
      everDetectedAgent: true,
      agentState: "exited",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops an exited agent even when detectedAgentId is still set (race guard)", () => {
    // Covers the race between onAgentExited and the process-detector exit event.
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "exited",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a completed agent to BACKGROUND", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "completed",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("returns FOCUSED for a working agent regardless of focus or identity", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("returns FOCUSED when the terminal is focused, regardless of agent state", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, true)).toBe(TerminalRefreshTier.FOCUSED);
  });

  it("keeps an armed live fleet terminal VISIBLE before agent detection catches up", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
    });
    expect(getTerminalRefreshTier(terminal, false, { isFleetArmed: true })).toBe(
      TerminalRefreshTier.VISIBLE
    );
  });

  it("does not keep an armed exited terminal VISIBLE", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "exited",
    });
    expect(getTerminalRefreshTier(terminal, false, { isFleetArmed: true })).toBe(
      TerminalRefreshTier.BACKGROUND
    );
  });

  it("returns VISIBLE when the terminal reference is missing (defensive default)", () => {
    expect(getTerminalRefreshTier(undefined, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("keeps a live plain non-agent terminal VISIBLE when unfocused", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("keeps a working non-agent terminal VISIBLE when unfocused", () => {
    // Regression guard for #7997 — long-running commands (builds, dev servers)
    // in plain shells must keep streaming after the user moves focus away.
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("drops a working non-agent terminal once its process has exited", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "exited",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a working non-agent terminal in error state", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "error",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a working non-agent terminal without a PTY", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: false,
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a working non-agent terminal located in trash", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      location: "trash",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a working non-agent terminal located in background", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      location: "background",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("keeps a live non-agent terminal VISIBLE even when activityStatus is waiting", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "waiting",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("drops an offscreen live terminal to BACKGROUND", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      isVisible: false,
      runtimeStatus: "background",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a working terminal located in dock to BACKGROUND", () => {
    // Mirrors the fleet-armed guard above — docked panels stay hibernation-eligible
    // regardless of activity state, so hidden dock entries don't consume render budget.
    const terminal = makeTerminal({
      kind: "terminal",
      location: "dock",
      detectedAgentId: undefined,
      agentState: "idle",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a completed agent shell to BACKGROUND even when activityStatus is stale 'working'", () => {
    // The activity backend can lag the agent-state machine — a completed agent
    // shell with a still-running PTY must not bypass hibernation through the
    // working-terminal guard.
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: "claude",
      agentState: "completed",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops an exited agent shell to BACKGROUND even when activityStatus is stale 'working'", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      launchAgentId: "claude",
      detectedAgentId: undefined,
      everDetectedAgent: true,
      agentState: "exited",
      hasPty: true,
      runtimeStatus: "running",
      activityStatus: "working",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });
});
