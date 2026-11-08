import { describe, expect, it, vi } from "vitest";

vi.mock("../../../window/serviceRefs.js", () => ({ getPtyClient: () => null }));
vi.mock("../../../services/DriveLeaseService.js", () => ({ peekDriveLeaseService: () => null }));
vi.mock("../../../../shared/config/agentRegistry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../shared/config/agentRegistry.js")>();
  return {
    ...actual,
    getEffectiveAgentConfig: (id: string) =>
      id === "queuer"
        ? { capabilities: { queuesInputWhileWorking: true } }
        : id === "plain"
          ? { capabilities: {} }
          : actual.getEffectiveAgentConfig(id),
  };
});

import { holdsComposerSend } from "../composerHold.js";
import type { NotifyTerminalInfo } from "../../../services/mcp-server/terminalNotify.js";

function info(overrides: Partial<NotifyTerminalInfo> = {}): NotifyTerminalInfo {
  return { agentState: "working", detectedAgentId: "gemini", hasPty: true, ...overrides };
}

describe("holdsComposerSend", () => {
  it("holds for a working agent not declared to queue input", () => {
    expect(holdsComposerSend(info())).toBe(true);
  });

  it("keeps the immediate send for any CLI declared to queue input mid-turn", () => {
    expect(holdsComposerSend(info({ detectedAgentId: "queuer" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: "plain" }))).toBe(true);
    expect(holdsComposerSend(info({ detectedAgentId: "claude" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: "codex" }))).toBe(false);
  });

  it("keeps the immediate send at any prompt, idle, and in a shell", () => {
    expect(holdsComposerSend(info({ agentState: "waiting", waitingReason: "prompt" }))).toBe(false);
    expect(holdsComposerSend(info({ agentState: "waiting", waitingReason: "question" }))).toBe(
      false
    );
    expect(holdsComposerSend(info({ agentState: "idle" }))).toBe(false);
    expect(holdsComposerSend(info({ detectedAgentId: undefined }))).toBe(false);
  });

  it("never holds for a pane that is gone or going", () => {
    expect(holdsComposerSend(null)).toBe(false);
    expect(holdsComposerSend(info({ hasPty: false }))).toBe(false);
    expect(holdsComposerSend(info({ isExited: true }))).toBe(false);
    expect(holdsComposerSend(info({ isTrashed: true }))).toBe(false);
    expect(holdsComposerSend(info({ isClosing: true }))).toBe(false);
  });
});
