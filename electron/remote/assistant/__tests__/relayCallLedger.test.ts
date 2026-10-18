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
