import { afterEach, describe, expect, it, vi } from "vitest";
import type { PtyClient } from "../PtyClient.js";
import type { SlashCommand } from "../../../shared/types/slashCommands.js";

const listMock = vi.fn<(agentId: string, projectPath?: string) => Promise<SlashCommand[]>>();

vi.mock("../SlashCommandService.js", () => ({
  slashCommandService: { list: (...args: [string, string?]) => listMock(...args) },
}));

vi.mock("../assistantTerminal.js", () => ({
  isAssistantTerminalRecord: (terminal: { isAssistantTerminal?: boolean } | null) =>
    terminal?.isAssistantTerminal === true,
}));

vi.mock("../../utils/logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

const { resolveVoiceCommandTarget } = await import("../voiceCommandTarget.js");

function ptyWith(terminal: Record<string, unknown> | null): PtyClient {
  return { getTerminalAsync: vi.fn(async () => terminal) } as unknown as PtyClient;
}

const reviewSkill: SlashCommand = {
  id: "project:skill:ship-it",
  label: "/ship-it",
  insertText: "/ship-it",
  description: "Ship it",
  scope: "project",
  agentId: "claude",
  kind: "skill",
  trigger: "/",
};

describe("resolveVoiceCommandTarget", () => {
  afterEach(() => {
    vi.useRealTimers();
    listMock.mockReset();
  });

  it("discovers the commands of the agent the terminal runs, in its cwd", async () => {
    listMock.mockResolvedValue([reviewSkill]);
    const target = await resolveVoiceCommandTarget(
      ptyWith({ id: "t1", cwd: "/repo/app", launchAgentId: "codex", detectedAgentId: "claude" }),
      "t1",
      500
    );
    expect(listMock).toHaveBeenCalledWith("claude", "/repo/app");
    expect(target).toMatchObject({ agentId: "claude", agentName: "Claude", isAssistant: false });
    expect(target!.vocabulary.entries.map((entry) => entry.token)).toEqual(["/ship-it"]);
  });

  it("names the Assistant, with its own agent's commands", async () => {
    listMock.mockResolvedValue([]);
    const target = await resolveVoiceCommandTarget(
      ptyWith({ id: "t1", cwd: "/assistant", launchAgentId: "claude", isAssistantTerminal: true }),
      "t1",
      500
    );
    expect(target).toMatchObject({ agentId: "claude", isAssistant: true });
    expect(listMock).toHaveBeenCalledWith("claude", "/assistant");
  });

  it("falls back to the agent's built-ins when discovery runs out of time", async () => {
    vi.useFakeTimers();
    listMock.mockReturnValue(new Promise(() => {}));
    const pending = resolveVoiceCommandTarget(
      ptyWith({ id: "t1", cwd: "/repo", launchAgentId: "codex" }),
      "t1",
      500
    );
    await vi.advanceTimersByTimeAsync(600);
    const target = await pending;
    const tokens = target!.vocabulary.entries.map((entry) => entry.token);
    expect(tokens).toContain("/compact");
    expect(target!.vocabulary.entries.every((entry) => entry.scope === "built-in")).toBe(true);
  });

  it.each([
    ["a plain shell", { id: "t1", cwd: "/repo" }],
    ["a missing terminal", null],
  ])("resolves nothing for %s", async (_label, terminal) => {
    expect(await resolveVoiceCommandTarget(ptyWith(terminal), "t1", 500)).toBeNull();
    expect(listMock).not.toHaveBeenCalled();
  });

  it("resolves nothing without a terminal", async () => {
    expect(await resolveVoiceCommandTarget(ptyWith(null), undefined, 500)).toBeNull();
  });

  it("doesn't scan a relative cwd", async () => {
    listMock.mockResolvedValue([]);
    await resolveVoiceCommandTarget(
      ptyWith({ id: "t1", cwd: "relative", launchAgentId: "claude" }),
      "t1",
      500
    );
    expect(listMock).toHaveBeenCalledWith("claude", undefined);
  });
});
