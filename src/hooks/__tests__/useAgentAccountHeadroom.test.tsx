// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ClaudeUsageAccount, CodexQuotaProfile } from "@shared/types/ipc/agentQuota";

const readCodex = vi.hoisted(() => vi.fn<() => Promise<CodexQuotaProfile[]>>());
const readClaude = vi.hoisted(() => vi.fn<() => Promise<ClaudeUsageAccount[]>>());
vi.mock("@/clients/codexClient", () => ({
  codexClient: { readQuota: () => readCodex(), refreshQuota: () => readCodex() },
}));
vi.mock("@/clients/claudeClient", () => ({ claudeClient: { readUsage: () => readClaude() } }));

import { useAgentAccountHeadroom } from "../useAgentAccountHeadroom";

const MINUTE = 60_000;

const codexProfile: CodexQuotaProfile = {
  key: "k",
  isDefault: false,
  presetNames: [],
  accountIds: ["work"],
  result: {
    status: "ok",
    planType: null,
    windows: [{ usedPercent: 70, windowDurationMins: 10080, resetsAt: null }],
    fetchedAt: Date.now(),
  },
};

const claudeAccount: ClaudeUsageAccount = {
  key: "c",
  kind: "account",
  accountNames: ["Work"],
  accountIds: ["work"],
  readings: [
    {
      window: "weekly limit",
      statement: "used",
      usedPercent: 60,
      resetsAt: null,
      observedAt: Date.now(),
      terminalId: "t",
      paneTitle: null,
      projectName: null,
    },
  ],
};

const work = { kind: "account", accountId: "work" } as const;

describe("useAgentAccountHeadroom (#16407)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    readCodex.mockReset().mockResolvedValue([codexProfile]);
    readClaude.mockReset().mockResolvedValue([claudeAccount]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads nothing while the surface is closed", async () => {
    const { result } = renderHook(() => useAgentAccountHeadroom("codex", false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 2);
    });
    expect(readCodex).not.toHaveBeenCalled();
    expect(readClaude).not.toHaveBeenCalled();
    expect(result.current(work)).toBeUndefined();
  });

  it("asks Codex for its quota once opened, and not Claude's readings", async () => {
    const { result } = renderHook(() => useAgentAccountHeadroom("codex", true));
    await act(async () => {});
    expect(readCodex).toHaveBeenCalledTimes(1);
    expect(readClaude).not.toHaveBeenCalled();
    expect(result.current(work)?.text).toBe("Weekly limit 70% used");
  });

  it("collects Claude Code's observed readings once opened, and not Codex's quota", async () => {
    const { result } = renderHook(() => useAgentAccountHeadroom("claude", true));
    await act(async () => {});
    expect(readClaude).toHaveBeenCalledTimes(1);
    expect(readCodex).not.toHaveBeenCalled();
    expect(result.current(work)?.text).toBe("Weekly limit 60% used · observed just now");
  });

  it("reads for neither when the agent has no account quota", async () => {
    renderHook(() => useAgentAccountHeadroom("gemini", true));
    await act(async () => {});
    expect(readCodex).not.toHaveBeenCalled();
    expect(readClaude).not.toHaveBeenCalled();
  });

  it("stops reading when the surface closes, and reads again on the next opening", async () => {
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => useAgentAccountHeadroom("codex", open),
      { initialProps: { open: true } }
    );
    await act(async () => {});
    expect(readCodex).toHaveBeenCalledTimes(1);

    rerender({ open: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 3);
    });
    expect(readCodex).toHaveBeenCalledTimes(1);

    rerender({ open: true });
    await act(async () => {});
    expect(readCodex).toHaveBeenCalledTimes(2);
  });

  it("ages a reading while the surface stays open", async () => {
    const { result } = renderHook(() => useAgentAccountHeadroom("claude", true));
    await act(async () => {});
    expect(result.current(work)?.text).toMatch(/observed just now$/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE * 5);
    });
    expect(result.current(work)?.text).toMatch(/observed 5m ago$/);
  });
});
