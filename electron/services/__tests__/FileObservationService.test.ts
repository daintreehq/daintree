import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fingerprintPaths = vi.hoisted(() => vi.fn());
const fsWatch = vi.hoisted(() => vi.fn());

vi.mock("../pathFingerprint.js", () => ({ fingerprintPaths }));
vi.mock("fs", () => ({ watch: fsWatch }));

const {
  sampleCoalesced,
  watchShared,
  sharedWatcherCount,
  sharedWatcherListenerCount,
  __resetSampleCacheForTests,
} = await import("../FileObservationService.js");

/** A watcher stub that records its close and exposes its registered handlers. */
function makeWatcherStub() {
  const handlers = new Map<string, (error: unknown) => void>();
  const stub = {
    close: vi.fn(),
    on: vi.fn((event: string, handler: (error: unknown) => void) => {
      handlers.set(event, handler);
      return stub;
    }),
    handlers,
  };
  return stub;
}

/** The change callback `fsWatch` was handed on its Nth construction. */
function emitFor(call: number, event: string, filename: string | null): void {
  const listener = fsWatch.mock.calls[call]?.[2] as (
    event: string,
    filename: string | null
  ) => void;
  listener(event, filename);
}

describe("FileObservationService", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetSampleCacheForTests();
    fingerprintPaths.mockReset();
    fsWatch.mockReset();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  describe("sampleCoalesced", () => {
    it("returns fingerprints in the requested order", async () => {
      fingerprintPaths.mockResolvedValue(["a", null, "c"]);

      const result = await sampleCoalesced("/root", ["/root/x", "/root/y", "/root/z"]);

      expect(result).toEqual(["a", null, "c"]);
      expect(fingerprintPaths).toHaveBeenCalledExactlyOnceWith("/root", [
        "/root/x",
        "/root/y",
        "/root/z",
      ]);
    });

    it("short-circuits an empty path list without touching the filesystem", async () => {
      await expect(sampleCoalesced("/root", [])).resolves.toEqual([]);
      expect(fingerprintPaths).not.toHaveBeenCalled();
    });

    it("folds concurrent identical requests onto a single read", async () => {
      let release: (value: Array<string | null>) => void = () => {};
      fingerprintPaths.mockReturnValue(
        new Promise<Array<string | null>>((resolve) => {
          release = resolve;
        })
      );

      const first = sampleCoalesced("/root", ["/root/a", "/root/b"]);
      const second = sampleCoalesced("/root", ["/root/a", "/root/b"]);
      release(["fp-a", "fp-b"]);

      expect(await first).toEqual(["fp-a", "fp-b"]);
      expect(await second).toEqual(["fp-a", "fp-b"]);
      // The second caller joined the in-flight read rather than starting one.
      expect(fingerprintPaths).toHaveBeenCalledTimes(1);
    });

    it("reads only the paths a concurrent caller did not already cover", async () => {
      let release: (value: Array<string | null>) => void = () => {};
      fingerprintPaths.mockReturnValueOnce(
        new Promise<Array<string | null>>((resolve) => {
          release = resolve;
        })
      );
      fingerprintPaths.mockResolvedValueOnce(["fp-c"]);

      const first = sampleCoalesced("/root", ["/root/a", "/root/b"]);
      const second = sampleCoalesced("/root", ["/root/b", "/root/c"]);
      release(["fp-a", "fp-b"]);

      expect(await first).toEqual(["fp-a", "fp-b"]);
      expect(await second).toEqual(["fp-b", "fp-c"]);
      expect(fingerprintPaths).toHaveBeenCalledTimes(2);
      // Only the genuinely new path was read the second time.
      expect(fingerprintPaths).toHaveBeenLastCalledWith("/root", ["/root/c"]);
    });

    it("deduplicates a path repeated inside one request", async () => {
      fingerprintPaths.mockResolvedValue(["fp-a", "fp-b"]);

      const result = await sampleCoalesced("/root", ["/root/a", "/root/b", "/root/a", "/root/a"]);

      // Every position gets its value, but the filesystem was asked once per
      // distinct path.
      expect(result).toEqual(["fp-a", "fp-b", "fp-a", "fp-a"]);
      expect(fingerprintPaths).toHaveBeenCalledExactlyOnceWith("/root", ["/root/a", "/root/b"]);
    });

    it("re-reads on a later sequential call rather than reusing a settled value", async () => {
      fingerprintPaths.mockResolvedValueOnce(["first"]).mockResolvedValueOnce(["second"]);

      await expect(sampleCoalesced("/root", ["/root/a"])).resolves.toEqual(["first"]);
      // Nothing is cached past completion, so a poller diffing successive
      // samples can never be handed a value read before its request began.
      await expect(sampleCoalesced("/root", ["/root/a"])).resolves.toEqual(["second"]);

      expect(fingerprintPaths).toHaveBeenCalledTimes(2);
    });

    it("keeps separate roots separate even for an identical path", async () => {
      fingerprintPaths.mockResolvedValueOnce(["from-a"]).mockResolvedValueOnce(["from-b"]);

      await expect(sampleCoalesced("/root-a", ["/shared/x"])).resolves.toEqual(["from-a"]);
      await expect(sampleCoalesced("/root-b", ["/shared/x"])).resolves.toEqual(["from-b"]);

      expect(fingerprintPaths).toHaveBeenCalledTimes(2);
    });

    it("propagates an unexpected rejection instead of folding it to null", async () => {
      // `fingerprintPaths` folds every filesystem failure to `null` itself, so a
      // rejection here means something genuinely unexpected — hiding it behind a
      // plausible-looking `null` would conceal the regression.
      fingerprintPaths.mockRejectedValue(new Error("boom"));

      await expect(sampleCoalesced("/root", ["/root/a"])).rejects.toThrow("boom");
    });

    it("rejects a joined caller with the same error as the owner", async () => {
      let reject: (error: Error) => void = () => {};
      fingerprintPaths.mockReturnValue(
        new Promise<Array<string | null>>((_resolve, rejectFn) => {
          reject = rejectFn;
        })
      );

      const owner = sampleCoalesced("/root", ["/root/a"]);
      const joiner = sampleCoalesced("/root", ["/root/a"]);
      reject(new Error("boom"));

      await expect(owner).rejects.toThrow("boom");
      await expect(joiner).rejects.toThrow("boom");
    });

    it("does not poison later reads after a rejection", async () => {
      fingerprintPaths.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(["fp"]);

      await expect(sampleCoalesced("/root", ["/root/a"])).rejects.toThrow("boom");
      // The failed read left no pending entry behind.
      await expect(sampleCoalesced("/root", ["/root/a"])).resolves.toEqual(["fp"]);
    });
  });

  describe("watchShared", () => {
    it("creates one native watcher for many subscribers of the same path", () => {
      fsWatch.mockReturnValue(makeWatcherStub());

      const disposers = [
        watchShared("/root/dir", vi.fn()),
        watchShared("/root/dir", vi.fn()),
        watchShared("/root/dir", vi.fn()),
      ];

      expect(fsWatch).toHaveBeenCalledTimes(1);
      expect(sharedWatcherCount()).toBe(1);
      expect(sharedWatcherListenerCount()).toBe(3);

      disposers.forEach((dispose) => dispose());
    });

    it("fans one filesystem event out to every subscriber", () => {
      fsWatch.mockReturnValue(makeWatcherStub());
      const first = vi.fn();
      const second = vi.fn();
      const disposeOne = watchShared("/root/dir", first);
      const disposeTwo = watchShared("/root/dir", second);

      emitFor(0, "change", "child.txt");

      expect(first).toHaveBeenCalledExactlyOnceWith("/root/dir/child.txt");
      expect(second).toHaveBeenCalledExactlyOnceWith("/root/dir/child.txt");

      disposeOne();
      disposeTwo();
    });

    it("reports the watched path itself when the platform gives no filename", () => {
      fsWatch.mockReturnValue(makeWatcherStub());
      const listener = vi.fn();
      const dispose = watchShared("/root/dir", listener);

      emitFor(0, "rename", null);

      expect(listener).toHaveBeenCalledExactlyOnceWith("/root/dir");
      dispose();
    });

    it("treats two subscriptions sharing one listener function as independent", () => {
      const stub = makeWatcherStub();
      fsWatch.mockReturnValue(stub);
      const listener = vi.fn();

      const disposeOne = watchShared("/root/dir", listener);
      const disposeTwo = watchShared("/root/dir", listener);

      // A Set keyed on the function itself would have collapsed these to one.
      expect(sharedWatcherListenerCount()).toBe(2);
      emitFor(0, "change", "x");
      expect(listener).toHaveBeenCalledTimes(2);

      // And releasing one must not close the watcher the other still wants.
      disposeOne();
      expect(stub.close).not.toHaveBeenCalled();
      listener.mockClear();
      emitFor(0, "change", "y");
      expect(listener).toHaveBeenCalledTimes(1);

      disposeTwo();
      expect(stub.close).toHaveBeenCalledTimes(1);
    });

    it("keeps the watcher open until the last subscriber leaves", () => {
      const stub = makeWatcherStub();
      fsWatch.mockReturnValue(stub);

      const disposeOne = watchShared("/root/dir", vi.fn());
      const disposeTwo = watchShared("/root/dir", vi.fn());

      disposeOne();
      expect(stub.close).not.toHaveBeenCalled();
      expect(sharedWatcherCount()).toBe(1);

      disposeTwo();
      expect(stub.close).toHaveBeenCalledTimes(1);
      expect(sharedWatcherCount()).toBe(0);
    });

    it("ignores a repeated dispose so one subscriber cannot close another's watcher", () => {
      const stub = makeWatcherStub();
      fsWatch.mockReturnValue(stub);

      const disposeOne = watchShared("/root/dir", vi.fn());
      const disposeTwo = watchShared("/root/dir", vi.fn());

      disposeOne();
      disposeOne();

      expect(stub.close).not.toHaveBeenCalled();
      expect(sharedWatcherListenerCount()).toBe(1);

      disposeTwo();
      expect(stub.close).toHaveBeenCalledTimes(1);
    });

    it("keeps notifying the other subscribers when one listener throws", () => {
      fsWatch.mockReturnValue(makeWatcherStub());
      const thrower = vi.fn(() => {
        throw new Error("listener boom");
      });
      const healthy = vi.fn();

      const disposeOne = watchShared("/root/dir", thrower);
      const disposeTwo = watchShared("/root/dir", healthy);

      expect(() => emitFor(0, "change", "x")).not.toThrow();

      expect(healthy).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalled();

      disposeOne();
      disposeTwo();
    });

    it("lets a listener dispose itself while being notified", () => {
      fsWatch.mockReturnValue(makeWatcherStub());
      let dispose: () => void = () => {};
      const selfRemoving = vi.fn(() => dispose());
      const other = vi.fn();

      dispose = watchShared("/root/dir", selfRemoving);
      const disposeOther = watchShared("/root/dir", other);

      expect(() => emitFor(0, "change", "x")).not.toThrow();

      expect(other).toHaveBeenCalledTimes(1);
      disposeOther();
    });

    it("gives different paths their own watchers", () => {
      fsWatch.mockImplementation(() => makeWatcherStub());

      const disposeOne = watchShared("/root/a", vi.fn());
      const disposeTwo = watchShared("/root/b", vi.fn());

      expect(fsWatch).toHaveBeenCalledTimes(2);
      expect(sharedWatcherCount()).toBe(2);

      disposeOne();
      disposeTwo();
      expect(sharedWatcherCount()).toBe(0);
    });

    it("propagates a synchronous watch failure to the caller", () => {
      fsWatch.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      expect(() => watchShared("/root/missing", vi.fn())).toThrow("ENOENT");
      expect(sharedWatcherCount()).toBe(0);
    });

    it("rebinds surviving subscribers onto a fresh watcher when one errors", () => {
      const failing = makeWatcherStub();
      const replacement = makeWatcherStub();
      fsWatch.mockReturnValueOnce(failing).mockReturnValueOnce(replacement);

      const listener = vi.fn();
      const dispose = watchShared("/root/dir", listener);

      failing.handlers.get("error")?.(new Error("watch died"));

      // The dead handle is closed, but the subscriber is moved onto a live one
      // rather than being left silently attached to nothing.
      expect(failing.close).toHaveBeenCalledTimes(1);
      expect(fsWatch).toHaveBeenCalledTimes(2);
      expect(sharedWatcherCount()).toBe(1);
      expect(sharedWatcherListenerCount()).toBe(1);

      emitFor(1, "change", "after.txt");
      expect(listener).toHaveBeenCalledExactlyOnceWith("/root/dir/after.txt");

      // The original disposer still governs the rebound subscription.
      dispose();
      expect(replacement.close).toHaveBeenCalledTimes(1);
      expect(sharedWatcherCount()).toBe(0);
    });

    it("does not rebind a second time when the replacement also fails", () => {
      const failing = makeWatcherStub();
      const replacement = makeWatcherStub();
      fsWatch.mockReturnValueOnce(failing).mockReturnValueOnce(replacement);

      const listener = vi.fn();
      watchShared("/root/dir", listener);

      failing.handlers.get("error")?.(new Error("first death"));
      replacement.handlers.get("error")?.(new Error("second death"));

      // Three would mean it is spinning up replacements for a path that cannot
      // hold a watcher.
      expect(fsWatch).toHaveBeenCalledTimes(2);
      expect(sharedWatcherCount()).toBe(0);
      // The subscriber is told to re-read rather than left silently dead.
      expect(listener).toHaveBeenCalledExactlyOnceWith("/root/dir");
    });

    it("notifies subscribers once when the path can no longer be watched at all", () => {
      const failing = makeWatcherStub();
      fsWatch.mockReturnValueOnce(failing).mockImplementationOnce(() => {
        throw new Error("ENOENT");
      });

      const listener = vi.fn();
      watchShared("/root/dir", listener);

      failing.handlers.get("error")?.(new Error("watch died"));

      // A path that vanished is itself a change, so the subscriber gets one
      // final invalidation instead of silence.
      expect(listener).toHaveBeenCalledExactlyOnceWith("/root/dir");
      expect(sharedWatcherCount()).toBe(0);
    });

    it("does not rebind when the last subscriber already left", () => {
      const stub = makeWatcherStub();
      fsWatch.mockReturnValueOnce(stub);

      const dispose = watchShared("/root/dir", vi.fn());
      dispose();
      expect(sharedWatcherCount()).toBe(0);

      // A late error on an already-released watcher must not resurrect it.
      stub.handlers.get("error")?.(new Error("late death"));
      expect(fsWatch).toHaveBeenCalledTimes(1);
      expect(sharedWatcherCount()).toBe(0);
    });
  });
});
