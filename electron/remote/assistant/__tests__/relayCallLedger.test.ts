import { describe, expect, it, vi } from "vitest";
import { RelayCallLedger } from "../relayCallLedger.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("RelayCallLedger", () => {
  it("runs a first send once and answers a later send of it from its record", async () => {
    const ledger = new RelayCallLedger<string>();
    const work = vi.fn(async () => "launched");

    await expect(ledger.run("shell-a", "call-1", "d1", false, work)).resolves.toEqual({
      status: "answered",
      value: "launched",
    });
    await expect(ledger.run("shell-a", "call-1", "d1", true, work)).resolves.toEqual({
      status: "answered",
      value: "launched",
    });
    // A repeated first send is the same call too: it never runs twice.
    await expect(ledger.run("shell-a", "call-1", "d1", false, work)).resolves.toEqual({
      status: "answered",
      value: "launched",
    });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("joins a resend that arrives while the first send still runs", async () => {
    const ledger = new RelayCallLedger<string>();
    const gate = deferred<string>();
    const work = vi.fn(() => gate.promise);

    const first = ledger.run("shell-a", "call-1", "d1", false, work);
    const resend = ledger.run("shell-a", "call-1", "d1", true, work);
    gate.resolve("done");

    await expect(first).resolves.toEqual({ status: "answered", value: "done" });
    await expect(resend).resolves.toEqual({ status: "answered", value: "done" });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("never starts a resend it holds no record of", async () => {
    const ledger = new RelayCallLedger<string>();
    const work = vi.fn(async () => "launched");

    await expect(ledger.run("shell-a", "call-1", "d1", true, work)).resolves.toEqual({
      status: "unknown",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses a call id reused for a different call", async () => {
    const ledger = new RelayCallLedger<string>();
    await ledger.run("shell-a", "call-1", "d1", false, async () => "first");
    const work = vi.fn(async () => "second");

    await expect(ledger.run("shell-a", "call-1", "d2", false, work)).resolves.toEqual({
      status: "conflict",
    });
    expect(work).not.toHaveBeenCalled();
  });

  it("answers a resend of a failed call with the same failure, without running it again", async () => {
    const ledger = new RelayCallLedger<string>();
    const work = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(ledger.run("shell-a", "call-1", "d1", false, work)).rejects.toThrow("boom");
    await expect(ledger.run("shell-a", "call-1", "d1", true, work)).rejects.toThrow("boom");
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("keeps each caller's ids apart", async () => {
    const ledger = new RelayCallLedger<string>();
    await ledger.run("shell-a", "call-1", "d1", false, async () => "a");

    await expect(ledger.run("shell-b", "call-1", "other", false, async () => "b")).resolves.toEqual(
      { status: "answered", value: "b" }
    );
    await expect(ledger.run("shell-b", "call-2", "d1", true, async () => "b")).resolves.toEqual({
      status: "unknown",
    });
  });

  it("forgets a settled call past its retention, after which a resend is unknown", async () => {
    let clock = 1_000;
    const ledger = new RelayCallLedger<string>({ now: () => clock, retentionMs: 60_000 });
    await ledger.run("shell-a", "call-1", "d1", false, async () => "launched");

    clock += 59_000;
    await expect(ledger.run("shell-a", "call-1", "d1", true, async () => "x")).resolves.toEqual({
      status: "answered",
      value: "launched",
    });
    clock += 2_000;
    await expect(ledger.run("shell-a", "call-1", "d1", true, async () => "x")).resolves.toEqual({
      status: "unknown",
    });
  });

  it("drops the oldest settled records past its bounds, never one still running", async () => {
    const ledger = new RelayCallLedger<string>({ maxSettled: 2, sizeOf: () => 1 });
    const gate = deferred<string>();
    const running = ledger.run("shell-a", "running", "d0", false, () => gate.promise);
    for (const id of ["one", "two", "three"]) {
      await ledger.run("shell-a", id, `d-${id}`, false, async () => id);
    }

    await expect(ledger.run("shell-a", "one", "d-one", true, async () => "x")).resolves.toEqual({
      status: "unknown",
    });
    await expect(ledger.run("shell-a", "three", "d-three", true, async () => "x")).resolves.toEqual(
      { status: "answered", value: "three" }
    );
    const joined = ledger.run("shell-a", "running", "d0", true, async () => "x");
    gate.resolve("finished");
    await expect(running).resolves.toEqual({ status: "answered", value: "finished" });
    await expect(joined).resolves.toEqual({ status: "answered", value: "finished" });
  });

  it("drops every caller's expired records on a sweep, so one that never calls again keeps none", async () => {
    let clock = 0;
    const ledger = new RelayCallLedger<string>({ now: () => clock, retentionMs: 1_000 });
    const gate = deferred<string>();
    await ledger.run("gone", "c1", "d1", false, async () => "a");
    const running = ledger.run("busy", "c1", "d1", false, () => gate.promise);
    clock = 5_000;
    expect(ledger.size).toBe(2);
    ledger.sweep();

    // Read without a call of its own, which would prune it anyway.
    expect(ledger.size).toBe(1);
    // One still running is never swept.
    const joined = ledger.run("busy", "c1", "d1", true, async () => "x");
    gate.resolve("finished");
    await expect(joined).resolves.toEqual({ status: "answered", value: "finished" });
    await running;
  });

  it("bounds settled records by their size", async () => {
    const ledger = new RelayCallLedger<string>({
      maxSettledBytes: 10,
      sizeOf: (value) => value.length,
    });
    await ledger.run("shell-a", "big", "d1", false, async () => "123456");
    await ledger.run("shell-a", "bigger", "d2", false, async () => "1234567");

    await expect(ledger.run("shell-a", "big", "d1", true, async () => "x")).resolves.toEqual({
      status: "unknown",
    });
    await expect(ledger.run("shell-a", "bigger", "d2", true, async () => "x")).resolves.toEqual({
      status: "answered",
      value: "1234567",
    });
  });
});

describe("RelayCallLedger cancels (#17985)", () => {
  /** Work that runs until its stop is pulled, then answers how it ended. */
  function stoppable() {
    const started = deferred<AbortSignal>();
    const work = vi.fn(
      (signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          started.resolve(signal);
          if (signal.aborted) resolve("stopped before");
          signal.addEventListener("abort", () => resolve("stopped"), { once: true });
        })
    );
    return { started: started.promise, work };
  }

  it("stops a running call for the help session that sent it, once however often asked", async () => {
    const ledger = new RelayCallLedger<string>();
    const { started, work } = stoppable();
    // Another call of the same caller and help session runs on.
    const sibling = stoppable();
    const other = ledger.run("shell-a", "call-2", "d2", false, sibling.work, "help-1");
    const first = ledger.run("shell-a", "call-1", "d1", false, work, "help-1");
    const joined = ledger.run("shell-a", "call-1", "d1", true, work, "help-1");
    const signal = await started;
    const heard = vi.fn();
    signal.addEventListener("abort", heard);

    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("aborted");
    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("aborted");

    await expect(first).resolves.toEqual({ status: "answered", value: "stopped" });
    // A resend joined to it shares the one stop and the one answer.
    await expect(joined).resolves.toEqual({ status: "answered", value: "stopped" });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(1);
    expect((await sibling.started).aborted).toBe(false);
    ledger.cancel("shell-a", "help-1", "call-2");
    await other;
    // Settled now: a later cancel changes nothing, and a resend reads the same answer.
    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("ignored");
    await expect(ledger.run("shell-a", "call-1", "d1", true, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "stopped",
    });
  });

  it("leaves another help session's or another caller's call running", async () => {
    const ledger = new RelayCallLedger<string>();
    const gate = deferred<string>();
    let signal: AbortSignal | null = null;
    const running = ledger.run(
      "shell-a",
      "call-1",
      "d1",
      false,
      (stop) => {
        signal = stop;
        return gate.promise;
      },
      "help-1"
    );

    expect(ledger.cancel("shell-a", "help-2", "call-1")).toBe("ignored");
    // Another Shell naming the same id holds a cancel for a call of its own, not this one.
    expect(ledger.cancel("shell-b", "help-1", "call-1")).toBe("held");
    expect(signal!.aborted).toBe(false);
    gate.resolve("done");
    await expect(running).resolves.toEqual({ status: "answered", value: "done" });
    // ...which its own first send then starts with.
    const work = vi.fn(async (stop: AbortSignal) => (stop.aborted ? "stopped" : "ran"));
    await expect(ledger.run("shell-b", "call-1", "d1", false, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "stopped",
    });
  });

  it("never stops a first send with another help session's early cancel", async () => {
    const ledger = new RelayCallLedger<string>();
    expect(ledger.cancel("shell-a", "help-2", "call-1")).toBe("held");
    const work = vi.fn(async (stop: AbortSignal) => (stop.aborted ? "stopped" : "ran"));

    await expect(ledger.run("shell-a", "call-1", "d1", false, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "ran",
    });
    expect(ledger.pendingCancelCount).toBe(1);
  });

  it("drops an early cancel whose first send conflicts, so it can't stop a later call under the id", async () => {
    let clock = 0;
    const ledger = new RelayCallLedger<string>({ now: () => clock, retentionMs: 1_000 });
    expect(ledger.cancel("shell-a", "help-2", "call-1")).toBe("held");
    await ledger.run("shell-a", "call-1", "d1", false, async () => "first", "help-1");
    // Its own first send is another call under a taken id, so it never runs.
    await expect(ledger.run("shell-a", "call-1", "d2", false, vi.fn(), "help-2")).resolves.toEqual({
      status: "conflict",
    });
    expect(ledger.pendingCancelCount).toBe(0);
    clock = 5_000;
    // Once the first call is forgotten, a new call reusing the id runs as any first send does.
    const work = vi.fn(async (stop: AbortSignal) => (stop.aborted ? "stopped" : "ran"));
    await expect(ledger.run("shell-a", "call-1", "d2", false, work, "help-2")).resolves.toEqual({
      status: "answered",
      value: "ran",
    });
  });

  it("keeps a completed call's answer for its resend when the cancel comes after it", async () => {
    const ledger = new RelayCallLedger<string>();
    await ledger.run("shell-a", "call-1", "d1", false, async () => "launched", "help-1");

    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("ignored");
    expect(ledger.pendingCancelCount).toBe(0);
    await expect(ledger.run("shell-a", "call-1", "d1", true, vi.fn(), "help-1")).resolves.toEqual({
      status: "answered",
      value: "launched",
    });
  });

  it("starts a first send stopped when its cancel came first, past a resend and another session's cancel", async () => {
    const ledger = new RelayCallLedger<string>();
    const { work } = stoppable();

    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("held");
    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("held");
    expect(ledger.cancel("shell-a", "help-2", "call-1")).toBe("held");
    // A resend ahead of its first send starts nothing, and leaves the cancel for that send.
    await expect(ledger.run("shell-a", "call-1", "d1", true, work, "help-1")).resolves.toEqual({
      status: "unknown",
    });
    expect(work).not.toHaveBeenCalled();
    await expect(ledger.run("shell-a", "call-1", "d1", false, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "stopped before",
    });
    expect((work.mock.calls[0]![0] as AbortSignal).aborted).toBe(true);
    // Its answer is the call's record: a resend reads it, and nothing runs again.
    await expect(ledger.run("shell-a", "call-1", "d1", true, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "stopped before",
    });
    expect(work).toHaveBeenCalledTimes(1);
    // The other help session's cancel still waits for a call of its own.
    expect(ledger.pendingCancelCount).toBe(1);
  });

  it("runs a first send as usual once its early cancel has expired", async () => {
    let clock = 0;
    const ledger = new RelayCallLedger<string>({
      now: () => clock,
      pendingCancelRetentionMs: 1_000,
    });
    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("held");
    clock = 500;
    // Asked again: it keeps the time it was first asked.
    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("held");
    clock = 1_001;
    const work = vi.fn(async (signal: AbortSignal) => (signal.aborted ? "stopped" : "ran"));

    await expect(ledger.run("shell-a", "call-1", "d1", false, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "ran",
    });
  });

  it("refuses a new early cancel past its caller's room, never dropping one it holds", async () => {
    const ledger = new RelayCallLedger<string>({ maxPendingCancels: 2 });
    expect(ledger.cancel("shell-a", "help-1", "c1")).toBe("held");
    expect(ledger.cancel("shell-a", "help-2", "c2")).toBe("held");
    expect(ledger.cancel("shell-a", "help-1", "c3")).toBe("full");
    // One already held is held still; another caller has room of its own.
    expect(ledger.cancel("shell-a", "help-1", "c1")).toBe("held");
    expect(ledger.cancel("shell-b", "help-1", "c3")).toBe("held");
    // A running call is still stopped when the room is full.
    const { started, work } = stoppable();
    const running = ledger.run("shell-a", "c4", "d1", false, work, "help-1");
    await started;
    expect(ledger.cancel("shell-a", "help-1", "c4")).toBe("aborted");
    await expect(running).resolves.toEqual({ status: "answered", value: "stopped" });
    // The held ones still stop their calls.
    await expect(ledger.run("shell-a", "c1", "d1", false, work, "help-1")).resolves.toEqual({
      status: "answered",
      value: "stopped before",
    });
  });

  it("drops expired early cancels on a sweep, and every one on clear", () => {
    let clock = 0;
    const ledger = new RelayCallLedger<string>({
      now: () => clock,
      pendingCancelRetentionMs: 1_000,
    });
    ledger.cancel("shell-a", "help-1", "c1");
    clock = 600;
    ledger.cancel("shell-b", "help-1", "c2");
    clock = 1_200;
    ledger.sweep();
    expect(ledger.pendingCancelCount).toBe(1);
    ledger.clear();
    expect(ledger.pendingCancelCount).toBe(0);
  });

  it("lets nothing cancel a call sent with no help session", async () => {
    const ledger = new RelayCallLedger<string>();
    const gate = deferred<string>();
    let signal: AbortSignal | null = null;
    const running = ledger.run("shell-a", "call-1", "d1", false, (stop) => {
      signal = stop;
      return gate.promise;
    });

    expect(ledger.cancel("shell-a", "help-1", "call-1")).toBe("ignored");
    expect(signal!.aborted).toBe(false);
    gate.resolve("done");
    await running;
  });
});
