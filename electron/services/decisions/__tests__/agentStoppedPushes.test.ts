import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ powerMonitor: { on: vi.fn(), off: vi.fn() } }));

import type { AgentStoppedPushResult } from "@daintreehq/decisions-client";
import type { UserPresence } from "../../userPresence.js";
import type { PresenceWatchers } from "../desktopPresence.js";
import {
  AGENT_STOPPED_BATCH_MS,
  AGENT_STOPPED_COOLDOWN_MS,
  AGENT_STOPPED_SETTLE_MS,
  AgentStoppedPushes,
  type AgentTransition,
} from "../agentStoppedPushes.js";

function harness(initial: UserPresence = "away") {
  let presence: UserPresence = initial;
  let allowed = true;
  let quiet = false;
  let live = true;
  const putAside = new Set<string>();
  const transitions = new Set<(t: AgentTransition) => void>();
  const suspend = new Set<() => void>();
  const resume = new Set<() => void>();
  const change = new Set<() => void>();
  const watch: PresenceWatchers = {
    onSuspend: (l) => (suspend.add(l), () => suspend.delete(l)),
    onResume: (l) => (resume.add(l), () => resume.delete(l)),
    onChange: (l) => (change.add(l), () => change.delete(l)),
  };
  const outcomes: Array<AgentStoppedPushResult["outcome"]> = [];
  const send = vi.fn((): Promise<AgentStoppedPushResult> | null => {
    if (!live) return null;
    return Promise.resolve({ outcome: outcomes.shift() ?? "sent" });
  });
  const pushes = new AgentStoppedPushes({
    allowed: () => allowed,
    presence: () => presence,
    quiet: () => quiet,
    putAside: (id) => putAside.has(id),
    watchTransitions: (l) => (transitions.add(l), () => transitions.delete(l)),
    send,
    watch,
    now: () => Date.now(),
  });
  const emit = (terminalId: string, state: string, previousState: string, closing = false) =>
    transitions.forEach((l) =>
      l({ terminalId, state, previousState, ...(closing ? { terminalClosing: true } : {}) })
    );
  return {
    pushes,
    send,
    outcomes,
    emit,
    stop: (id: string, from = "working") => emit(id, "completed", from),
    resume: (id: string) => emit(id, "working", "completed"),
    setPresence: (next: UserPresence) => (presence = next),
    allow: (next: boolean) => (allowed = next),
    setQuiet: (next: boolean) => (quiet = next),
    setLive: (next: boolean) => (live = next),
    putAside,
    suspend: () => suspend.forEach((l) => l()),
    change: () => change.forEach((l) => l()),
    listeners: () => transitions.size + suspend.size + resume.size + change.size,
  };
}

describe("AgentStoppedPushes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens to nothing while it isn't allowed, and stops listening when it no longer is", () => {
    const h = harness();
    h.allow(false);
    h.pushes.update();
    expect(h.listeners()).toBe(0);
    expect(h.pushes.listening).toBe(false);
    h.allow(true);
    h.pushes.update();
    expect(h.listeners()).toBeGreaterThan(0);
    h.allow(false);
    h.pushes.update();
    expect(h.listeners()).toBe(0);
  });

  it("asks once for stops that land close together, after the batch window", async () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    vi.advanceTimersByTime(1_000);
    h.emit("b", "exited", "working");
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS - 1_001);
    expect(h.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS * 2);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
  });

  it("counts completed then exited as the one stop", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    vi.advanceTimersByTime(1_500);
    h.emit("a", "exited", "completed");
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS - 1_500);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
  });

  it("drops a stop whose agent goes back to work, or to anything else, before the batch goes", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    vi.advanceTimersByTime(1_000);
    h.resume("a");
    h.stop("b");
    vi.advanceTimersByTime(500);
    h.emit("b", "waiting", "completed");
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("waits for a stop that came late in the window to settle once an earlier one went back to work", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    vi.advanceTimersByTime(2_900);
    h.stop("b");
    vi.advanceTimersByTime(50);
    h.resume("a");
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS - 2_950);
    expect(h.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2_900 + AGENT_STOPPED_SETTLE_MS - AGENT_STOPPED_BATCH_MS - 1);
    expect(h.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
  });

  it("holds stops in the relay's minute after a request for one more request, never dropping them to the relay", async () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.resume("a");
    await vi.advanceTimersByTimeAsync(10_000);
    h.stop("a");
    await vi.advanceTimersByTimeAsync(5_000);
    h.emit("c", "exited", "working");
    // A minute and its margin from the request, not from these stops.
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS - 15_000 - 1);
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.pushes.stop();
  });

  it.each(["present", "unknown"] as const)("admits no stop while the person is %s", (presence) => {
    const h = harness(presence);
    h.pushes.update();
    h.stop("a");
    h.setPresence("away");
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it.each(["present", "unknown"] as const)(
    "drops the batch when the person reads %s as it goes out",
    (presence) => {
      const h = harness();
      h.pushes.update();
      h.stop("a");
      vi.advanceTimersByTime(1_000);
      h.setPresence(presence);
      vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS);
      expect(h.send).not.toHaveBeenCalled();
      // Away again later: the dropped stops stay dropped.
      h.setPresence("away");
      vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
      expect(h.send).not.toHaveBeenCalled();
      h.pushes.stop();
    }
  );

  it("drops the batch when the person is seen back, even if they've gone again by the time it would go", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    vi.advanceTimersByTime(1_000);
    h.setPresence("present");
    h.change();
    h.setPresence("away");
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("keeps the batch through a change that still reads away", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    h.change();
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
  });

  it("drops the batch when the computer sleeps", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    h.suspend();
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("admits nothing in quiet hours, and drops the batch when they start before it goes", () => {
    const h = harness();
    h.pushes.update();
    h.setQuiet(true);
    h.stop("a");
    h.setQuiet(false);
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.stop("b");
    vi.advanceTimersByTime(1_000);
    h.setQuiet(true);
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("leaves out a run put aside, whether before its stop or before the batch goes", () => {
    const h = harness();
    h.pushes.update();
    h.putAside.add("a");
    h.stop("a");
    vi.advanceTimersByTime(AGENT_STOPPED_BATCH_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.stop("b");
    vi.advanceTimersByTime(1_000);
    h.putAside.add("b");
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("ignores Daintree closing a terminal, and a closing edge clears its pending stop", () => {
    const h = harness();
    h.pushes.update();
    h.emit("a", "exited", "working", true);
    h.emit("b", "completed", "working");
    h.emit("b", "exited", "completed", true);
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("ignores a repeat of the same state and a transition with no terminal", () => {
    const h = harness();
    h.pushes.update();
    h.emit("a", "completed", "completed");
    h.emit("", "completed", "working");
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("drops the batch when it stops being allowed, and asks nothing for it on a later start", () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    h.allow(false);
    h.pushes.update();
    h.allow(true);
    h.pushes.update();
    vi.advanceTimersByTime(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).not.toHaveBeenCalled();
    h.pushes.stop();
  });

  it("drops the batch when no bridge is live as it goes, without starting the relay's minute", async () => {
    const h = harness();
    h.pushes.update();
    h.setLive(false);
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.setLive(true);
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.resume("a");
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.pushes.stop();
  });

  it("never asks again for a request that didn't go through", async () => {
    const h = harness();
    h.outcomes.push("dropped");
    h.pushes.update();
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS * 3);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
  });

  it("keeps the relay's minute across a stop and a start", async () => {
    const h = harness();
    h.pushes.update();
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    h.pushes.stop();
    h.pushes.update();
    h.stop("b");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_COOLDOWN_MS - 1);
    expect(h.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.send).toHaveBeenCalledTimes(2);
    h.pushes.stop();
  });

  it("survives a send that throws", async () => {
    const h = harness();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.send.mockImplementationOnce(() => {
      throw new Error("bridge refused");
    });
    h.pushes.update();
    h.stop("a");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    h.stop("b");
    await vi.advanceTimersByTimeAsync(AGENT_STOPPED_BATCH_MS);
    expect(h.send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
    h.pushes.stop();
  });
});
