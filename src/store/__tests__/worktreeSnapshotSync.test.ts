import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetWorktreeSnapshotSyncForTesting,
  trackWorktreeSnapshot,
  waitForWorktreeSnapshot,
} from "../worktreeSnapshotSync";

const WAIT_MS = 10_000;

function deferred() {
  let resolve: () => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Whether `promise` settles once every pending microtask has run. */
async function settlesNow(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return settled;
}

describe("worktreeSnapshotSync (#13348)", () => {
  afterEach(() => {
    resetWorktreeSnapshotSyncForTesting();
    vi.useRealTimers();
  });

  it("is null with nothing in flight, so a dispatch stays synchronous", () => {
    expect(waitForWorktreeSnapshot(WAIT_MS)).toBeNull();
  });

  it("resolves once the tracked fetch settles, then reads as idle", async () => {
    const fetch = deferred();
    trackWorktreeSnapshot(fetch.promise);

    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;
    expect(await settlesNow(waiting)).toBe(false);

    fetch.resolve();
    expect(await settlesNow(waiting)).toBe(true);
    expect(waitForWorktreeSnapshot(WAIT_MS)).toBeNull();
  });

  it("resolves rather than rejects when the fetch fails", async () => {
    const fetch = deferred();
    trackWorktreeSnapshot(fetch.promise);
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;

    fetch.reject(new Error("port closed"));

    await expect(waiting).resolves.toBeUndefined();
  });

  it("follows a fetch that supersedes the one it started on", async () => {
    // A cold start whose snapshot loses to a live update refetches from inside
    // the first chain; the store is only current once the second one lands.
    const first = deferred();
    const second = deferred();
    trackWorktreeSnapshot(first.promise);
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;

    trackWorktreeSnapshot(second.promise);
    first.resolve();
    expect(await settlesNow(waiting)).toBe(false);

    second.resolve();
    expect(await settlesNow(waiting)).toBe(true);
  });

  it("is released by a newer fetch landing while the one it started on is stuck", async () => {
    // A superseded fetch can hang on its associations read; the store is
    // current as soon as its replacement lands.
    const stuck = deferred();
    const replacement = deferred();
    trackWorktreeSnapshot(stuck.promise);
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;

    trackWorktreeSnapshot(replacement.promise);
    replacement.resolve();

    expect(await settlesNow(waiting)).toBe(true);
    expect(waitForWorktreeSnapshot(WAIT_MS)).toBeNull();
  });

  it("is not cleared by an older fetch settling after a newer one began", async () => {
    const first = deferred();
    const second = deferred();
    trackWorktreeSnapshot(first.promise);
    trackWorktreeSnapshot(second.promise);

    first.resolve();
    await settlesNow(first.promise);

    expect(waitForWorktreeSnapshot(WAIT_MS)).not.toBeNull();
    second.resolve();
  });

  it("gives up on a fetch that never settles", async () => {
    vi.useFakeTimers();
    trackWorktreeSnapshot(new Promise<void>(() => {}));
    const waiting = waitForWorktreeSnapshot(WAIT_MS)!;

    await vi.advanceTimersByTimeAsync(WAIT_MS - 1);
    expect(await settlesNow(waiting)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await settlesNow(waiting)).toBe(true);
  });
});
