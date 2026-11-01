import { describe, expect, it, vi } from "vitest";
import {
  createRemoteHostsLaunch,
  type RemoteHostsLaunchDeps,
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

function launchHarness(overrides: Partial<RemoteHostsLaunchDeps> = {}) {
  let quitting = false;
  const runtime = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const deps = {
    isShuttingDown: () => quitting,
    load: vi.fn(async (): Promise<RemoteHostsRuntime> => runtime),
    onStarted: vi.fn(),
    dial: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
  const launch = createRemoteHostsLaunch(deps);
  return {
    launch,
    deps,
    runtime,
    // A committed quit, then its stop step, as the shutdown chain runs them.
    quit: () => {
      quitting = true;
      return launch.stop();
    },
    isQuitting: () => quitting,
  };
}

const onStudio = (project: string): OpenWindowRecord => ({
  projectId: `studio-01:${project.repeat(64)}`,
});
const local = (projectId: string): OpenWindowRecord => ({ projectId });

/** The startup restore as main.ts runs it, with one local window that hangs until released. */
function startupRestore(
  records: OpenWindowRecord[],
  launch: ReturnType<typeof launchHarness>,
  slowProjectId: string
) {
  const slow = deferred<CreateWindowResult>();
  let slowSettled = false;
  const createWindow = vi.fn(async (projectId: string | undefined) => {
    if (projectId !== slowProjectId) return "ok" as const;
    const result = await slow.promise;
    slowSettled = true;
    return result;
  });
  const restore = restoreWindowFleet({
    records,
    hadManifest: true,
    fallbackProjectId: undefined,
    createWindow,
    suppressSaves: vi.fn(),
    resumeSaves: vi.fn(),
    onBackgroundWindowFailed: vi.fn(),
    isShuttingDown: launch.isQuitting,
    onRemoteHostsNeeded: (hostIds) => launch.launch.need(hostIds),
  });
  return {
    createWindow,
    finished: restore.then(() => launch.launch.start()),
    releaseSlow: (result: CreateWindowResult = "ok") => slow.resolve(result),
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

  it("starts nothing early for a restore that needs no host", async () => {
    const h = launchHarness();
    const run = startupRestore([local("a"), local("slow")], h, "slow");

    await vi.waitFor(() => expect(run.createWindow).toHaveBeenCalledTimes(2));
    expect(h.deps.load).not.toHaveBeenCalled();

    run.releaseSlow();
    await run.finished;
    expect(h.deps.load).toHaveBeenCalledTimes(1);
    expect(h.deps.dial).not.toHaveBeenCalled();
  });

  it("leaves Remote Hosts unstarted when a quit lands during the restore", async () => {
    const h = launchHarness();
    const run = startupRestore([local("a"), local("slow"), local("never")], h, "slow");

    await vi.waitFor(() => expect(run.createWindow).toHaveBeenCalledTimes(2));
    await h.quit();
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
    const run = startupRestore([onStudio("a"), local("slow")], h, "slow");

    await vi.waitFor(() => expect(h.deps.load).toHaveBeenCalledTimes(1));
    await h.quit();
    loading.resolve(h.runtime);
    run.releaseSlow();
    await run.finished;

    expect(h.runtime.start).not.toHaveBeenCalled();
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });
});

describe("createRemoteHostsLaunch", () => {
  it("stops a start the quit caught midway, and does nothing after it", async () => {
    const starting = deferred<void>();
    const h = launchHarness();
    h.runtime.start.mockImplementationOnce(() => starting.promise);
    h.launch.need(["studio-01"]);
    await vi.waitFor(() => expect(h.runtime.start).toHaveBeenCalledTimes(1));

    await h.quit();
    expect(h.runtime.stop).toHaveBeenCalledTimes(1);
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

  it("dials the other hosts when one dial throws", async () => {
    const h = launchHarness({
      dial: vi.fn((hostId: string) => {
        if (hostId === "gone") throw new Error("Unknown host");
      }),
    });
    h.launch.need(["gone", "studio-01"]);
    await h.launch.start();
    expect(h.deps.dial).toHaveBeenCalledWith("studio-01");
    expect(h.deps.onError).toHaveBeenCalledTimes(1);
    expect(h.deps.onStarted).toHaveBeenCalledTimes(1);
  });

  it("reports a failed start without rejecting, and does nothing after it", async () => {
    const h = launchHarness();
    const failure = new Error("boot failed");
    h.runtime.start.mockRejectedValueOnce(failure);
    h.launch.need(["studio-01"]);
    await expect(h.launch.start()).resolves.toBeUndefined();
    expect(h.deps.onError).toHaveBeenCalledWith(expect.any(String), failure);
    expect(h.deps.onStarted).not.toHaveBeenCalled();
    expect(h.deps.dial).not.toHaveBeenCalled();
  });
});
