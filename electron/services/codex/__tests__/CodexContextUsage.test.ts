import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __codexContextUsageWaiters,
  CODEX_PROBE_MISS_REUSE_MS,
  createCodexProbeMemo,
  readCodexPaneContextUsage,
  readCodexPaneContextUsageWithin,
  type CodexProbeMemo,
} from "../CodexContextUsage.js";
import {
  observeCodexRollout,
  type CodexRolloutObservation,
  type ListingRunner,
} from "../CodexSessionFileProbe.js";
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
const getTerminalInfo = vi.fn<(id: string) => Promise<(PaneRecord & { ptyPid?: number }) | null>>();
const observe = vi.fn<(pid: number) => Promise<CodexRolloutObservation>>();
const read =
  vi.fn<
    (
      rollout: CodexRolloutObservation,
      options: { signal?: AbortSignal }
    ) => Promise<AgentContextUsageResult>
  >();

let clock = 0;
let probes: CodexProbeMemo;

function deps() {
  return {
    ptyClient: { getTerminalAsync, getTerminalInfo } as never,
    platform: "darwin" as NodeJS.Platform,
    observe: observe as never,
    read: read as never,
    probes,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

beforeEach(() => {
  clock = 0;
  probes = createCodexProbeMemo(() => clock);
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
    expect(read).toHaveBeenCalledWith(
      OBSERVED,
      expect.objectContaining({ signal: expect.anything() })
    );
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

const REUSABLE_MISSES = ["not-observed", "unverified", "ambiguous", "probe-failed"] as const;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => (resolve = settle));
  return { promise, resolve };
}

describe("probing a pane across a turn's reads (#17044)", () => {
  it("lists a pane with no rollout to find once for both of a turn's reads", async () => {
    const shell = "4242     1 Mon Nov  2 04:36:27 2026     -zsh";
    const codex = "4243  4242 Mon Nov  2 04:36:27 2026     codex";
    const run = vi.fn<ListingRunner>(async (file, args) => {
      if (file === "lsof") return { stdout: "p4243\n", exitCode: 0 };
      return { stdout: args.includes("-A") ? `${shell}\n${codex}` : codex, exitCode: 0 };
    });
    const listing = {
      ...deps(),
      observe: ((pid: number) => observeCodexRollout(pid, { platform: "darwin", run })) as never,
    };
    const miss = { status: "unavailable", reason: "rollout-unknown" };

    expect(await readCodexPaneContextUsage("t-1", signal(), listing)).toEqual(miss);
    clock += 1_500;
    expect(await readCodexPaneContextUsage("t-1", signal(), listing)).toEqual(miss);
    expect(
      run.mock.calls.map(([file, args]) => `${file} ${args.includes("-A") ? "-A" : ""}`)
    ).toEqual(["ps -A", "lsof ", "ps "]);

    clock += CODEX_PROBE_MISS_REUSE_MS;
    await readCodexPaneContextUsage("t-1", signal(), listing);
    expect(run).toHaveBeenCalledTimes(6);
  });

  it.each(REUSABLE_MISSES)(
    "answers a %s miss again for the same run until it expires",
    async (reason) => {
      observe.mockResolvedValue({ status: "unknown", reason });

      const first = await readCodexPaneContextUsage("t-1", signal(), deps());
      clock += CODEX_PROBE_MISS_REUSE_MS - 1;
      expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual(first);
      expect(observe).toHaveBeenCalledTimes(1);

      clock += 1;
      await readCodexPaneContextUsage("t-1", signal(), deps());
      expect(observe).toHaveBeenCalledTimes(2);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("counts a miss's reuse from when the probe answered, not when it started", async () => {
    observe.mockImplementation(async () => {
      clock += CODEX_PROBE_MISS_REUSE_MS - 500;
      return { status: "unknown", reason: "not-observed" };
    });

    await readCodexPaneContextUsage("t-1", signal(), deps());
    clock += 1_000;
    await readCodexPaneContextUsage("t-1", signal(), deps());

    expect(observe).toHaveBeenCalledTimes(1);
  });

  it.each<AgentSessionFileUnknownReason>(["pane-changed", "no-live-agent", "unsupported-platform"])(
    "looks again right away after a %s answer, which a second listing may not repeat",
    async (reason) => {
      observe.mockResolvedValueOnce({ status: "unknown", reason });

      await readCodexPaneContextUsage("t-1", signal(), deps());
      expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual(OK);
      expect(observe).toHaveBeenCalledTimes(2);
    }
  );

  it("reuses a miss through the memo every caller shares by default", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000_000);
    observe.mockResolvedValue({ status: "unknown", reason: "not-observed" });
    const shared = { ...deps(), probes: undefined };

    try {
      await readCodexPaneContextUsage("t-default-memo", signal(), shared);
      await readCodexPaneContextUsage("t-default-memo", signal(), shared);
      expect(observe).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it("finds the rollout afresh for every reading, so a new conversation's replaces the old", async () => {
    const next: CodexRolloutObservation = {
      ...OBSERVED,
      path: OBSERVED.status === "observed" ? OBSERVED.path.replace("06-41-26", "07-02-11") : "",
      inode: "654321",
    };
    observe.mockResolvedValueOnce(OBSERVED).mockResolvedValueOnce(next);

    await readCodexPaneContextUsage("t-1", signal(), deps());
    await readCodexPaneContextUsage("t-1", signal(), deps());

    expect(read.mock.calls.map(([rollout]) => rollout)).toEqual([OBSERVED, next]);
  });

  it.each<[string, Partial<PaneRecord> & { ptyPid?: number }]>([
    ["started Codex again", { agentIncarnation: 1 }],
    ["relaunched", { launchGeneration: 2 }],
    ["restarted", { spawnedAt: 2_000 }],
    ["recorded a session", { agentSessionId: THREAD }],
    ["runs another process", { ptyPid: 5151 }],
  ])("looks again within the window once the pane %s", async (_label, change) => {
    observe.mockResolvedValue({ status: "unknown", reason: "not-observed" });
    await readCodexPaneContextUsage("t-1", signal(), deps());

    const { ptyPid = 4242, ...pane } = change;
    getTerminalAsync.mockResolvedValue({ ...LIVE, ...pane });
    getTerminalInfo.mockResolvedValue({ ...LIVE, ...pane, ptyPid });
    await readCodexPaneContextUsage("t-1", signal(), deps());

    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenLastCalledWith(ptyPid);
  });

  it("keeps each pane's misses to itself", async () => {
    observe.mockResolvedValue({ status: "unknown", reason: "not-observed" });

    await readCodexPaneContextUsage("t-1", signal(), deps());
    await readCodexPaneContextUsage("t-2", signal(), deps());
    await readCodexPaneContextUsage("t-1", signal(), deps());

    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("shares a probe still running between callers, who each read for themselves", async () => {
    const probe = deferred<CodexRolloutObservation>();
    observe.mockReturnValue(probe.promise);

    const first = readCodexPaneContextUsage("t-1", signal(), deps());
    await vi.waitFor(() => expect(observe).toHaveBeenCalled());
    // A probe still running has no miss to age out, however long it takes.
    clock += CODEX_PROBE_MISS_REUSE_MS * 2;
    const second = readCodexPaneContextUsage("t-1", signal(), deps());
    await new Promise((resolve) => setTimeout(resolve, 0));
    probe.resolve(OBSERVED);

    expect(await Promise.all([first, second])).toEqual([OK, OK]);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("forgets a probe that failed outright", async () => {
    observe.mockRejectedValueOnce(new Error("spawn EAGAIN"));

    await expect(readCodexPaneContextUsage("t-1", signal(), deps())).rejects.toThrow();
    expect(await readCodexPaneContextUsage("t-1", signal(), deps())).toEqual(OK);
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("keeps a replaced run's late answer out of its successor's miss", async () => {
    const stale = deferred<CodexRolloutObservation>();
    observe.mockReturnValueOnce(stale.promise);
    const before = readCodexPaneContextUsage("t-1", signal(), deps());
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));

    const successor = { ...LIVE, agentIncarnation: 1 };
    getTerminalAsync.mockResolvedValue(successor);
    getTerminalInfo.mockResolvedValue({ ...successor, ptyPid: 4242 });
    observe.mockResolvedValue({ status: "unknown", reason: "not-observed" });
    await readCodexPaneContextUsage("t-1", signal(), deps());
    stale.resolve(OBSERVED);
    await before;
    await readCodexPaneContextUsage("t-1", signal(), deps());

    expect(observe).toHaveBeenCalledTimes(2);
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

    // The probe coming back late reads nothing for a caller long answered.
    settle(OBSERVED);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read).not.toHaveBeenCalled();
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
