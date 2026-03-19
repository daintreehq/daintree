import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SlashCommand } from "@shared/types";

const mockList = vi.fn<() => Promise<SlashCommand[]>>();

const typedGlobal = globalThis as unknown as Record<string, unknown>;

let slashCommandsClient: typeof import("../slashCommandsClient").slashCommandsClient;

const stubCommands: SlashCommand[] = [
  {
    id: "test",
    label: "/test",
    description: "Test command",
    scope: "built-in",
    agentId: "claude",
  },
];

describe("slashCommandsClient caching", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    mockList.mockReset();
    mockList.mockResolvedValue(stubCommands);

    typedGlobal.window = {
      electron: {
        slashCommands: { list: mockList },
      },
    };

    const mod = await import("../slashCommandsClient");
    slashCommandsClient = mod.slashCommandsClient;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete typedGlobal.window;
  });

  it("deduplicates concurrent calls with the same arguments", async () => {
    const [r1, r2] = await Promise.all([
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" }),
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" }),
    ]);

    expect(mockList).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
  });

  it("returns cached result within TTL", async () => {
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    await vi.advanceTimersByTimeAsync(10_000);
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("fetches again after TTL expires", async () => {
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    await vi.advanceTimersByTimeAsync(30_001);
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("does not cache rejected promises", async () => {
    mockList.mockRejectedValueOnce(new Error("fail"));

    await expect(
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" })
    ).rejects.toThrow("fail");

    mockList.mockResolvedValueOnce(stubCommands);
    const result = await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result).toEqual(stubCommands);
  });

  it("does not deduplicate calls with different agentId", async () => {
    await Promise.all([
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" }),
      slashCommandsClient.list({ agentId: "gemini", projectPath: "/proj" }),
    ]);

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("does not deduplicate calls with different projectPath", async () => {
    await Promise.all([
      slashCommandsClient.list({ agentId: "claude", projectPath: "/a" }),
      slashCommandsClient.list({ agentId: "claude", projectPath: "/b" }),
    ]);

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("clearCache forces a fresh fetch", async () => {
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    slashCommandsClient.clearCache();
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers both receive the same data on shared promise", async () => {
    const p1 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    const p2 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(stubCommands);
    expect(r2).toEqual(stubCommands);
  });
});
