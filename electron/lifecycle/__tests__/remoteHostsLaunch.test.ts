import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRemoteHostsLaunch,
  hostsStillSetUp,
  type RemoteHostsRuntime,
} from "../remoteHostsLaunch.js";
import { restoreWindowFleet, type CreateWindowResult } from "../windowRestore.js";
import type { OpenWindowRecord } from "../../services/persistence/windowManifest.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Releases whatever a test left pending, so a failed assertion strands no restore. */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function launchHarness(options: { dial?: (hostId: string) => void } = {}) {
  let quitting = false;
  const runtime = {
    start: vi.fn(async (_halted: () => boolean) => {}),
    stop: vi.fn(async () => {}),
  };
  const deps = {
    isShuttingDown: () => quitting,
    load: vi.fn(async (): Promise<RemoteHostsRuntime> => runtime),
    onStarted: vi.fn(),
    dial: vi.fn(options.dial ?? (() => {})),
    onError: vi.fn(),
  };
  const launch = createRemoteHostsLaunch(deps);
  return {
    launch,
    deps,
    runtime,
    /** A quit commits; the shutdown chain hasn't reached its stop step yet. */
    commitQuit: () => {
      quitting = true;
    },
    isQuitting: () => quitting,
  };
}

type Harness = ReturnType<typeof launchHarness>;

const onStudio = (project: string): OpenWindowRecord => ({
  projectId: `studio-01:${project.repeat(64)}`,
});
const local = (projectId: string): OpenWindowRecord => ({ projectId });

/** The startup restore as main.ts runs it, with one local window that hangs until released. */
function startupRestore(records: OpenWindowRecord[], h: Harness, slowProjectId: string) {
  const slow = deferred<CreateWindowResult>();
  let slowSettled = false;
  const createWindow = vi.fn(async (projectId: string | undefined) => {
    if (projectId !== slowProjectId) return "ok" as const;
    const result = await slow.promise;
    slowSettled = true;
    return result;
  });
  const finished = restoreWindowFleet({
    records,
    hadManifest: true,
    fallbackProjectId: undefined,
    createWindow,
    suppressSaves: vi.fn(),
    resumeSaves: vi.fn(),
    onBackgroundWindowFailed: vi.fn(),
    isShuttingDown: h.isQuitting,
    onRemoteHostsNeeded: (hostIds) => h.launch.need(hostIds),
  }).then(() => h.launch.start());
  cleanups.push(() => {
    slow.resolve("ok");
    return finished;
  });
  return {
    createWindow,
    finished,
    releaseSlow: () => slow.resolve("ok"),
    slowSettled: () => slowSettled,
  };
}

describe("remote hosts launch with the startup restore", () => {
  it("dials a restored remote window's host before a slow local window finishes restoring", async () => {
    const h = launchHarness();
    const run = startupRestore([onStudio("a"), local("slow"), local("after")], h, "slow");

    await vi.waitFor(() => expect(h.deps.dial).toHaveBeenCalledWith("studio-01"));
    expect(run.createWindow.mock.calls.map((c) => c[0])).toContain("slow");
    expect(run.slowSettled()).toBe(false);
    expect(h.deps.onStarted).toHaveBeenCalledTimes(1);

    run.releaseSlow();
    await run.finished;
    // The late start after the restore is the same attempt, not a second one.
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    expect(h.deps.dial).toHaveBeenCalledTimes(1);
  });

  it("dials the host of a remote window queued behind a slow local one", async () => {
    const h = launchHarness();
    const run = startupRestore([local("a"), local("slow"), onStudio("b")], h, "slow");

    await vi.waitFor(() => expect(h.deps.dial).toHaveBeenCalledWith("studio-01"));
    expect(run.slowSettled()).toBe(false);
    // Its window isn't even created yet.
    expect(run.createWindow).toHaveBeenCalledTimes(2);

    run.releaseSlow();
    await run.finished;
    expect(run.createWindow).toHaveBeenCalledTimes(3);
  });

  it("starts after the restore, not before, when it needs no host", async () => {
    const h = launchHarness();
    const run = startupRestore([local("a"), local("slow")], h, "slow");

    await vi.waitFor(() => expect(run.createWindow).toHaveBeenCalledTimes(2));
    expect(h.deps.load).not.toHaveBeenCalled();

    run.releaseSlow();
    await run.finished;
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    expect(h.deps.onStarted).toHaveBeenCalledTimes(1);
    expect(h.deps.dial).not.toHaveBeenCalled();
  });

  it("leaves Remote Hosts unstarted when a quit lands during the restore", async () => {
    const h = launchHarness();
    const run = startupRestore([local("a"), local("slow"), local("never")], h, "slow");

    await vi.waitFor(() => expect(run.createWindow).toHaveBeenCalledTimes(2));
    // The quit's stop step hasn't run: the restore ends and the late start runs first.
    h.commitQuit();
    run.releaseSlow();
    await run.finished;

    expect(run.createWindow).toHaveBeenCalledTimes(2);
    expect(h.deps.load).not.toHaveBeenCalled();
    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });

  it("leaves Remote Hosts unstarted when a quit lands while its early start is loading", async () => {
    const loading = deferred<RemoteHostsRuntime>();
    const h = launchHarness();
    h.deps.load.mockImplementationOnce(() => loading.promise);
    cleanups.push(async () => loading.resolve(h.runtime));
    const run = startupRestore([onStudio("a"), local("slow")], h, "slow");

    await vi.waitFor(() => expect(h.deps.load).toHaveBeenCalledTimes(1));
    h.commitQuit();
    loading.resolve(h.runtime);
    run.releaseSlow();
    await run.finished;

    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });
});

describe("createRemoteHostsLaunch", () => {
  it("tells a start in flight once a quit has begun, and does nothing after it", async () => {
    const starting = deferred<void>();
    const h = launchHarness();
    h.runtime.start.mockImplementationOnce(() => starting.promise);
    cleanups.push(async () => starting.resolve());
    h.launch.need(["studio-01"]);
    await vi.waitFor(() => expect(h.runtime.start).toHaveBeenCalledTimes(1));
    const [halted] = h.runtime.start.mock.calls[0];
    expect(halted()).toBe(false);

    h.commitQuit();
    expect(halted()).toBe(true);
    starting.resolve();
    await h.launch.start();
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();

    // The quit's stop step, when it comes, stops what the start got as far as.
    await h.launch.stop();
    expect(h.runtime.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a start the quit's stop caught midway", async () => {
    const starting = deferred<void>();
    const h = launchHarness();
    h.runtime.start.mockImplementationOnce(() => starting.promise);
    cleanups.push(async () => starting.resolve());
    h.launch.need(["studio-01"]);
    await vi.waitFor(() => expect(h.runtime.start).toHaveBeenCalledTimes(1));
    const [halted] = h.runtime.start.mock.calls[0];

    await h.launch.stop();
    expect(h.runtime.stop).toHaveBeenCalledTimes(1);
    expect(halted()).toBe(true);
    starting.resolve();
    await h.launch.start();
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });

  it("never loads once stopped", async () => {
    const h = launchHarness();
    await h.launch.stop();
    h.launch.need(["studio-01"]);
    await h.launch.start();
    expect(h.deps.load).not.toHaveBeenCalled();
  });

  it("dials nothing new once stopped or quitting", async () => {
    const h = launchHarness();
    h.launch.need(["studio-01"]);
    await h.launch.start();
    expect(h.deps.dial).toHaveBeenCalledTimes(1);

    h.commitQuit();
    h.launch.need(["studio-02"]);
    await h.launch.stop();
    h.launch.need(["studio-03"]);
    await h.launch.start();
    expect(h.deps.dial).toHaveBeenCalledTimes(1);
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("does nothing for an empty list of hosts", async () => {
    const h = launchHarness();
    h.launch.need([]);
    await Promise.resolve();
    expect(h.deps.load).not.toHaveBeenCalled();
  });

  it("dials each needed host once, including ones named after the start", async () => {
    const h = launchHarness();
    h.launch.need(["studio-01", "studio-02"]);
    await h.launch.start();
    expect(h.deps.dial.mock.calls).toEqual([["studio-01"], ["studio-02"]]);

    h.launch.need(["studio-02", "studio-03"]);
    expect(h.deps.dial.mock.calls).toEqual([["studio-01"], ["studio-02"], ["studio-03"]]);
    expect(h.deps.load).toHaveBeenCalledTimes(1);
  });

  it("dials each host named while loading once, after the start", async () => {
    const loading = deferred<RemoteHostsRuntime>();
    const h = launchHarness();
    h.deps.load.mockImplementationOnce(() => loading.promise);
    cleanups.push(async () => loading.resolve(h.runtime));
    h.launch.need(["studio-01", "studio-01"]);
    h.launch.need(["studio-01", "studio-02"]);
    expect(h.deps.dial).not.toHaveBeenCalled();

    loading.resolve(h.runtime);
    await h.launch.start();
    expect(h.deps.dial.mock.calls).toEqual([["studio-01"], ["studio-02"]]);
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("dials the other hosts when one dial throws, at the start or after it", async () => {
    const h = launchHarness({
      dial: (hostId) => {
        if (hostId.startsWith("gone")) throw new Error("Unknown host");
      },
    });
    h.launch.need(["gone-1", "studio-01"]);
    await h.launch.start();
    expect(h.deps.dial).toHaveBeenCalledWith("studio-01");
    expect(h.deps.onStarted).toHaveBeenCalledTimes(1);

    expect(() => h.launch.need(["gone-2", "studio-02"])).not.toThrow();
    expect(h.deps.dial).toHaveBeenCalledWith("studio-02");
    expect(h.deps.onError).toHaveBeenCalledTimes(2);
  });

  it("reports a failed start without rejecting, and never tries again", async () => {
    const h = launchHarness();
    const failure = new Error("boot failed");
    h.runtime.start.mockRejectedValueOnce(failure);
    h.launch.need(["studio-01"]);
    await expect(h.launch.start()).resolves.toBeUndefined();

    h.launch.need(["studio-02"]);
    await h.launch.start();
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.runtime.start).toHaveBeenCalledTimes(1);
    expect(h.deps.onError).toHaveBeenCalledTimes(1);
    expect(h.deps.onError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });
});

describe("hostsStillSetUp", () => {
  it("keeps only the hosts still set up here", () => {
    const hosts = [{ id: "studio-01" }, { id: "studio-02" }];
    expect(hostsStillSetUp(["studio-02", "removed", "studio-01"], hosts)).toEqual([
      "studio-02",
      "studio-01",
    ]);
  });

  it("keeps none when every named host was removed, or none are set up", () => {
    expect(hostsStillSetUp(["removed"], [{ id: "studio-01" }])).toEqual([]);
    expect(hostsStillSetUp(["studio-01"], [])).toEqual([]);
    expect(hostsStillSetUp(["studio-01"], undefined)).toEqual([]);
  });
});
