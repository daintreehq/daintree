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

// The client only coalesces IN-FLIGHT requests; the 30s completed-result cache
// lives in the Main-process discovery engine (avoids compounded staleness).
describe("slashCommandsClient in-flight coalescing", () => {
  beforeEach(async () => {
    vi.resetModules();
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
    delete typedGlobal.window;
  });

  it("coalesces concurrent calls with the same arguments into one IPC call", async () => {
    const p1 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    const p2 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(p1).toBe(p2);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(r1).toBe(r2);
    expect(r1).toEqual(stubCommands);
  });

  it("does NOT cache a settled result — a later sequential call re-fetches", async () => {
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight entry on rejection so the next call retries", async () => {
    mockList.mockRejectedValueOnce(new Error("fail"));

    await expect(
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" })
    ).rejects.toThrow("fail");

    mockList.mockResolvedValueOnce(stubCommands);
    const result = await slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(result).toEqual(stubCommands);
  });

  it("does not coalesce calls with different agentId", async () => {
    await Promise.all([
      slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" }),
      slashCommandsClient.list({ agentId: "gemini", projectPath: "/proj" }),
    ]);

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("does not coalesce calls with different projectPath", async () => {
    await Promise.all([
      slashCommandsClient.list({ agentId: "claude", projectPath: "/a" }),
      slashCommandsClient.list({ agentId: "claude", projectPath: "/b" }),
    ]);

    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("clearCache drops a still-pending in-flight entry so the next call re-issues", async () => {
    let resolveFirst: (value: SlashCommand[]) => void = () => {};
    mockList.mockImplementationOnce(
      () =>
        new Promise<SlashCommand[]>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const p1 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });
    // p1 is still pending; clearing must drop it so a fresh request is issued.
    slashCommandsClient.clearCache();
    const p2 = slashCommandsClient.list({ agentId: "claude", projectPath: "/proj" });

    expect(p1).not.toBe(p2);
    expect(mockList).toHaveBeenCalledTimes(2);

    resolveFirst(stubCommands);
    await Promise.all([p1, p2]);
  });
});
