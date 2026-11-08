import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __codexContextUsageWaiters,
  readCodexPaneContextUsage,
  readCodexPaneContextUsageWithin,
} from "../CodexContextUsage.js";
import type { CodexRolloutObservation } from "../CodexSessionFileProbe.js";
import type { AgentContextUsageResult } from "../../../../shared/types/ipc/agentContextUsage.js";
import type { AgentSessionFileUnknownReason } from "../../../../shared/types/agentSessionFile.js";

const THREAD = "01a1aa03-00d7-7912-a330-ff2ef9006988";

type PaneRecord = {
  spawnedAt: number;
  launchGeneration?: number;
  agentIncarnation?: number;
  agentSessionId?: string;
  detectedAgentId?: string;
  launchAgentId?: string;
  agentState?: string;
  hasPty?: boolean;
  isExited?: boolean;
};

const LIVE: PaneRecord = {
  spawnedAt: 1_000,
  launchGeneration: 1,
  agentIncarnation: 0,
  detectedAgentId: "codex",
  hasPty: true,
};

const OBSERVED: CodexRolloutObservation = {
  status: "observed",
  sessionId: THREAD,
  path: `/Users/x/.codex/sessions/2026/11/05/rollout-2026-11-05T06-41-26-${THREAD}.jsonl`,
  device: "0x1000010",
  inode: "123456",
};

const OK: AgentContextUsageResult = {
  status: "ok",
  provider: "codex",
  contextTokens: 192_480,
  contextWindow: 475_000,
  recordedAt: Date.parse("2026-11-05T14:27:11.051Z"),
};

const getTerminalAsync = vi.fn<(id: string) => Promise<PaneRecord | null>>();
const getTerminalInfo =
  vi.fn<(id: string) => Promise<(PaneRecord & { ptyPid?: number }) | null>>();
const observe = vi.fn<(pid: number) => Promise<CodexRolloutObservation>>();
const read = vi.fn<
  (rollout: CodexRolloutObservation, options: { signal?: AbortSignal }) => Promise<AgentContextUsageResult>
>();

function deps() {
  return {
    ptyClient: { getTerminalAsync, getTerminalInfo } as never,
    platform: "darwin" as NodeJS.Platform,
    observe: observe as never,
    read: read as never,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  getTerminalAsync.mockReset();
  getTerminalAsync.mockResolvedValue(LIVE);
  getTerminalInfo.mockReset();
  getTerminalInfo.mockImplementation(async () => ({ ...LIVE, ptyPid: 4242 }));
  observe.mockReset();
  observe.mockResolvedValue(OBSERVED);
  read.mockReset();
  read.mockResolvedValue(OK);
});

describe("readCodexPaneContextUsage (#16408)", () => {
  it("reads the rollout the pane's own Codex process holds open", async () => {
    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual(OK);

    // The process id comes from the host's record, never the caller.
    expect(observe).toHaveBeenCalledWith(4242);
    expect(read).toHaveBeenCalledWith(OBSERVED, expect.objectContaining({ signal: expect.anything() }));
  });

  it("reads a Codex typed into a shell, with no session id on record", async () => {
    const shellPane = { ...LIVE, launchAgentId: undefined, agentIncarnation: 2 };
    getTerminalAsync.mockResolvedValue(shellPane);
    getTerminalInfo.mockResolvedValue({ ...shellPane, ptyPid: 4242 });

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual(OK);
  });

  it.each<[string, PaneRecord | null, string]>([
    ["an unknown terminal", null, "terminal-unknown"],
    ["another agent", { ...LIVE, detectedAgentId: "claude" }, "provider-mismatch"],
    ["an agent that exited", { ...LIVE, isExited: true }, "provider-mismatch"],
    ["a plain shell", { ...LIVE, detectedAgentId: undefined }, "provider-mismatch"],
  ])("probes nothing for %s", async (_label, pane, reason) => {
    getTerminalAsync.mockResolvedValue(pane);

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual({
      status: "unavailable",
      reason,
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it("probes nothing on Windows", async () => {
    expect(
      await readCodexPaneContextUsage("t-1", signal(), { ...deps(), platform: "win32" })
    ).toEqual({ status: "unavailable", reason: "unsupported-platform" });
    expect(getTerminalInfo).not.toHaveBeenCalled();
  });

  it.each<[string, (PaneRecord & { ptyPid?: number }) | null, string]>([
    ["no diagnostic record", null, "terminal-unknown"],
    ["a respawn since", { ...LIVE, spawnedAt: 2_000, ptyPid: 4242 }, "pane-changed"],
    ["another agent run since", { ...LIVE, agentIncarnation: 1, ptyPid: 4242 }, "pane-changed"],
    ["no process", { ...LIVE, hasPty: false }, "provider-mismatch"],
  ])("probes nothing when the host reports %s", async (_label, diagnostic, reason) => {
    getTerminalInfo.mockResolvedValue(diagnostic);

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual({
      status: "unavailable",
      reason,
    });
    expect(observe).not.toHaveBeenCalled();
  });

  it.each<[AgentSessionFileUnknownReason, string]>([
    ["not-observed", "rollout-unknown"],
    ["ambiguous", "rollout-unknown"],
    ["unverified", "rollout-unknown"],
    ["probe-failed", "probe-failed"],
    ["pane-changed", "pane-changed"],
    ["unsupported-platform", "unsupported-platform"],
    ["no-live-agent", "terminal-unknown"],
  ])("reads nothing when the probe answers %s", async (probeReason, reason) => {
    observe.mockResolvedValue({ status: "unknown", reason: probeReason });

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual({
      status: "unavailable",
      reason,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("passes on what the rollout said when it gave no reading", async () => {
    read.mockResolvedValue({ status: "unavailable", reason: "unrecognized" });

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual({
      status: "unavailable",
      reason: "unrecognized",
    });
  });

  it.each<[string, PaneRecord | null]>([
    ["restarted", { ...LIVE, spawnedAt: 2_000 }],
    ["relaunched", { ...LIVE, launchGeneration: 2 }],
    ["started Codex again", { ...LIVE, agentIncarnation: 1 }],
    ["moved session", { ...LIVE, agentSessionId: THREAD }],
    ["left Codex", { ...LIVE, detectedAgentId: "claude" }],
    ["gone", null],
  ])("drops a reading when the pane %s during the read", async (_label, after) => {
    getTerminalAsync.mockResolvedValueOnce(LIVE).mockResolvedValueOnce(after);

    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual({
      status: "unavailable",
      reason: "pane-changed",
    });
  });

  it("starts no probe once its caller has stopped waiting", async () => {
    const controller = new AbortController();
    getTerminalInfo.mockImplementation(async () => {
      controller.abort();
      return { ...LIVE, ptyPid: 4242 };
    });

    await expect(readCodexPaneContextUsage("t-1", controller.signal, deps())).rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
  });
});

describe("readCodexPaneContextUsageWithin", () => {
  it("answers at the deadline even when the probe never returns", async () => {
    let settle: (value: CodexRolloutObservation) => void = () => {};
    observe.mockImplementation(() => new Promise((resolve) => (settle = resolve)));

    const result = await readCodexPaneContextUsageWithin("t-1", { ...deps(), deadlineMs: 20 });

    expect(result).toEqual({ status: "unavailable", reason: "store-unreadable" });
    // A second caller is answered at its own deadline, not queued behind the stall.
    expect(await readCodexPaneContextUsageWithin("t-1", { ...deps(), deadlineMs: 20 })).toEqual({
      status: "unavailable",
      reason: "store-unreadable",
    });
    expect(observe).toHaveBeenCalledTimes(1);
    expect(__codexContextUsageWaiters("t-1")).toBe(0);
    settle(OBSERVED);
  });

  it("answers the read's own result when it comes in time", async () => {
    expect(await readCodexPaneContextUsageWithin("t-1-fresh", deps())).toEqual(OK);
  });

  it("answers store-unreadable rather than throwing for a read that fails", async () => {
    read.mockRejectedValue(new Error("EIO: /Users/x/.codex/sessions/…"));

    expect(await readCodexPaneContextUsageWithin("t-1-failing", deps())).toEqual({
      status: "unavailable",
      reason: "store-unreadable",
    });
  });
});
