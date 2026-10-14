import { afterEach, describe, expect, it } from "vitest";
import {
  pendingWorktreeSnapshot,
  resetWorktreeSnapshotSyncForTesting,
  trackWorktreeSnapshot,
} from "../worktreeSnapshotSync";

function deferred() {
  let resolve: () => void = () => {};
  let reject: (err: Error) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function isSettled(promise: Promise<void>): Promise<boolean> {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe("worktreeSnapshotSync (#13348)", () => {
  afterEach(() => {
    resetWorktreeSnapshotSyncForTesting();
  });

  it("is null with nothing in flight, so a dispatch stays synchronous", () => {
    expect(pendingWorktreeSnapshot()).toBeNull();
  });

  it("resolves once the tracked fetch settles, then reads as idle", async () => {
    const fetch = deferred();
    trackWorktreeSnapshot(fetch.promise);

    const waiting = pendingWorktreeSnapshot()!;
    expect(await isSettled(waiting)).toBe(false);

    fetch.resolve();
    expect(await isSettled(waiting)).toBe(true);
    expect(pendingWorktreeSnapshot()).toBeNull();
  });

  it("resolves rather than rejects when the fetch fails", async () => {
    const fetch = deferred();
    trackWorktreeSnapshot(fetch.promise);
    const waiting = pendingWorktreeSnapshot()!;

    fetch.reject(new Error("port closed"));

    await expect(waiting).resolves.toBeUndefined();
  });

  it("follows a fetch that supersedes the one it started on", async () => {
    // A cold start whose snapshot loses to a live update refetches from inside
    // the first chain; the store is only current once the second one lands.
    const first = deferred();
    const second = deferred();
    trackWorktreeSnapshot(first.promise);
    const waiting = pendingWorktreeSnapshot()!;

    trackWorktreeSnapshot(second.promise);
    first.resolve();
    expect(await isSettled(waiting)).toBe(false);

    second.resolve();
    expect(await isSettled(waiting)).toBe(true);
  });

  it("is not cleared by an older fetch settling after a newer one began", async () => {
    const first = deferred();
    const second = deferred();
    trackWorktreeSnapshot(first.promise);
    trackWorktreeSnapshot(second.promise);

    first.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pendingWorktreeSnapshot()).not.toBeNull();
    second.resolve();
  });
});
