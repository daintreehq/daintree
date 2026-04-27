import { describe, expect, it } from "vitest";
import type { PtyPanelData } from "@shared/types/panel";
import { reduceAgentDetected, reduceAgentExited } from "../identityReducer";

function makeTerminal(overrides: Partial<PtyPanelData> = {}): PtyPanelData {
  return {
    id: "term-1",
    kind: "terminal",
    title: "Terminal",
    cwd: "/tmp",
    cols: 80,
    rows: 24,
    location: "grid",
    ...overrides,
  };
}

describe("reduceAgentDetected", () => {
  it("returns null when nothing changes", () => {
    const terminal = makeTerminal({
      detectedProcessId: "npm",
      runtimeIdentity: { kind: "process", id: "npm", iconId: "npm", processId: "npm" },
    });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: undefined,
      nextDetectedProcessId: "npm",
      nextEverDetectedAgent: undefined,
      timestamp: 1000,
    });
    expect(result).toBeNull();
  });

  it("applies detectedProcessId for non-agent process detections", () => {
    const terminal = makeTerminal();
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: undefined,
      nextDetectedProcessId: "npm",
      nextEverDetectedAgent: undefined,
      timestamp: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.detectedProcessId).toBe("npm");
    expect(result!.patch.runtimeIdentity).toMatchObject({ kind: "process", processId: "npm" });
    expect(result!.shouldPromoteAgentId).toBeNull();
  });

  it("applies detectedAgentId and seeds agentState=idle on first agent detection", () => {
    const terminal = makeTerminal();
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.detectedAgentId).toBe("claude");
    expect(result!.patch.everDetectedAgent).toBe(true);
    expect(result!.patch.agentState).toBe("idle");
    expect(result!.patch.lastStateChange).toBe(5000);
    expect(result!.patch.runtimeIdentity).toMatchObject({ kind: "agent", agentId: "claude" });
    expect(result!.shouldPromoteAgentId).toBe("claude");
  });

  it("sets everDetectedAgent stickily when only that flag is missing", () => {
    const terminal = makeTerminal({
      detectedAgentId: "claude",
      detectedProcessId: "claude",
      runtimeIdentity: {
        kind: "agent",
        id: "claude",
        iconId: "claude",
        agentId: "claude",
        processId: "claude",
      },
      agentState: "idle",
    });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.everDetectedAgent).toBe(true);
    expect(result!.patch.detectedAgentId).toBeUndefined();
    expect(result!.shouldPromoteAgentId).toBeNull();
  });

  it("promotes from process runtime identity to agent runtime identity", () => {
    const terminal = makeTerminal({
      detectedProcessId: "npm",
      runtimeIdentity: { kind: "process", id: "npm", iconId: "npm", processId: "npm" },
    });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.detectedAgentId).toBe("claude");
    expect(result!.patch.detectedProcessId).toBe("claude");
    expect(result!.patch.runtimeIdentity).toMatchObject({ kind: "agent", agentId: "claude" });
    expect(result!.shouldPromoteAgentId).toBe("claude");
  });

  it("does not seed agentState when terminal already has a non-exited state", () => {
    const terminal = makeTerminal({ agentState: "working" });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.agentState).toBeUndefined();
    expect(result!.patch.lastStateChange).toBeUndefined();
  });

  it("re-seeds agentState=idle when previous agent has exited", () => {
    const terminal = makeTerminal({ agentState: "exited" });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.agentState).toBe("idle");
    expect(result!.patch.lastStateChange).toBe(5000);
  });

  it("updates title to agent name when titleMode=default and agent changes", () => {
    const terminal = makeTerminal({ title: "Terminal" });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.title).toBeDefined();
    expect(result!.patch.title).not.toBe("Terminal");
  });

  it("does not update title when titleMode=custom", () => {
    const terminal = makeTerminal({ titleMode: "custom", title: "My Terminal" });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).not.toBeNull();
    expect(result!.patch.title).toBeUndefined();
  });

  it("returns null when every dimension already matches", () => {
    const terminal = makeTerminal({
      detectedAgentId: "claude",
      detectedProcessId: "claude",
      runtimeIdentity: {
        kind: "agent",
        id: "claude",
        iconId: "claude",
        agentId: "claude",
        processId: "claude",
      },
      everDetectedAgent: true,
      agentState: "idle",
    });
    const result = reduceAgentDetected(terminal, {
      nextDetectedAgentId: "claude",
      nextDetectedProcessId: "claude",
      nextEverDetectedAgent: true,
      timestamp: 5000,
    });
    expect(result).toBeNull();
  });
});

describe("reduceAgentExited", () => {
  it("returns null when terminal already has nothing to clear", () => {
    const terminal = makeTerminal();
    const result = reduceAgentExited(terminal, {
      hasAgentType: false,
      exitKind: undefined,
      timestamp: 5000,
    });
    expect(result).toBeNull();
  });

  it("clears all live-detection fields and marks agentState=exited", () => {
    const terminal = makeTerminal({
      detectedProcessId: "claude",
      detectedAgentId: "claude",
      runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      agentState: "working",
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: true,
      exitKind: "subcommand",
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.detectedProcessId).toBeUndefined();
    expect(result!.detectedAgentId).toBeUndefined();
    expect(result!.runtimeIdentity).toBeUndefined();
    expect(result!.agentState).toBe("exited");
    expect(result!.lastStateChange).toBe(9000);
  });

  it("treats exitKind=terminal as a strong exit signal", () => {
    const terminal = makeTerminal({
      detectedProcessId: "claude",
      detectedAgentId: "claude",
      runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      agentState: "idle",
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: false,
      exitKind: "terminal",
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.agentState).toBe("exited");
  });

  it("does not re-mark agentState when already exited", () => {
    const terminal = makeTerminal({
      detectedProcessId: "claude",
      agentState: "exited",
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: true,
      exitKind: "subcommand",
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.agentState).toBeUndefined();
    expect(result!.lastStateChange).toBeUndefined();
    expect(result!.detectedProcessId).toBeUndefined();
  });

  it("clears process-only detection without marking agent exited", () => {
    const terminal = makeTerminal({ detectedProcessId: "npm" });
    const result = reduceAgentExited(terminal, {
      hasAgentType: false,
      exitKind: undefined,
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.detectedProcessId).toBeUndefined();
    expect(result!.agentState).toBeUndefined();
  });

  it("clears process runtimeIdentity on plain process exit", () => {
    const terminal = makeTerminal({
      detectedProcessId: "npm",
      runtimeIdentity: { kind: "process", id: "npm", iconId: "npm", processId: "npm" },
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: false,
      exitKind: undefined,
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.detectedProcessId).toBeUndefined();
    expect(result!.runtimeIdentity).toBeUndefined();
    expect(result!.agentState).toBeUndefined();
    expect(result!.lastStateChange).toBeUndefined();
  });

  it("updates title on demotion when titleMode=default", () => {
    const terminal = makeTerminal({
      detectedAgentId: "claude",
      runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      agentState: "working",
      title: "Claude",
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: true,
      exitKind: "subcommand",
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBeDefined();
    expect(result!.title).not.toBe("Claude");
  });

  it("does not update title when titleMode=custom", () => {
    const terminal = makeTerminal({
      titleMode: "custom",
      detectedAgentId: "claude",
      runtimeIdentity: { kind: "agent", id: "claude", iconId: "claude", agentId: "claude" },
      agentState: "working",
      title: "My Claude",
    });
    const result = reduceAgentExited(terminal, {
      hasAgentType: true,
      exitKind: "subcommand",
      timestamp: 9000,
    });
    expect(result).not.toBeNull();
    expect(result!.title).toBeUndefined();
  });
});
