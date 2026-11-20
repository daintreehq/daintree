import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeUsageAccount } from "../../../../shared/types/ipc/agentQuota.js";
import type { CodexHomeQuota } from "../../codex/CodexQuotaService.js";
import {
  AgentUsageWatch,
  liveAgentFolders,
  liveAgentOf,
  type AgentUsageWatchDeps,
  type DefaultLoginNames,
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
  names: { current: DefaultLoginNames };
}

function harness(): Harness {
  const live: Harness["live"] = {
    current: { complete: true, codexHomes: [], claudeConfigDirs: [] },
  };
  const codexAnswers = new Map<string, () => CodexHomeQuota>();
  const claudeAccounts: Harness["claudeAccounts"] = { current: [] };
  const names: Harness["names"] = { current: {} };
  const readCodexHomes = vi.fn<AgentUsageWatchDeps["readCodexHomes"]>(async (homes) =>
    [...homes.keys()].flatMap((home) => {
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
    readDefaultLoginNames: async () => names.current,
    now: () => Date.now(),
    monotonic: () => Date.now(),
  });
  return { watch, live, readCodexHomes, readClaudeAccounts, codexAnswers, claudeAccounts, names };
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

  it("labels only the default login's readings with this host's name for it, and picks up a rename without asking Codex again (#17080)", async () => {
    const h = harness();
    h.live.current = {
      complete: true,
      codexHomes: ["/home/.codex", "/accts/work"],
      claudeConfigDirs: ["/home/.claude", "/accts/work"],
    };
    h.codexAnswers.set("/home/.codex", () => codexQuota("/home/.codex", 90));
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 60));
    h.claudeAccounts.current = [
      claudeAccount("key:/home/.claude", [claudeReading({ usedPercent: 50 })], "default"),
      claudeAccount("key:/accts/work", [claudeReading({ usedPercent: 20 })]),
    ];
    h.names.current = { codex: "Work", claude: "Home" };

    h.watch.acquire();
    await settle();
    const codexReads = h.readCodexHomes.mock.calls.length;
    const shown = () =>
      h.watch.latest().map((r) => [r.agentId, r.isDefault, r.defaultLoginName] as const);
    expect(shown()).toEqual([
      ["codex", true, "Work"],
      ["claude", true, "Home"],
    ]);

    // An account's reading never carries the default login's name.
    h.claudeAccounts.current = [
      claudeAccount("key:/home/.claude", [claudeReading({ usedPercent: 5 })], "default"),
      claudeAccount("key:/accts/work", [claudeReading({ usedPercent: 30 })]),
    ];
    h.names.current = { codex: "Lab", claude: "Home" };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(shown()).toEqual([
      ["codex", true, "Lab"],
      ["claude", false, undefined],
    ]);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(codexReads);
    h.watch.dispose();
  });

  it("never names a Codex account's reading after the default login, and shows readings unnamed when the names can't be read (#17080)", async () => {
    const h = harness();
    h.live.current = {
      complete: true,
      codexHomes: ["/home/.codex", "/accts/work"],
      claudeConfigDirs: [],
    };
    h.codexAnswers.set("/home/.codex", () => codexQuota("/home/.codex", 30));
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 95));
    h.names.current = { codex: "Work" };
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()).toMatchObject([
      { agentId: "codex", isDefault: false, usedPercent: 95 },
    ]);
    expect(h.watch.latest()[0]).not.toHaveProperty("defaultLoginName");
    h.watch.dispose();

    const failing = harness();
    failing.live.current = { complete: true, codexHomes: ["/home/.codex"], claudeConfigDirs: [] };
    failing.codexAnswers.set("/home/.codex", () => codexQuota("/home/.codex", 30));
    Object.defineProperty(failing.names, "current", {
      get: () => {
        throw new Error("store unreadable");
      },
    });
    failing.watch.acquire();
    await settle();
    expect(failing.watch.latest()).toMatchObject([
      { agentId: "codex", isDefault: true, usedPercent: 30 },
    ]);
    expect(failing.watch.latest()[0]).not.toHaveProperty("defaultLoginName");
    failing.watch.dispose();
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
    expect([...h.readCodexHomes.mock.calls[0]![0].keys()]).toEqual(["/accts/work"]);
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
    // Four minutes in, past four ticks of looking: still the one read.
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    expect(h.watch.latest()[0]).toMatchObject({ agentId: "codex", usedPercent: 82 });

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
    expect([...h.readCodexHomes.mock.calls[1]![0].keys()]).toEqual(["/accts/b"]);
    expect(h.watch.latest()[0]).toMatchObject({ agentId: "codex", usedPercent: 90 });

    // Once the agent on b exits, b's reading drops off at the next look.
    h.live.current = { complete: true, codexHomes: ["/accts/a"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()[0]).toMatchObject({ agentId: "codex", usedPercent: 20 });
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
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 70, observedAt: START });
    h.watch.dispose();
  });

  describe("tracking turned off and on again (#17981)", () => {
    function failing(): CodexHomeQuota {
      return {
        ...codexQuota("/accts/work", 0),
        result: { status: "unavailable", reason: "timeout", fetchedAt: Date.now() },
      };
    }

    it("reads Codex afresh when turned back on, even within the cadence", async () => {
      const h = harness();
      h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
      h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 70, START));
      const release = h.watch.acquire();
      await settle();
      release();
      h.watch.trackingTurnedOff();

      await vi.advanceTimersByTimeAsync(TICK);
      h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 40));
      h.watch.acquire();
      await settle();
      expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
      expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 40, observedAt: START + TICK });
      h.watch.dispose();
    });

    it("never falls back to an answer from before tracking went off when the fresh read fails", async () => {
      const h = harness();
      h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
      h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 70, START));
      const release = h.watch.acquire();
      await settle();
      release();
      h.watch.trackingTurnedOff();

      // Well before the 70% reading's reset, so only the switch can hide it.
      await vi.advanceTimersByTimeAsync(CADENCE);
      h.codexAnswers.set("/accts/work", failing);
      h.watch.acquire();
      await settle();
      expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
      expect(h.watch.latest()).toEqual([]);
      h.watch.dispose();
    });

    it("tells Codex when a read is no longer wanted, and asks again for one dropped before it started", async () => {
      const h = harness();
      h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
      let answer!: (value: CodexHomeQuota[]) => void;
      let stillWanted!: () => boolean;
      h.readCodexHomes.mockImplementationOnce((_homes, wanted) => {
        stillWanted = wanted;
        return new Promise<CodexHomeQuota[]>((resolve) => (answer = resolve));
      });
      const release = h.watch.acquire();
      await settle();
      expect(stillWanted()).toBe(true);
      release();
      expect(stillWanted()).toBe(false);
      // Dropped in the queue: no answer for the home.
      answer([]);
      await settle();

      h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 40));
      h.watch.acquire();
      await settle();
      expect(h.readCodexHomes).toHaveBeenCalledTimes(2);
      expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 40 });
      h.watch.dispose();
    });

    it("keeps the cadence for a read that was made after its watch stopped", async () => {
      const h = harness();
      h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
      let answer!: (value: CodexHomeQuota[]) => void;
      h.readCodexHomes.mockImplementationOnce(
        () => new Promise<CodexHomeQuota[]>((resolve) => (answer = resolve))
      );
      const release = h.watch.acquire();
      await settle();
      release();
      answer([codexQuota("/accts/work", 55)]);
      await settle();

      h.watch.acquire();
      await settle();
      expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
      expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 55 });
      h.watch.dispose();
    });
  });

  it("shows only what panes printed for folders a Claude Code agent runs in now", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: ["/accts/work"] };
    h.claudeAccounts.current = [
      claudeAccount("key:/accts/work", [claudeReading({ usedPercent: 12 })]),
      claudeAccount("key:/accts/other", [
        claudeReading({ statement: "reached", usedPercent: null }),
      ]),
      claudeAccount(
        "key:/accts/work",
        [claudeReading({ statement: "reached", usedPercent: null })],
        "unknown"
      ),
    ];
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()).toMatchObject([
      {
        agentId: "claude",
        statement: "used",
        usedPercent: 12,
        accountNames: ["acct:key:/accts/work"],
      },
    ]);
    h.watch.dispose();
  });

  it("drops a Claude Code reading once its reset passes, showing the runner-up", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: ["/accts/work"] };
    h.claudeAccounts.current = [
      claudeAccount("key:/accts/work", [
        claudeReading({
          window: "5-hour limit",
          statement: "reached",
          usedPercent: null,
          resetsAt: START + TICK / 2,
        }),
        claudeReading({ window: "weekly limit", usedPercent: 30 }),
      ]),
    ];
    h.watch.acquire();
    await settle();
    // What shows once it resets travels with it.
    expect(h.watch.latest()).toMatchObject([
      { statement: "reached" },
      { window: "weekly limit", usedPercent: 30 },
    ]);
    // Woken at the reset itself, not a tick later.
    await vi.advanceTimersByTimeAsync(TICK / 2 + 1);
    expect(h.watch.latest()).toMatchObject([{ window: "weekly limit", usedPercent: 30 }]);
    expect(h.watch.latest()).toHaveLength(1);
    h.watch.dispose();
  });

  it("withdraws its readings while a pty host doesn't answer, and shows them again once it does", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 95));
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 95 });
    // An account at 96% may be running on the shard that didn't answer: a lower one seen isn't the tightest.
    h.live.current = { complete: false, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()).toEqual([]);
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 95 });
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    h.watch.dispose();
  });

  it("shows a first read that lands after the window was hidden and shown again, without waiting a tick", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    let answer!: () => void;
    h.readCodexHomes.mockImplementationOnce(
      () =>
        new Promise<CodexHomeQuota[]>((resolve) => {
          answer = () => resolve([codexQuota("/accts/work", 88)]);
        })
    );
    const release = h.watch.acquire();
    await settle();
    release();
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()).toEqual([]);
    answer();
    await settle();
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 88 });
    h.watch.dispose();
  });

  it("cuts a long list of names to what a link carries rather than lose the reading", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => ({
      ...codexQuota("/accts/work", 50),
      accountNames: [],
      presetNames: Array.from({ length: 40 }, (_, i) => `Preset ${i} ${"x".repeat(300)}`),
    }));
    h.watch.acquire();
    await settle();
    const [reading] = h.watch.latest();
    expect(reading!.accountNames).toHaveLength(32);
    expect(Math.max(...reading!.accountNames.map((name) => name.length))).toBe(256);
    h.watch.dispose();
  });

  it("doesn't ask about a home whose agent left while an earlier home was being read", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/a", "/accts/b"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/a", () => codexQuota("/accts/a", 20));
    h.codexAnswers.set("/accts/b", () => codexQuota("/accts/b", 90));
    let answerA!: () => void;
    h.readCodexHomes.mockImplementationOnce(
      (homes) =>
        new Promise<CodexHomeQuota[]>((resolve) => {
          answerA = () => resolve([...homes.keys()].map((home) => h.codexAnswers.get(home)!()));
        })
    );
    h.watch.acquire();
    await settle();
    h.live.current = { complete: true, codexHomes: ["/accts/a"], claudeConfigDirs: [] };
    answerA();
    await settle();
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    expect([...h.readCodexHomes.mock.calls[0]![0].keys()]).toEqual(["/accts/a"]);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 20 });

    // b stays due, so an agent back in it is read at the next look.
    h.live.current = { complete: true, codexHomes: ["/accts/a", "/accts/b"], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect([...h.readCodexHomes.mock.calls[1]![0].keys()]).toEqual(["/accts/b"]);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 90 });
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

describe("AgentUsageWatch membership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears a reading once its last agent exits, without asking again", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/work"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/work", () => codexQuota("/accts/work", 70));
    h.watch.acquire();
    await settle();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: [] };
    await vi.advanceTimersByTimeAsync(TICK);
    expect(h.watch.latest()).toEqual([]);
    expect(h.readCodexHomes).toHaveBeenCalledTimes(1);
    h.watch.dispose();
  });

  it("reads every home that comes due in one look, and takes a later good read over a kept one", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: ["/accts/a", "/accts/b"], claudeConfigDirs: [] };
    h.codexAnswers.set("/accts/a", () => codexQuota("/accts/a", 20));
    h.codexAnswers.set("/accts/b", () => codexQuota("/accts/b", 60));
    h.watch.acquire();
    await settle();
    expect(h.readCodexHomes.mock.calls.map(([homes]) => [...homes.keys()])).toEqual([
      ["/accts/a"],
      ["/accts/b"],
    ]);
    h.codexAnswers.set("/accts/b", () => ({
      ...codexQuota("/accts/b", 0),
      result: { status: "unavailable", reason: "timeout", fetchedAt: Date.now() },
    }));
    await vi.advanceTimersByTimeAsync(CADENCE);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 60 });
    h.codexAnswers.set("/accts/b", () => codexQuota("/accts/b", 75));
    await vi.advanceTimersByTimeAsync(CADENCE);
    expect(h.watch.latest()[0]).toMatchObject({ usedPercent: 75 });
    h.watch.dispose();
  });

  it("takes in every folder a Claude Code agent runs in", async () => {
    const h = harness();
    h.live.current = { complete: true, codexHomes: [], claudeConfigDirs: ["/accts/a", "/accts/b"] };
    h.claudeAccounts.current = [
      claudeAccount("key:/accts/a", [claudeReading({ usedPercent: 10 })]),
      claudeAccount("key:/accts/b", [
        claudeReading({ statement: "approaching", usedPercent: null }),
      ]),
    ];
    h.watch.acquire();
    await settle();
    expect(h.watch.latest()[0]).toMatchObject({ statement: "approaching" });
    h.watch.dispose();
  });
});

describe("liveAgentFolders", () => {
  it("takes the folders of running Codex and Claude Code agents only", () => {
    expect(
      liveAgentFolders(
        [
          {
            launchAgentId: "codex",
            detectedAgentId: "codex",
            codexHome: "/a",
            claudeConfigDir: "/x",
          },
          { launchAgentId: "claude", claudeConfigDir: "/b", codexHome: "/y" },
          { launchAgentId: "gemini", detectedAgentId: "gemini", codexHome: "/c" },
          { launchAgentId: "codex", detectedAgentId: "codex", codexHome: "/d", hasPty: false },
          { launchAgentId: "claude", claudeConfigDir: "/e", isTrashed: true },
          { launchAgentId: "codex", detectedAgentId: "codex" },
        ],
        false
      )
    ).toEqual({ complete: false, codexHomes: ["/a"], claudeConfigDirs: ["/b"] });
  });

  it("counts a launched agent until detection first speaks, and not after it saw it exit", () => {
    expect(liveAgentOf({ launchAgentId: "codex" })).toBe("codex");
    expect(liveAgentOf({ launchAgentId: "codex", everDetectedAgent: true })).toBeNull();
    expect(liveAgentOf({ launchAgentId: "codex", isExited: true })).toBeNull();
  });

  it("lists a folder once however many agents share it", () => {
    expect(
      liveAgentFolders(
        [
          { launchAgentId: "codex", codexHome: "/a" },
          { launchAgentId: "codex", codexHome: "/a" },
        ],
        true
      ).codexHomes
    ).toEqual(["/a"]);
    expect(
      liveAgentOf({ launchAgentId: "codex", everDetectedAgent: true, detectedAgentId: "codex" })
    ).toBe("codex");
  });

  it("never takes a session run again in the shell a launched one left", () => {
    expect(
      liveAgentOf({ launchAgentId: "codex", detectedAgentId: "codex", agentIncarnation: 1 })
    ).toBeNull();
    expect(
      liveAgentOf({ launchAgentId: "codex", detectedAgentId: "codex", agentIncarnation: 0 })
    ).toBe("codex");
  });

  it("never takes an agent typed into a shell for an account: its command line can name another folder", () => {
    expect(liveAgentOf({ detectedAgentId: "codex" })).toBeNull();
    expect(liveAgentOf({ launchAgentId: "claude", detectedAgentId: "codex" })).toBeNull();
    expect(liveAgentOf({ launchAgentId: "claude", detectedAgentId: "claude" })).toBe("claude");
  });
});
