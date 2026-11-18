import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsageAccount } from "../../../../shared/types/ipc/agentQuota.js";
import type { CodexHomeQuota } from "../../codex/CodexQuotaService.js";
import {
  AgentUsageWatch,
  liveAgentFolders,
  liveAgentOf,
  type AgentUsageWatchDeps,
  type LiveAgentFolders,
} from "../AgentUsageWatch.js";

const START = 1_800_000_000_000;
const TICK = 60_000;
const CADENCE = 5 * 60_000;

function codexQuota(homeKey: string, usedPercent: number, at = Date.now()): CodexHomeQuota {
  return {
    homeKey,
    isDefault: homeKey === "/home/.codex",
    accountNames: homeKey === "/home/.codex" ? [] : [`acct:${homeKey}`],
    presetNames: [],
    result: {
      status: "ok",
      planType: null,
      windows: [{ usedPercent, windowDurationMins: 300, resetsAt: at + 3_600_000 }],
      fetchedAt: at,
    },
  };
}

function claudeAccount(
  key: string,
  readings: ClaudeUsageAccount["readings"],
  kind: ClaudeUsageAccount["kind"] = "account"
): ClaudeUsageAccount {
  return { key, kind, accountNames: [`acct:${key}`], readings };
}

function claudeReading(
  overrides: Partial<ClaudeUsageAccount["readings"][number]> = {}
): ClaudeUsageAccount["readings"][number] {
  return {
    window: "weekly limit",
    statement: "used",
    usedPercent: 50,
    resetsAt: null,
    observedAt: Date.now() - 1_000,
    terminalId: "t1",
    paneTitle: null,
    projectName: null,
    ...overrides,
  };
}

interface Harness {
  watch: AgentUsageWatch;
  live: { current: LiveAgentFolders | null };
  readCodexHomes: ReturnType<typeof vi.fn<AgentUsageWatchDeps["readCodexHomes"]>>;
  readClaudeAccounts: ReturnType<typeof vi.fn<AgentUsageWatchDeps["readClaudeAccounts"]>>;
  codexAnswers: Map<string, () => CodexHomeQuota>;
  claudeAccounts: { current: ClaudeUsageAccount[] };
}

function harness(): Harness {
  const live: Harness["live"] = {
    current: { complete: true, codexHomes: [], claudeConfigDirs: [] },
  };
  const codexAnswers = new Map<string, () => CodexHomeQuota>();
  const claudeAccounts: Harness["claudeAccounts"] = { current: [] };
  const readCodexHomes = vi.fn<AgentUsageWatchDeps["readCodexHomes"]>(async (homes) =>
    [...homes].flatMap((home) => {
      const answer = codexAnswers.get(home);
      return answer ? [answer()] : [];
    })
  );
  const readClaudeAccounts = vi.fn<AgentUsageWatchDeps["readClaudeAccounts"]>(
    async () => claudeAccounts.current
  );
  const watch = new AgentUsageWatch({
    listLiveAgents: async () => live.current,
    canonicalCodexHome: async (home) => home,
    claudeAccountKey: async (dir) => `key:${dir}`,
    readCodexHomes,
    readClaudeAccounts,
    now: () => Date.now(),
  });
  return { watch, live, readCodexHomes, readClaudeAccounts, codexAnswers, claudeAccounts };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("AgentUsageWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks nothing and shows nothing while no Codex or Claude Code agent runs", async () => {
    const h = harness();
    h.watch.acquire();
    await settle();
    await vi.advanceTimersByTimeAsync(CADENCE * 2);
    expect(h.readCodexHomes).not.toHaveBeenCalled();
    expect(h.readClaudeAccounts).not.toHaveBeenCalled();
    expect(h.watch.latest()).toEqual([]);
    h.watch.dispose();
  });

  it("reads only the Codex homes an agent runs in, at most once per cadence however many want it", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 82));
    h.codexAnswers.set("/accts/idle", () => codexQuota("/accts/idle", 99));

    const releaseA = h.watch.acquire();
    const releaseB = h.watch.acquire();
    await settle();
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    expect([...h.readCodexHomes.mock.calls[0]![0]]).toEqual(["/accts/work"]);
    expect(h.watch.latest()).toMatchObject([
      { agentId: "codex", usedPercent: 82, accountNames: ["acct:/accts/work"] },
    ]);

    // A window hidden and shown again inside the cadence neither re-reads nor loses the reading.
    releaseA();
    releaseB();
    expect(h.watch.latest()).toEqual([]);
    h.watch.acquire();
    await settle();
    await vi.advanceTimersByTimeAsync(CADENCE - TICK - 1);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    expect(h.watch.latest()).toMatchObject([{ agentId: "codex", usedPercent: 82 }]);

    await vi.advanceTimersByTimeAsync(TICK + 1);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
    h.watch.dispose();
  });

  it("reads a home an agent newly starts in without waiting out another home's cadence", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/a"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/a", () => codexQuota("/accts/a", 20));
    h.codexAnswers.set("/accts/b", () => codexQuota("/accts/b", 90));
    h.watch.acquire();
    await settle();

    h.live.current = { complete: true, codexHomes: ["/accts/a", "/accts/b"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
    expect([...h.readCodexHomes.mock.calls[1]![0]]).toEqual(["/accts/b"]);
    expect(h.watch.latest()).toMatchObject([{ agentId: "codex", usedPercent: 90 }]);

    // Once the agent on b exits, b's reading drops off at the next look.
    h.live.current = { complete: true, codexHomes: ["/accts/a"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()).toMatchObject([{ agentId: "codex", usedPercent: 20 }]);
    h.watch.dispose();
  });

  it("keeps the last good Codex reading when a read fails", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 70, START));
    h.watch.acquire();
    await settle();

    h.codexAnswers.set("/accts/work", () => ({
      ...codexQuota("/accts/work", 0),
      result: { status: "unavailable", reason: "timeout", fetchedAt: Date.now() },
    }));
    await vi.advanceTimersByTimeAsync(CADENCE);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
    expect(h.watch.latest()).toMatchObject([{ usedPercent: 70, observedAt: START }]);
    h.watch.dispose();
  });

  it("shows only what panes printed for folders a Claude Code agent runs in now", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: ["/accts/work"] };
    h.claudeAccounts.current = [
      claudeAccount("key:/accts/work", [claudeReading({ usedPercent: 12 })]),
      claudeAccount("key:/accts/other", [claudeReading({ statement: "reached", usedPercent: null })]),
      claudeAccount("key:/accts/work", [claudeReading({ statement: "reached" })], "unknown"),
    ];
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()).toMatchObject([
      { agentId: "claude", statement: "used", usedPercent: 12, accountNames: ["acct:key:/accts/work"] },
    ]);
    h.watch.dispose();
  });

  it("drops a Claude Code reading once its reset passes, showing the runner-up", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: ["/accts/work"] };
    h.claudeAccounts.current = [
      claudeAccount("key:/accts/work", [
        claudeReading({ window: "5-hour limit", statement: "reached", resetsAt: START + TICK / 2 }),
        claudeReading({ window: "weekly limit", usedPercent: 30 }),
      ]),
    ];
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()).toMatchObject([{ statement: "reached" }]);
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()).toMatchObject([{ window: "weekly limit", usedPercent: 30 }]);
    h.watch.dispose();
  });

  it("keeps what it shows while the inventory is missing a pty host", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 60));
    h.watch.acquire();
    await settle();
    h.live.current = { complete: false, codexHomes: [], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()).toMatchObject([{ usedPercent: 60 }]);
    h.watch.dispose();
  });

  it("publishes nothing from a read that outlived the last release", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    let answer!: (value: CodexHomeQuota[]) => void;
    h.readCodexHomes.mockImplementationOnce(
      () => new Promise<CodexHomeQuota[]>((resolve) => (answer = resolve))
    );
    const listener = vi.fn();
    h.watch.onChange(listener);
    const release = h.watch.acquire();
    await settle();
    release();
    answer([codexQuota("/accts/work", 95)]);
    await settle();
    expect(h.watch.latest()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    h.watch.dispose();
  });
});

describe("liveAgentFolders", () => {
  it("takes the folders of running Codex and Claude Code agents only", () => {
    expect(
      liveAgentFolders(
        [
          { detectedAgentId: "codex", codexHome: "/a", claudeConfigDir: "/x" },
          { launchAgentId: "claude", claudeConfigDir: "/b", codexHome: "/y" },
          { detectedAgentId: "gemini", codexHome: "/c", claudeConfigDir: "/c" },
          { detectedAgentId: "codex", codexHome: "/d", hasPty: false },
          { detectedAgentId: "claude", claudeConfigDir: "/e", isTrashed: true },
          { detectedAgentId: "codex" },
        ],
        true
      )
    ).toEqual({ complete: true, codexHomes: ["/a"], claudeConfigDirs: ["/b"] });
  });

  it("counts a launched agent until detection first speaks, and not after it saw it exit", () => {
    expect(liveAgentOf({ launchAgentId: "codex" })).toBe("codex");
    expect(liveAgentOf({ launchAgentId: "codex", everDetectedAgent: true })).toBeNull();
    expect(liveAgentOf({ launchAgentId: "codex", isExited: true })).toBeNull();
  });
});
