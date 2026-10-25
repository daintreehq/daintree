import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THROWAWAY_TIME_LIMIT_MS,
  HostThrowawayToolResultSchema,
  MAX_THROWAWAY_TIME_LIMIT_MS,
  type HostThrowawayCall,
} from "../../../../shared/types/hostThrowaway.js";
import { isHostThrowawayTerminalId } from "../../../../shared/config/hostThrowaway.js";
import {
  HOST_THROWAWAY_CLOSE_WAIT_MS,
  HOST_THROWAWAY_EXITED_RETENTION_MS,
  HostThrowawayRuns,
  MAX_HOST_THROWAWAY_RUNS,
  type HostThrowawayClosedEntry,
  type HostThrowawayRunsDeps,
} from "../HostThrowawayRuns.js";

const OWNER = { senderId: "sender-a", helpSessionId: "help-1" };

function harness(overrides: Partial<HostThrowawayRunsDeps> = {}) {
  let clock = 1_000;
  let ids = 0;
  const spawned: Array<{ terminalId: string; agentId: string }> = [];
  const killed: string[] = [];
  const written: Array<[string, string]> = [];
  const submitted: Array<[string, string]> = [];
  const closedLog: HostThrowawayClosedEntry[] = [];
  // One fake clock for both the readings and the timers.
  const timers = new Set<{ at: number; fire: () => void }>();
  const held: { runs?: HostThrowawayRuns } = {};
  const deps: HostThrowawayRunsDeps = {
    now: () => clock,
    newId: () => `id-${++ids}`,
    sleep: async () => {},
    schedule: (ms, fire) => {
      const timer = { at: clock + ms, fire };
      timers.add(timer);
      return () => timers.delete(timer);
    },
    logClosed: (entry) => closedLog.push(entry),
    isLaunchable: async (agentId) => agentId === "claude",
    spawn: async (spec) => {
      spawned.push(spec);
      return true;
    },
    readScreen: async () => ({ content: "Weekly usage 42%", lineCount: 1, truncated: false }),
    submit: async (terminalId, command) => {
      submitted.push([terminalId, command]);
    },
    write: async (terminalId, data) => {
      written.push([terminalId, data]);
    },
    // The pty-host answers a kill with the exit, as it does for a real one.
    kill: (terminalId) => {
      killed.push(terminalId);
      queueMicrotask(() => held.runs?.handleExit(terminalId));
    },
    ...overrides,
  };
  const runs = new HostThrowawayRuns(deps);
  held.runs = runs;
  return {
    runs,
    spawned,
    killed,
    written,
    submitted,
    closedLog,
    pendingTimers: () => timers.size,
    advance: (ms: number) => {
      clock += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.at > clock || !timers.has(timer)) continue;
        timers.delete(timer);
        timer.fire();
      }
    },
  };
}

async function launch(runs: HostThrowawayRuns, owner = OWNER, timeLimitMs?: number) {
  const outcome = await runs.call(owner, {
    tool: "throwaway.launch",
    args: { agentId: "claude", ...(timeLimitMs !== undefined ? { timeLimitMs } : {}) },
  });
  if (!outcome.ok) throw new Error(`launch failed: ${outcome.reason}`);
  return outcome.result.run;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HostThrowawayRuns", () => {
  it("launches under a fresh terminal id and keeps the run in its inventory", async () => {
    const { runs, spawned, advance } = harness();
    const run = await launch(runs);
    expect(run).toMatchObject({
      agentId: "claude",
      startedAt: 1_000,
      ageMs: 0,
      state: "running",
      timeLimitMs: DEFAULT_THROWAWAY_TIME_LIMIT_MS,
      expiresAt: 1_000 + DEFAULT_THROWAWAY_TIME_LIMIT_MS,
      endedAt: null,
      endReason: null,
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.terminalId).not.toBe(run.runId);
    // The id the pty-host keys its disk snapshots off, so a run's screen is never kept.
    expect(isHostThrowawayTerminalId(spawned[0]!.terminalId)).toBe(true);
    expect(runs.ownsTerminal(spawned[0]!.terminalId)).toBe(true);
    expect(runs.list()).toEqual([
      {
        runId: run.runId,
        owner: OWNER,
        agentId: "claude",
        terminalId: spawned[0]!.terminalId,
        startedAt: 1_000,
        timeLimitMs: DEFAULT_THROWAWAY_TIME_LIMIT_MS,
        state: "running",
        endedAt: null,
      },
    ]);
    advance(2_500);
    const status = await runs.call(OWNER, { tool: "throwaway.status", args: { runId: run.runId } });
    expect(status).toMatchObject({ ok: true, result: { run: { ageMs: 2_500 } } });
    expect(HostThrowawayToolResultSchema.safeParse(status.ok && status.result).success).toBe(true);
  });

  it("answers the relay as its executor, keeping the time limit a launch asks for", async () => {
    const { runs } = harness();
    const options = { callId: "call-1", timeoutMs: 90_000 };
    const launched = await runs.run(
      OWNER,
      { tool: "throwaway.launch", args: { agentId: "claude", timeLimitMs: 60_000 } },
      options
    );
    expect(launched).toMatchObject({
      status: "done",
      result: { tool: "throwaway.launch", run: { timeLimitMs: 60_000, expiresAt: 61_000 } },
    });
    await expect(
      runs.run(OWNER, { tool: "throwaway.status", args: { runId: "nobody" } }, options)
    ).resolves.toEqual({ status: "failed", reason: "not-found" });
  });

  it("refuses an agent the host can't launch, and one that doesn't start, keeping nothing", async () => {
    const { runs, killed } = harness({ spawn: async () => false });
    await expect(
      runs.call(OWNER, { tool: "throwaway.launch", args: { agentId: "gemini" } })
    ).resolves.toEqual({ ok: false, reason: "launch-failed" });
    await expect(
      runs.call(OWNER, { tool: "throwaway.launch", args: { agentId: "claude" } })
    ).resolves.toEqual({ ok: false, reason: "launch-failed" });
    expect(runs.list()).toEqual([]);
    // A spawn that answered no may still have left a process; it is ended.
    expect(killed).toHaveLength(1);
  });

  it("holds at most its cap of runs at once", async () => {
    const { runs } = harness();
    for (let i = 0; i < MAX_HOST_THROWAWAY_RUNS; i++) await launch(runs);
    await expect(
      runs.call(OWNER, { tool: "throwaway.launch", args: { agentId: "claude" } })
    ).resolves.toEqual({ ok: false, reason: "launch-failed" });
  });

  it("answers another session's run, on the same Shell or another, as not found", async () => {
    const { runs, killed } = harness();
    const run = await launch(runs);
    const strangers = [
      { senderId: "sender-a", helpSessionId: "help-2" },
      { senderId: "sender-b", helpSessionId: "help-1" },
    ];
    for (const stranger of strangers) {
      for (const call of [
        { tool: "throwaway.status", args: { runId: run.runId } },
        { tool: "throwaway.output", args: { runId: run.runId } },
        { tool: "throwaway.sendCommand", args: { runId: run.runId, command: "/usage" } },
        { tool: "throwaway.sendKeys", args: { runId: run.runId, keys: ["Enter"] } },
        { tool: "throwaway.close", args: { runId: run.runId } },
      ] satisfies HostThrowawayCall[]) {
        await expect(runs.call(stranger, call)).resolves.toEqual({
          ok: false,
          reason: "not-found",
        });
      }
    }
    expect(killed).toEqual([]);
    expect(runs.list()).toHaveLength(1);
  });

  it("reads the screen and types into the run's own terminal", async () => {
    const readScreen = vi.fn(async (terminalId: string) => ({
      content: `screen of ${terminalId}`,
      lineCount: 1,
      truncated: false,
    }));
    const { runs, spawned, submitted, written } = harness({ readScreen });
    const run = await launch(runs);
    const terminalId = spawned[0]!.terminalId;
    await expect(
      runs.call(OWNER, { tool: "throwaway.output", args: { runId: run.runId, maxLines: 20 } })
    ).resolves.toMatchObject({
      ok: true,
      result: { content: `screen of ${terminalId}`, lineCount: 1, truncated: false },
    });
    expect(readScreen).toHaveBeenCalledWith(terminalId, 20);
    await expect(
      runs.call(OWNER, {
        tool: "throwaway.sendCommand",
        args: { runId: run.runId, command: "/usage" },
      })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } });
    expect(submitted).toEqual([[terminalId, "/usage"]]);
    await runs.call(OWNER, {
      tool: "throwaway.sendKeys",
      args: { runId: run.runId, keys: ["Down", "Enter"] },
    });
    expect(written).toEqual([
      [terminalId, "\x1b[B"],
      [terminalId, "\r"],
    ]);
  });

  it("reports input that didn't reach the terminal as failed", async () => {
    const { runs } = harness({
      submit: async () => {
        throw new Error("gone");
      },
    });
    const run = await launch(runs);
    await expect(
      runs.call(OWNER, { tool: "throwaway.sendCommand", args: { runId: run.runId, command: "x" } })
    ).resolves.toEqual({ ok: false, reason: "input-failed" });
  });

  it("keeps an exited run readable, refuses input to it, and drops it after its retention", async () => {
    const { runs, spawned, advance, closedLog } = harness();
    const run = await launch(runs, OWNER, MAX_THROWAWAY_TIME_LIMIT_MS);
    advance(3_000);
    runs.handleExit(spawned[0]!.terminalId);
    advance(1_000);
    await expect(
      runs.call(OWNER, { tool: "throwaway.status", args: { runId: run.runId } })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        run: { state: "exited", endedAt: 4_000, ageMs: 3_000, endReason: "exit" },
      },
    });
    await expect(
      runs.call(OWNER, { tool: "throwaway.sendKeys", args: { runId: run.runId, keys: ["Enter"] } })
    ).resolves.toEqual({ ok: false, reason: "exited" });
    advance(HOST_THROWAWAY_EXITED_RETENTION_MS);
    expect(runs.list()).toEqual([]);
    await expect(
      runs.call(OWNER, { tool: "throwaway.status", args: { runId: run.runId } })
    ).resolves.toEqual({ ok: false, reason: "not-found" });
    // Retention, not the host closing it unasked: nothing to explain.
    expect(closedLog).toEqual([]);
  });

  it("closes by ending the process, answering only once it ended, and keeps nothing", async () => {
    const { runs, spawned, killed, advance } = harness();
    const run = await launch(runs);
    advance(5_000);
    const closed = await runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } });
    expect(new Set(killed)).toEqual(new Set([spawned[0]!.terminalId]));
    expect(closed).toEqual({
      ok: true,
      result: {
        tool: "throwaway.close",
        closed: true,
        run: expect.objectContaining({
          state: "closed",
          endReason: "close",
          endedAt: 6_000,
          ageMs: 5_000,
        }),
      },
    });
    expect(HostThrowawayToolResultSchema.safeParse(closed.ok && closed.result).success).toBe(true);
    expect(runs.list()).toEqual([]);
    expect(runs.ownsTerminal(spawned[0]!.terminalId)).toBe(false);
    await expect(
      runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } })
    ).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("closes a run that exited on its own, ending what the pty-host kept of it", async () => {
    const { runs, spawned, killed, advance } = harness();
    const run = await launch(runs);
    advance(1_000);
    runs.handleExit(spawned[0]!.terminalId);
    advance(1_000);
    await expect(
      runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } })
    ).resolves.toMatchObject({
      ok: true,
      result: { run: { state: "closed", endReason: "exit", endedAt: 2_000, ageMs: 1_000 } },
    });
    expect(killed).toEqual([spawned[0]!.terminalId]);
    expect(runs.list()).toEqual([]);
  });

  it("answers output read across a close as not found", async () => {
    let read: () => void = () => {};
    const { runs } = harness({
      readScreen: () =>
        new Promise((resolve) => {
          read = () => resolve({ content: "secret", lineCount: 1, truncated: false });
        }),
    });
    const run = await launch(runs);
    const output = runs.call(OWNER, { tool: "throwaway.output", args: { runId: run.runId } });
    await runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } });
    read();
    await expect(output).resolves.toEqual({ ok: false, reason: "not-found" });
  });

  it("reports a close whose process didn't end as failed, keeping the run", async () => {
    vi.useFakeTimers();
    const { runs } = harness({ kill: () => {} });
    const run = await launch(runs);
    const closing = runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } });
    await vi.advanceTimersByTimeAsync(HOST_THROWAWAY_CLOSE_WAIT_MS);
    await expect(closing).resolves.toEqual({ ok: false, reason: "close-failed" });
    expect(runs.list()).toHaveLength(1);
  });

  it("ends every run at once, including a launch still starting", async () => {
    let release: (started: boolean) => void = () => {};
    const { runs, killed } = harness();
    await launch(runs);
    const slow = harness({
      spawn: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    });
    const pending = slow.runs.call(OWNER, {
      tool: "throwaway.launch",
      args: { agentId: "claude" },
    });
    await vi.waitFor(() => expect(slow.runs.list()).toHaveLength(1));
    slow.runs.endAll();
    release(true);
    await expect(pending).resolves.toEqual({ ok: false, reason: "launch-failed" });
    expect(slow.runs.list()).toEqual([]);
    expect(slow.killed).toHaveLength(2);
    runs.endAll();
    expect(killed).toHaveLength(1);
    expect(runs.list()).toEqual([]);
  });

  describe("time limits", () => {
    it("ends a run at its default limit, whatever its agent is doing, and logs why", async () => {
      const { runs, spawned, killed, advance, closedLog, pendingTimers } = harness();
      const run = await launch(runs);
      // Stopped on a login or update prompt: nobody will ever close it.
      advance(DEFAULT_THROWAWAY_TIME_LIMIT_MS - 1);
      expect(runs.list()).toHaveLength(1);
      expect(killed).toEqual([]);
      advance(1);
      expect(killed).toEqual([spawned[0]!.terminalId]);
      expect(runs.list()).toEqual([]);
      expect(runs.ownsTerminal(spawned[0]!.terminalId)).toBe(false);
      expect(closedLog).toEqual([
        {
          runId: run.runId,
          agentId: "claude",
          owner: OWNER,
          reason: "expiry",
          ageMs: DEFAULT_THROWAWAY_TIME_LIMIT_MS,
          state: "running",
        },
      ]);
      expect(pendingTimers()).toBe(0);
      await expect(
        runs.call(OWNER, { tool: "throwaway.output", args: { runId: run.runId } })
      ).resolves.toEqual({ ok: false, reason: "not-found" });
    });

    it("keeps a shorter limit a launch asks for", async () => {
      const { runs, advance, closedLog } = harness();
      const run = await launch(runs, OWNER, 2_000);
      expect(run).toMatchObject({ timeLimitMs: 2_000, expiresAt: 3_000 });
      advance(2_000);
      expect(runs.list()).toEqual([]);
      expect(closedLog).toMatchObject([{ runId: run.runId, reason: "expiry" }]);
    });

    it("never stretches a limit past the ceiling", async () => {
      const { runs, advance } = harness();
      const outcome = await runs.call(OWNER, {
        tool: "throwaway.launch",
        args: { agentId: "claude", timeLimitMs: MAX_THROWAWAY_TIME_LIMIT_MS * 2 },
      });
      expect(outcome).toMatchObject({
        ok: true,
        result: { run: { timeLimitMs: MAX_THROWAWAY_TIME_LIMIT_MS } },
      });
      advance(MAX_THROWAWAY_TIME_LIMIT_MS);
      expect(runs.list()).toEqual([]);
    });

    it("ends an exited run whose screen is still kept, once its limit passes", async () => {
      const { runs, spawned, killed, advance, closedLog } = harness();
      await launch(runs, OWNER, 5_000);
      advance(1_000);
      runs.handleExit(spawned[0]!.terminalId);
      advance(4_000);
      expect(runs.list()).toEqual([]);
      expect(killed).toEqual([spawned[0]!.terminalId]);
      expect(closedLog).toMatchObject([{ reason: "expiry", state: "exited" }]);
    });

    it("ends a run past its limit at the next call when its timer hasn't fired", async () => {
      let clock = 1_000;
      const { runs, closedLog } = harness({ now: () => clock, schedule: () => () => {} });
      const run = await launch(runs, OWNER, 2_000);
      clock += 2_000;
      await expect(
        runs.call(OWNER, { tool: "throwaway.status", args: { runId: run.runId } })
      ).resolves.toEqual({ ok: false, reason: "not-found" });
      expect(closedLog).toMatchObject([{ runId: run.runId, reason: "expiry" }]);
    });

    it("times a run from before its spawn answers, failing a launch its limit outran", async () => {
      let release: (started: boolean) => void = () => {};
      const h = harness({
        spawn: () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      });
      const pending = h.runs.call(OWNER, {
        tool: "throwaway.launch",
        args: { agentId: "claude", timeLimitMs: 1_000 },
      });
      await vi.waitFor(() => expect(h.runs.list()).toHaveLength(1));
      h.advance(1_000);
      expect(h.runs.list()).toEqual([]);
      release(true);
      await expect(pending).resolves.toEqual({ ok: false, reason: "launch-failed" });
      // The late spawn's process is ended again.
      expect(h.killed).toHaveLength(2);
      expect(h.closedLog).toHaveLength(1);
    });

    it("answers a close its limit overtook as not found", async () => {
      vi.useFakeTimers();
      const h = harness({ kill: (terminalId) => h.killed.push(terminalId) });
      const run = await launch(h.runs, OWNER, 2_000);
      const closing = h.runs.call(OWNER, { tool: "throwaway.close", args: { runId: run.runId } });
      await Promise.resolve();
      h.advance(2_000);
      await expect(closing).resolves.toEqual({ ok: false, reason: "not-found" });
      expect(h.runs.list()).toEqual([]);
    });
  });

  describe("owners that are gone", () => {
    it("closes one help session's runs, leaving its sender's others", async () => {
      const { runs, spawned, killed, closedLog, pendingTimers } = harness();
      const mine = await launch(runs);
      const sibling = await launch(runs, { senderId: "sender-a", helpSessionId: "help-2" });
      const stranger = await launch(runs, { senderId: "sender-b", helpSessionId: "help-1" });
      runs.endOwner(OWNER, "session-ended");
      expect(killed).toEqual([spawned[0]!.terminalId]);
      expect(runs.list().map((run) => run.runId)).toEqual([sibling.runId, stranger.runId]);
      expect(closedLog).toEqual([
        {
          runId: mine.runId,
          agentId: "claude",
          owner: OWNER,
          reason: "session-ended",
          ageMs: 0,
          state: "running",
        },
      ]);
      expect(pendingTimers()).toBe(2);
      runs.endOwner(OWNER, "session-ended");
      expect(closedLog).toHaveLength(1);
    });

    it("closes every run of a sender whose Shell is gone", async () => {
      const { runs, closedLog } = harness();
      await launch(runs);
      await launch(runs, { senderId: "sender-a", helpSessionId: "help-2" });
      const stranger = await launch(runs, { senderId: "sender-b", helpSessionId: "help-1" });
      runs.endOwner({ senderId: "sender-a" }, "shell-gone");
      expect(runs.list().map((run) => run.runId)).toEqual([stranger.runId]);
      expect(closedLog.map((entry) => entry.reason)).toEqual(["shell-gone", "shell-gone"]);
    });

    it("fails a launch whose owner went while it was starting", async () => {
      let release: (started: boolean) => void = () => {};
      const h = harness({
        spawn: () =>
          new Promise<boolean>((resolve) => {
            release = resolve;
          }),
      });
      const pending = h.runs.call(OWNER, {
        tool: "throwaway.launch",
        args: { agentId: "claude" },
      });
      await vi.waitFor(() => expect(h.runs.list()).toHaveLength(1));
      h.runs.endOwner(OWNER, "session-ended");
      release(true);
      await expect(pending).resolves.toEqual({ ok: false, reason: "launch-failed" });
      expect(h.runs.list()).toEqual([]);
    });

    it("fails a launch whose owner went while its agent was being checked", async () => {
      let answer: (launchable: boolean) => void = () => {};
      const h = harness({
        isLaunchable: () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      });
      const pending = h.runs.call(OWNER, {
        tool: "throwaway.launch",
        args: { agentId: "claude" },
      });
      await Promise.resolve();
      h.runs.endOwner(OWNER, "session-ended");
      answer(true);
      await expect(pending).resolves.toEqual({ ok: false, reason: "launch-failed" });
      expect(h.spawned).toEqual([]);
      expect(h.runs.list()).toEqual([]);
    });

    it("logs every run the host stopped serving", async () => {
      const { runs, closedLog, pendingTimers } = harness();
      await launch(runs);
      runs.endAll();
      expect(closedLog).toMatchObject([{ reason: "host-stopped" }]);
      expect(pendingTimers()).toBe(0);
    });
  });
});
