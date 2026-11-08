import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectIoGate, isProjectIoError } from "../projectIoGate.js";

vi.mock("../../utils/logger.js", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

interface Pending {
  path: string;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

function controlledRequests() {
  const pending: Pending[] = [];
  const issue = (path: string) =>
    new Promise<unknown>((resolve, reject) => pending.push({ path, resolve, reject }));
  const request = vi.fn((path: string) => issue(path));
  const settle = (path: string, value: unknown = "ok") => {
    const index = pending.findIndex((entry) => entry.path === path);
    if (index === -1) throw new Error(`no pending request for ${path}`);
    const [entry] = pending.splice(index, 1);
    entry!.resolve(value);
  };
  const fail = (path: string, error: unknown) => {
    const index = pending.findIndex((entry) => entry.path === path);
    if (index === -1) throw new Error(`no pending request for ${path}`);
    const [entry] = pending.splice(index, 1);
    entry!.reject(error);
  };
  const issued = () => pending.map((entry) => entry.path);
  return { request, settle, fail, issued };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isProjectIoError(error) ? error.code : (error as NodeJS.ErrnoException).code;
  }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("ProjectIoGate", () => {
  let clock: number;
  let control: ReturnType<typeof controlledRequests>;
  let gate: ProjectIoGate;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clock = 0;
    control = controlledRequests();
    gate = new ProjectIoGate({
      now: () => clock,
      limits: { defaultTimeoutMs: 1_000 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function advance(ms: number): void {
    clock += ms;
    vi.advanceTimersByTime(ms);
  }

  it("runs one request per root at a time, in order", async () => {
    const first = gate.run("/p", () => control.request("/p/a"));
    const second = gate.run("/p", () => control.request("/p/b"));
    expect(control.issued()).toEqual(["/p/a"]);

    control.settle("/p/a", "A");
    await expect(first).resolves.toBe("A");
    expect(control.issued()).toEqual(["/p/b"]);

    control.settle("/p/b", "B");
    await expect(second).resolves.toBe("B");
  });

  it("never holds more than the global allowance across roots", () => {
    void gate.run("/one", () => control.request("/one/x"));
    void gate.run("/two", () => control.request("/two/x"));
    void gate.run("/three", () => control.request("/three/x"));
    expect(control.issued()).toEqual(["/one/x", "/two/x"]);
  });

  it("passes the request's own errors through untouched", async () => {
    const read = gate.run("/p", () => control.request("/p/missing"));
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    control.fail("/p/missing", enoent);
    await expect(read).rejects.toBe(enoent);
  });

  it("times out a queued request without ever issuing it", async () => {
    void gate.run("/p", () => control.request("/p/slow"), { timeoutMs: 5_000 });
    const queued = gate.run("/p", () => control.request("/p/queued"), { timeoutMs: 100 });

    advance(100);
    expect(await codeOf(queued)).toBe("PROJECT_IO_TIMEOUT");
    expect(gate.isStalled("/p")).toBe(false);

    control.settle("/p/slow");
    await flush();
    expect(control.request).not.toHaveBeenCalledWith("/p/queued");
  });

  it("stalls only the root whose request outlived its deadline", async () => {
    const stuck = gate.run("/cloud", () => control.request("/cloud/placeholder"));
    const behind = gate.run("/cloud", () => control.request("/cloud/next"));
    const healthy = gate.run("/local", () => control.request("/local/file"), { timeoutMs: 5_000 });

    advance(1_000);
    expect(await codeOf(stuck)).toBe("PROJECT_IO_STALLED");
    expect(await codeOf(behind)).toBe("PROJECT_IO_STALLED");
    expect(gate.isStalled("/cloud")).toBe(true);

    // Later reads of the stalled root fail without touching the filesystem.
    expect(await codeOf(gate.run("/cloud", () => control.request("/cloud/other")))).toBe(
      "PROJECT_IO_STALLED"
    );
    expect(control.issued()).toEqual(["/cloud/placeholder", "/local/file"]);

    control.settle("/local/file", "fine");
    await expect(healthy).resolves.toBe("fine");
  });

  it("keeps a timed-out request's slot until the kernel returns, then recovers the root", async () => {
    void gate.run("/cloud", () => control.request("/cloud/placeholder")).catch(() => {});
    advance(1_000);
    await flush();

    // The stuck request still counts against the global allowance.
    void gate.run("/a", () => control.request("/a/x"));
    void gate.run("/b", () => control.request("/b/x"));
    expect(control.issued()).toEqual(["/cloud/placeholder", "/a/x"]);

    control.settle("/cloud/placeholder");
    await flush();
    expect(gate.isStalled("/cloud")).toBe(false);
    expect(control.issued()).toEqual(["/a/x", "/b/x"]);
    control.settle("/a/x");
    control.settle("/b/x");
    await flush();

    const again = gate.run("/cloud", () => control.request("/cloud/placeholder"));
    expect(control.issued()).toContain("/cloud/placeholder");
    control.settle("/cloud/placeholder", "downloaded");
    await expect(again).resolves.toBe("downloaded");
  });

  it("refuses at once when every slot is held by a stalled request", async () => {
    void gate.run("/one", () => control.request("/one/x")).catch(() => {});
    void gate.run("/two", () => control.request("/two/x")).catch(() => {});
    const waiting = gate.run("/three", () => control.request("/three/x"));

    advance(1_000);
    expect(await codeOf(waiting)).toBe("PROJECT_IO_BUSY");
    expect(await codeOf(gate.run("/four", () => control.request("/four/x")))).toBe(
      "PROJECT_IO_BUSY"
    );
    expect(control.issued()).toEqual(["/one/x", "/two/x"]);

    control.settle("/one/x");
    await flush();
    const resumed = gate.run("/four", () => control.request("/four/x"));
    control.settle("/four/x", "back");
    await expect(resumed).resolves.toBe("back");
  });

  it("takes the earlier of a timeout and an absolute deadline", async () => {
    void gate.run("/p", () => control.request("/p/first"), { timeoutMs: 5_000 });
    const queued = gate.run("/p", () => control.request("/p/second"), {
      timeoutMs: 5_000,
      deadline: clock + 50,
    });
    advance(50);
    expect(await codeOf(queued)).toBe("PROJECT_IO_TIMEOUT");
    expect(
      await codeOf(gate.run("/p", () => control.request("/p/late"), { deadline: clock }))
    ).toBe("PROJECT_IO_TIMEOUT");
  });

  it("caps how many requests one root may queue", async () => {
    const small = new ProjectIoGate({
      now: () => clock,
      limits: { maxQueuedPerRoot: 2 },
    });
    void small.run("/p", () => control.request("/p/1"));
    void small.run("/p", () => control.request("/p/2")).catch(() => {});
    void small.run("/p", () => control.request("/p/3")).catch(() => {});
    expect(await codeOf(small.run("/p", () => control.request("/p/4")))).toBe("PROJECT_IO_BUSY");
  });

  it("normalises the root so equivalent spellings share one lane", () => {
    void gate.run("/p/", () => control.request("/p/a"));
    void gate.run("/p/./", () => control.request("/p/b"));
    expect(control.issued()).toEqual(["/p/a"]);
  });

  it("rejects a request that throws synchronously and frees its slot", async () => {
    const thrown = new Error("bad argument");
    await expect(
      gate.run("/p", () => {
        throw thrown;
      })
    ).rejects.toBe(thrown);
    const next = gate.run("/p", () => control.request("/p/after"));
    control.settle("/p/after", "ok");
    await expect(next).resolves.toBe("ok");
  });

  it("leaves no timers armed once requests settle", async () => {
    const read = gate.run("/p", () => control.request("/p/a"));
    control.settle("/p/a");
    await read;
    expect(vi.getTimerCount()).toBe(0);
  });
});
