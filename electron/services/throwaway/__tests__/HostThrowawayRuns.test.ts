import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HostThrowawayToolResultSchema,
  type HostThrowawayCall,
} from "../../../../shared/types/hostThrowaway.js";
import { isHostThrowawayTerminalId } from "../../../../shared/config/hostThrowaway.js";
import {
  HOST_THROWAWAY_CLOSE_WAIT_MS,
  HOST_THROWAWAY_EXITED_RETENTION_MS,
  HostThrowawayRuns,
  MAX_HOST_THROWAWAY_RUNS,
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
  const held: { runs?: HostThrowawayRuns } = {};
  const deps: HostThrowawayRunsDeps = {
    now: () => clock,
    newId: () => `id-${++ids}`,
    sleep: async () => {},
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
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function launch(runs: HostThrowawayRuns, owner = OWNER) {
  const outcome = await runs.call(owner, {
    tool: "throwaway.launch",
    args: { agentId: "claude" },
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
      timeLimitMs: null,
      expiresAt: null,
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
        state: "running",
        endedAt: null,
      },
    ]);
    advance(2_500);
    const status = await runs.call(OWNER, { tool: "throwaway.status", args: { runId: run.runId } });
    expect(status).toMatchObject({ ok: true, result: { run: { ageMs: 2_500 } } });
    expect(HostThrowawayToolResultSchema.safeParse(status.ok && status.result).success).toBe(true);
  });

  it("answers the relay as its executor, refusing a time limit it can't keep yet", async () => {
    const { runs, spawned } = harness();
    const options = { callId: "call-1", timeoutMs: 90_000 };
    await expect(
      runs.run(
        OWNER,
        { tool: "throwaway.launch", args: { agentId: "claude", timeLimitMs: 60_000 } },
        options
      )
    ).resolves.toEqual({ status: "refused", reason: "expiry-unsupported" });
    expect(spawned).toEqual([]);
    const launched = await runs.run(
      OWNER,
      { tool: "throwaway.launch", args: { agentId: "claude" } },
      options
    );
    expect(launched).toMatchObject({ status: "done", result: { tool: "throwaway.launch" } });
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
    const { runs, spawned, advance } = harness();
    const run = await launch(runs);
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
});
