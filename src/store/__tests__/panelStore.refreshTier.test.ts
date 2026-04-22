import { describe, it, expect } from "vitest";
import { getTerminalRefreshTier } from "../panelStore";
import { TerminalRefreshTier } from "@shared/types/panel";
import type { TerminalInstance } from "@shared/types";

// Pure unit tests for the refresh-tier gate that decides which panels are
// eligible to hibernate. Uses runtime-detected agent identity (#5772) so that
// a panel spawned as an agent but no longer running one can drop to BACKGROUND.

function makeTerminal(overrides: Partial<TerminalInstance>): TerminalInstance {
  return {
    id: overrides.id ?? "t-1",
    title: "test",
    type: "terminal",
    cwd: "/test",
    location: "grid",
    isVisible: true,
    cols: 80,
    rows: 24,
    ...overrides,
  } as TerminalInstance;
}

describe("getTerminalRefreshTier - runtime agent identity", () => {
  it("drops a demoted ex-agent (detection fired then cleared) to BACKGROUND", () => {
    // everDetectedAgent distinguishes "boot window" from "exited agent" — the
    // sticky flag is set on first detection and never cleared, so a panel whose
    // detectedAgentId is now undefined but everDetectedAgent is true is a
    // genuine ex-agent and should be free to hibernate.
    const terminal = makeTerminal({
      kind: "terminal",
      agentId: "claude",
      detectedAgentId: undefined,
      everDetectedAgent: true,
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("keeps a promoted shell (kind:terminal + detectedAgentId) at VISIBLE", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: "claude",
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("keeps a freshly-spawned agent at VISIBLE during the boot window (before detection)", () => {
    // detectedAgentId is undefined during the first few seconds; the spawn-time
    // fallback keeps the panel at VISIBLE so it doesn't immediately hibernate.
    const terminal = makeTerminal({
      kind: "terminal",
      agentId: "claude",
      detectedAgentId: undefined,
      agentState: "idle",
    });
    // Boot window behaviour matches the current guard: without state override,
    // the spawn-time fallback holds.
    expect(getTerminalRefreshTier({ ...terminal, agentState: undefined }, false)).toBe(
      TerminalRefreshTier.VISIBLE
    );
  });

  it("drops an exited agent even when detectedAgentId is still set (race guard)", () => {
    // Covers the race between onAgentExited and the process-detector exit event.
    const terminal = makeTerminal({
      kind: "terminal",
      agentId: "claude",
      detectedAgentId: "claude",
      agentState: "exited",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });

  it("drops a completed agent to BACKGROUND", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      agentId: "claude",
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

  it("returns VISIBLE when the terminal reference is missing (defensive default)", () => {
    expect(getTerminalRefreshTier(undefined, false)).toBe(TerminalRefreshTier.VISIBLE);
  });

  it("drops a plain non-agent terminal to BACKGROUND when unfocused", () => {
    const terminal = makeTerminal({
      kind: "terminal",
      detectedAgentId: undefined,
      agentState: "idle",
    });
    expect(getTerminalRefreshTier(terminal, false)).toBe(TerminalRefreshTier.BACKGROUND);
  });
});
