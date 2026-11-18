// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CountableTerminal } from "../../../services/projectAgentCounts.js";
import {
  HostIdleTracker,
  agentWorkOf,
  seesWork,
  type HostWorkReading,
} from "../HostIdleTracker.js";

const MINUTE = 60_000;

function harness(options: { minutes?: number; read?: () => Promise<HostWorkReading> } = {}) {
  const now = { wall: 1_000_000, mono: 500 };
  let terminals: CountableTerminal[] = [];
  let shellViews = false;
  let minutes = options.minutes ?? 30;
  const read = vi.fn(
    options.read ?? (async () => ({ agents: agentWorkOf(terminals), shellViews }))
  );
  const tracker = new HostIdleTracker({
    read,
    idleAfterMinutes: () => minutes,
    clock: () => ({ ...now }),
  });
  return {
    tracker,
    read,
    advance(ms: number) {
      now.wall += ms;
      now.mono += ms;
    },
    stepWall(ms: number) {
      now.wall += ms;
    },
    get now() {
      return { ...now };
    },
    setTerminals(next: CountableTerminal[]) {
      terminals = next;
    },
    setShellViews(next: boolean) {
      shellViews = next;
    },
    setMinutes(next: number) {
      minutes = next;
    },
  };
}

const agent = (agentState: CountableTerminal["agentState"] | string): CountableTerminal => ({
  id: `t-${String(agentState)}`,
  detectedAgentId: "claude",
  agentState: agentState as CountableTerminal["agentState"],
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HostIdleTracker (#17357)", () => {
  it("lets the idle clock run once a check finds no work, from that check", async () => {
    const h = harness();
    h.setTerminals([agent("idle"), agent("completed"), agent("exited")]);
    h.advance(1_000);
    const checkedAt = h.now.wall;
    await h.tracker.check();
    h.advance(10 * MINUTE);

    expect(h.tracker.observation()).toEqual({
      idleAfterMinutes: 30,
      lastWorkAt: checkedAt,
      busy: false,
      idleEndsAt: checkedAt + 30 * MINUTE,
    });

    // Later checks that find no work leave the clock where it started.
    await h.tracker.check();
    h.advance(10 * MINUTE);
    await h.tracker.check();
    expect(h.tracker.observation()).toMatchObject({
      lastWorkAt: checkedAt,
      idleEndsAt: checkedAt + 30 * MINUTE,
    });
  });

  it("counts the idle time from when a check that found no work finished, not when it began", async () => {
    let release: () => void = () => {};
    const h = harness({
      read: () =>
        new Promise<HostWorkReading>((resolve) => {
          // A window still open when the read began closes before its last part is taken.
          release = () => resolve({ agents: { active: 0, unreadable: 0 }, shellViews: false });
        }),
    });
    const check = h.tracker.check();
    h.advance(4_000);
    const finishedAt = h.now.wall;
    release();
    await check;
    expect(h.tracker.observation()).toMatchObject({
      busy: false,
      lastWorkAt: finishedAt,
      idleEndsAt: finishedAt + 30 * MINUTE,
    });
  });

  it.each([
    ["a working agent", () => [agent("working")], false],
    ["a waiting agent", () => [agent("waiting")], false],
    ["a directing agent", () => [agent("directing")], false],
    ["an agent whose state can't be read", () => [agent(undefined)], false],
    ["an agent in a state no build knows", () => [agent("thinking")], false],
    ["a Shell's window open on the host", () => [agent("idle")], true],
  ])("holds the idle clock for %s", async (_name, terminals, shellViews) => {
    const h = harness();
    await h.tracker.check();
    expect(h.tracker.observation().busy).toBe(false);

    h.setTerminals(terminals());
    h.setShellViews(shellViews);
    h.advance(40 * MINUTE);
    await h.tracker.check();
    expect(h.tracker.observation()).toEqual({
      idleAfterMinutes: 30,
      lastWorkAt: h.now.wall,
      busy: true,
      idleEndsAt: null,
    });

    // The work ends: the idle time counts from the first check that found none.
    h.setTerminals([agent("idle")]);
    h.setShellViews(false);
    h.advance(MINUTE);
    const freedAt = h.now.wall;
    await h.tracker.check();
    h.advance(5 * MINUTE);
    expect(h.tracker.observation()).toMatchObject({
      busy: false,
      lastWorkAt: freedAt,
      idleEndsAt: freedAt + 30 * MINUTE,
    });
  });

  it("holds the clock when the agents can't all be read, or the read fails or hangs", async () => {
    vi.useFakeTimers();
    let answer: () => Promise<HostWorkReading> = async () => ({ agents: null, shellViews: false });
    const h = harness({ read: () => answer() });
    await h.tracker.check();
    expect(h.tracker.observation().busy).toBe(true);

    answer = async () => ({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await h.tracker.check();
    expect(h.tracker.observation().busy).toBe(false);

    answer = async () => {
      throw new Error("pty host gone");
    };
    await h.tracker.check();
    expect(h.tracker.observation().busy).toBe(true);

    answer = async () => ({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await h.tracker.check();
    answer = () => new Promise<HostWorkReading>(() => {});
    const hanging = h.tracker.check();
    await vi.advanceTimersByTimeAsync(10_000);
    await hanging;
    expect(h.tracker.observation().busy).toBe(true);
  });

  it("treats a plain shell, a shell that once ran an agent, and a pane with no process as no work", () => {
    expect(
      agentWorkOf([
        { id: "shell" },
        { id: "demoted", launchAgentId: "claude", everDetectedAgent: true, agentState: "working" },
        { id: "gone", detectedAgentId: "claude", hasPty: false, agentState: "working" },
      ])
    ).toEqual({ active: 0, unreadable: 0 });
  });

  it("counts an agent the fleet leaves out of its tallies, and one still starting", () => {
    expect(
      agentWorkOf([
        {
          id: "assistant",
          detectedAgentId: "claude",
          isAssistantTerminal: true,
          agentState: "working",
        },
        { id: "trashed", detectedAgentId: "codex", isTrashed: true, agentState: "waiting" },
        { id: "starting", launchAgentId: "gemini" },
      ])
    ).toEqual({ active: 2, unreadable: 1 });
    expect(seesWork({ agents: { active: 0, unreadable: 1 }, shellViews: false })).toBe(true);
  });

  it("takes an agent's turn to work between checks over a check that missed it", async () => {
    let release: (reading: HostWorkReading) => void = () => {};
    const h = harness({
      read: () =>
        new Promise<HostWorkReading>((resolve) => {
          release = resolve;
        }),
    });
    const first = h.tracker.check();
    release({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await first;
    expect(h.tracker.observation().busy).toBe(false);

    h.advance(MINUTE);
    const second = h.tracker.check();
    h.advance(1_000);
    h.tracker.noteWork();
    const notedAt = h.now.wall;
    release({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await second;
    expect(h.tracker.observation()).toMatchObject({ busy: true, lastWorkAt: notedAt });

    // The same, with the event landing on the very tick the check began.
    const third = h.tracker.check();
    release({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await third;
    expect(h.tracker.observation().busy).toBe(false);
    const fourth = h.tracker.check();
    h.tracker.noteWork();
    release({ agents: { active: 0, unreadable: 0 }, shellViews: false });
    await fourth;
    expect(h.tracker.observation().busy).toBe(true);
  });

  it("shares a check under way rather than reading twice", async () => {
    const h = harness();
    await Promise.all([h.tracker.check(), h.tracker.check()]);
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it("follows a changed idle time at once, the end moving with it", async () => {
    const h = harness();
    const checkedAt = h.now.wall;
    await h.tracker.check();
    h.setMinutes(60);
    expect(h.tracker.observation()).toMatchObject({
      idleAfterMinutes: 60,
      idleEndsAt: checkedAt + 60 * MINUTE,
    });
  });

  it("never ends the idle time sooner for a wall clock stepped forward", async () => {
    const h = harness();
    const checkedAt = h.now.wall;
    await h.tracker.check();
    h.advance(5 * MINUTE);
    h.stepWall(60 * MINUTE);
    // Five minutes really passed: twenty-five are left, by the wall clock now.
    expect(h.tracker.observation().idleEndsAt).toBe(h.now.wall + 25 * MINUTE);
    expect(h.tracker.observation().idleEndsAt).toBeGreaterThan(checkedAt + 30 * MINUTE);
  });

  it("never ends the idle time sooner for a wall clock stepped back, or a machine that slept", async () => {
    const h = harness();
    await h.tracker.check();
    h.advance(5 * MINUTE);
    h.stepWall(-60 * MINUTE);
    // The wall clock says no time passed: the whole idle time is still ahead.
    expect(h.tracker.observation().idleEndsAt).toBe(h.now.wall + 30 * MINUTE);

    const slept = harness();
    await slept.tracker.check();
    // Asleep for an hour: the wall clock moved, the monotonic one didn't.
    slept.stepWall(60 * MINUTE);
    expect(slept.tracker.observation().idleEndsAt).toBe(slept.now.wall + 30 * MINUTE);
  });

  it("checks on its own timer until disposed, and nothing after", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.read).toHaveBeenCalledTimes(2);

    h.tracker.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends a read under way when disposed, leaving nothing armed and nothing changed", async () => {
    vi.useFakeTimers();
    const h = harness({ read: () => new Promise<HostWorkReading>(() => {}) });
    const check = h.tracker.check();
    expect(vi.getTimerCount()).toBe(1);

    h.tracker.dispose();
    await check;
    expect(vi.getTimerCount()).toBe(0);
    expect(h.tracker.observation()).toMatchObject({ busy: true, idleEndsAt: null });
  });

  it("starts busy: a host that just started hasn't been idle for any time", () => {
    const h = harness();
    expect(h.tracker.observation()).toMatchObject({ busy: true, idleEndsAt: null });
  });
});

describe("HostIdleTracker.checkFresh (#17361)", () => {
  it("waits out a read already under way, then reads afresh with the fresh reader", async () => {
    let release: () => void = () => {};
    let cached = 0;
    const tracker = new HostIdleTracker({
      read: async () => {
        cached += 1;
        await new Promise<void>((resolve) => (release = resolve));
        return { agents: { active: 0, unreadable: 0 }, shellViews: false };
      },
      readFresh: async () => ({ agents: { active: 1, unreadable: 0 }, shellViews: false }),
      idleAfterMinutes: () => 30,
    });
    const early = tracker.check();
    const fresh = tracker.checkFresh();
    release();
    await Promise.all([early, fresh]);
    expect(cached).toBe(1);
    expect(tracker.observation().busy).toBe(true);
    tracker.dispose();
  });

  it("waits out every read before it, fresh ones included, then reads once more itself", async () => {
    const releases: Array<() => void> = [];
    let fresh = 0;
    const tracker = new HostIdleTracker({
      read: async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return { agents: { active: 0, unreadable: 0 }, shellViews: false };
      },
      readFresh: async () => {
        fresh += 1;
        if (fresh === 1) await new Promise<void>((resolve) => releases.push(resolve));
        return { agents: { active: fresh === 2 ? 1 : 0, unreadable: 0 }, shellViews: false };
      },
      idleAfterMinutes: () => 30,
    });
    const cached = tracker.check();
    const first = tracker.checkFresh();
    const second = tracker.checkFresh();
    releases.shift()!();
    await cached;
    await vi.waitFor(() => expect(fresh).toBe(1));
    releases.shift()!();
    await Promise.all([first, second]);
    // The second didn't share the first's read: it began after it.
    expect(fresh).toBe(2);
    expect(tracker.observation().busy).toBe(true);
    tracker.dispose();
  });
});
