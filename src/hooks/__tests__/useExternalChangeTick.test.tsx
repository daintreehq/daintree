// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The channel's real schema, so the cap is asserted against the contract it
// exists to satisfy rather than against a number copied out of the hook.
import { FileWatchFingerprintPayloadSchema } from "../../../electron/schemas/ipc";
import { useExternalChangeTick } from "../useExternalChangeTick";

const fingerprint = vi.fn<(payload: { rootPath: string; paths: string[] }) => Promise<string[]>>();

/** Every promise the hook has been handed, so a flush can await the real work. */
const issued: Array<Promise<unknown>> = [];

vi.mock("@/clients/fileWatchClient", () => ({
  fileWatchClient: {
    fingerprint: (payload: { rootPath: string; paths: string[] }) => {
      const pending = fingerprint(payload);
      issued.push(pending);
      return pending;
    },
  },
}));

/**
 * Settle the mount-time sample. Testing Library's `waitFor` schedules its own
 * timers, which never fire under `vi.useFakeTimers()`, and a fixed number of
 * microtask turns would silently stop being enough the moment the hook grows
 * another promise boundary. Awaiting the mock's own recorded promise ties the
 * wait to the thing being waited on.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.allSettled(issued);
  });
}

/**
 * Fire the next scheduled poll and settle it. `advanceTimersToNextTimerAsync`
 * rather than a literal delay: copying the production cadence here would mean
 * changing the interval forces the same edit in this file.
 */
async function pollOnce(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersToNextTimerAsync();
    await Promise.allSettled(issued);
  });
}

describe("useExternalChangeTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    issued.length = 0;
    fingerprint.mockReset();
    fingerprint.mockResolvedValue(["fp-1"]);
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  it("establishes a baseline without emitting a tick", async () => {
    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));

    await flush();
    expect(fingerprint).toHaveBeenCalled();
    // The pane has just read this file explicitly. A tick here would make it
    // read the same bytes a second time for no reason.
    expect(result.current).toBeUndefined();
  });

  it("emits once the fingerprint moves, and not again while it holds", async () => {
    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));
    await flush();
    expect(fingerprint).toHaveBeenCalledTimes(1);

    fingerprint.mockResolvedValue(["fp-2"]);
    await pollOnce();
    const afterChange = result.current;
    expect(afterChange).toBeDefined();

    await pollOnce();
    expect(result.current).toBe(afterChange);
  });

  it("treats a path becoming unreadable as a change", async () => {
    // Deletion is exactly the staleness the pane cannot otherwise notice, so a
    // null fingerprint has to be a value in the comparison, not a skip.
    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));
    await flush();
    expect(fingerprint).toHaveBeenCalledTimes(1);

    fingerprint.mockResolvedValue([null as unknown as string]);
    await pollOnce();

    expect(result.current).toBeDefined();
  });

  it("does not poll at all when disabled", async () => {
    renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], false));
    await pollOnce();
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("does not poll without a root to confine the paths to", async () => {
    renderHook(() => useExternalChangeTick("", ["/root/a.txt"], true));
    await pollOnce();
    expect(fingerprint).not.toHaveBeenCalled();
  });

  it("does not re-baseline when the caller rebuilds an equivalent path list", async () => {
    // Both panes rebuild this array every render. Re-keying on array identity
    // would restart the baseline continuously, and a change arriving between two
    // rebuilds would be folded into the new baseline instead of reported.
    const { rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useExternalChangeTick("/root", paths, true),
      { initialProps: { paths: ["/root/a", "/root/b"] } }
    );
    await flush();
    expect(fingerprint).toHaveBeenCalledTimes(1);

    // A fresh array with the same contents, and a duplicate the hook must fold
    // away rather than treat as a new set.
    rerender({ paths: ["/root/a", "/root/b", "/root/b"] });
    await flush();

    // No new request: an unchanged set means the standing baseline still holds.
    expect(fingerprint).toHaveBeenCalledTimes(1);
  });

  it("repeats the same request for an unchanged set", async () => {
    const { rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useExternalChangeTick("/root", paths, true),
      { initialProps: { paths: ["/root/a", "/root/b"] } }
    );
    await flush();
    expect(fingerprint).toHaveBeenCalledTimes(1);
    const first = fingerprint.mock.calls[0]?.[0]?.paths;

    rerender({ paths: ["/root/a", "/root/b"] });
    await pollOnce();
    // A second call must actually have happened, or comparing "the last call"
    // would just be re-reading the mount call.
    expect(fingerprint.mock.calls.length).toBeGreaterThan(1);
    const second = fingerprint.mock.calls[fingerprint.mock.calls.length - 1]?.[0]?.paths;

    expect(second).toEqual(first);
  });

  it("emits a request the channel's own schema accepts", async () => {
    // Asserted through the schema rather than against a copied number: the cap
    // exists to satisfy this contract, so the contract is what should fail if
    // the two ever drift apart.
    const many = Array.from({ length: 80 }, (_, index) => `/root/dir-${index}`);
    renderHook(() => useExternalChangeTick("/root", ["/root", ...many], true));

    await flush();
    const payload = fingerprint.mock.calls[0]?.[0];

    expect(FileWatchFingerprintPayloadSchema.safeParse(payload).success).toBe(true);
    // Priority order decides who survives the cap, so the caller's first entry
    // is the one thing that can never be dropped.
    expect(payload?.paths[0]).toBe("/root");
  });

  it("keeps a path containing a newline intact", async () => {
    // A newline is legal in a POSIX filename. A delimiter-joined key would split
    // this into two paths that both fingerprint to null — a file that silently
    // never updates again.
    const awkward = "/root/two\nlines.txt";
    renderHook(() => useExternalChangeTick("/root", [awkward], true));

    await flush();

    expect(fingerprint.mock.calls[0]?.[0]?.paths).toEqual([awkward]);
  });

  it("discards a response for a set the caller has already moved off", async () => {
    // The switch happens while the first request is still pending. Adopting that
    // late answer would emit a tick describing paths the pane no longer shows.
    let resolveFirst: ((value: string[]) => void) | undefined;
    fingerprint.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const { result, rerender } = renderHook(
      ({ paths }: { paths: string[] }) => useExternalChangeTick("/root", paths, true),
      { initialProps: { paths: ["/root/a"] } }
    );
    await act(async () => {
      await Promise.resolve();
    });

    rerender({ paths: ["/root/b"] });
    await act(async () => {
      resolveFirst?.(["changed-a"]);
      await Promise.allSettled(issued);
    });

    expect(result.current).toBeUndefined();
    // The new set must not be stuck behind the abandoned request's latch.
    expect(fingerprint.mock.calls.some(([payload]) => payload.paths[0] === "/root/b")).toBe(true);

    // The load-bearing half: without the guard the late answer overwrites the
    // baseline under the OLD key, so B's next sample looks like B's first one
    // and this genuine change is silently swallowed instead of reported.
    fingerprint.mockResolvedValue(["changed-b"]);
    await pollOnce();
    expect(result.current).toBeDefined();
  });

  it("stops polling while hidden and diffs immediately on reveal", async () => {
    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));
    await flush();
    const afterBaseline = fingerprint.mock.calls.length;

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await pollOnce();
    expect(fingerprint).toHaveBeenCalledTimes(afterBaseline);

    // The write lands while the view is backgrounded — the case that would
    // otherwise need a manual refresh to surface.
    fingerprint.mockResolvedValue(["fp-2"]);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.allSettled(issued);
    });

    expect(fingerprint.mock.calls.length).toBeGreaterThan(afterBaseline);
    expect(result.current).toBeDefined();
  });

  it("survives a bridge that isn't there", async () => {
    // A pane can render before the preload bridge is wired; losing the live
    // tick is degraded, throwing out of the effect is broken.
    fingerprint.mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined");
    });

    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));
    await pollOnce();

    expect(result.current).toBeUndefined();
  });

  it("leaves the baseline intact when a sample fails", async () => {
    const { result } = renderHook(() => useExternalChangeTick("/root", ["/root/a.txt"], true));
    await flush();
    expect(fingerprint).toHaveBeenCalledTimes(1);

    fingerprint.mockRejectedValueOnce(new Error("rate limited"));
    await pollOnce();
    expect(result.current).toBeUndefined();

    // The next good sample compares against the original baseline, so a change
    // that landed during the failed poll is still reported.
    fingerprint.mockResolvedValue(["fp-2"]);
    await pollOnce();
    expect(result.current).toBeDefined();
  });
});
