import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isFleetRestoreEligible,
  requestCrashFleetRestore,
  resetCrashFleetRestoreForTests,
  restoreFleetAfterCrash,
  setCrashFleetRestorer,
  type CrashFleetRestoreDeps,
} from "../crashWindowRestore.js";
import type { CreateWindowResult } from "../windowRestore.js";
import type { OpenWindowRecord } from "../../services/persistence/windowManifest.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(overrides: Partial<CrashFleetRestoreDeps> = {}) {
  const events: string[] = [];
  const createWindow = vi.fn(
    async (
      projectId: string | undefined,
      _opts?: Parameters<CrashFleetRestoreDeps["createWindow"]>[1]
    ): Promise<CreateWindowResult> => {
      events.push(`create:${projectId}`);
      return "ok";
    }
  );
  const deps: CrashFleetRestoreDeps = {
    startupRestore: Promise.resolve(),
    waitForRequesterHydrated: vi.fn(async () => {}),
    readManifest: vi.fn(() => ({
      hadManifest: true,
      records: [{ projectId: "a" }, { projectId: "b" }] as OpenWindowRecord[],
    })),
    restoreLiveProjects: true,
    createWindow,
    suppressSaves: vi.fn(() => events.push("suppress")),
    resumeSaves: vi.fn((persist: boolean) => events.push(`resume:${persist}`)),
    enableSaves: vi.fn(() => events.push("enable")),
    onBackgroundWindowFailed: vi.fn(),
    isProjectOwned: () => false,
    isShuttingDown: () => false,
    ...overrides,
  };
  return { deps, events, createWindow };
}

describe("isFleetRestoreEligible", () => {
  it.each([
    [false, 0, true],
    [false, 1, true],
    [false, 2, false],
    [false, 5, false],
    [true, 0, false],
  ])("safeMode=%s count=%i → %s", (safeMode, count, expected) => {
    expect(isFleetRestoreEligible({ isSafeMode: () => safeMode, getCrashCount: () => count })).toBe(
      expected
    );
  });
});

describe("restoreFleetAfterCrash", () => {
  it("brings back the four windows missing beside the recovery window", async () => {
    const { deps, createWindow } = harness({
      readManifest: () => ({
        hadManifest: true,
        records: ["a", "b", "recovered", "d", "e"].map((projectId) => ({ projectId })),
      }),
      isProjectOwned: (id) => id === "recovered",
    });

    await restoreFleetAfterCrash(deps);

    expect(createWindow.mock.calls.map((c) => c[0])).toEqual(["a", "b", "d", "e"]);
    for (const call of createWindow.mock.calls) {
      expect(call[1]).toMatchObject({ revealMode: "showInactive" });
    }
  });

  it("lifts the read-only hold only after a clean restore, then persists", async () => {
    const { deps, events } = harness();

    await restoreFleetAfterCrash(deps);

    expect(events).toEqual(["suppress", "create:a", "create:b", "enable", "resume:true"]);
  });

  it("stays read-only when a window fails to come back", async () => {
    const { deps, events } = harness({
      createWindow: vi.fn(async (projectId: string | undefined) =>
        projectId === "a" ? ("not-registered" as const) : ("ok" as const)
      ),
    });

    await restoreFleetAfterCrash(deps);

    expect(deps.enableSaves).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("resume:false");
  });

  it("stays read-only when a shutdown starts during the restore", async () => {
    let shuttingDown = false;
    const { deps } = harness({
      createWindow: vi.fn(async () => {
        shuttingDown = true;
        return "ok" as const;
      }),
      readManifest: () => ({ hadManifest: true, records: [{ projectId: "a" }] }),
      isShuttingDown: () => shuttingDown,
    });

    await restoreFleetAfterCrash(deps);

    expect(deps.enableSaves).not.toHaveBeenCalled();
    expect(deps.resumeSaves).toHaveBeenCalledWith(false);
  });

  it("waits for the startup restore and the recovery window's hydration first", async () => {
    const startup = deferred();
    const hydrated = deferred();
    const { deps, createWindow } = harness({
      startupRestore: startup.promise,
      waitForRequesterHydrated: () => hydrated.promise,
    });

    const run = restoreFleetAfterCrash(deps);
    await Promise.resolve();
    expect(deps.readManifest).not.toHaveBeenCalled();

    startup.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(createWindow).not.toHaveBeenCalled();

    hydrated.resolve();
    await run;
    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("still runs when the startup restore rejected", async () => {
    const { deps, createWindow } = harness({ startupRestore: Promise.reject(new Error("boom")) });

    await restoreFleetAfterCrash(deps);

    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it("does nothing when a shutdown began before it started", async () => {
    const { deps, createWindow } = harness({ isShuttingDown: () => true });

    await restoreFleetAfterCrash(deps);

    expect(deps.readManifest).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
    expect(deps.enableSaves).not.toHaveBeenCalled();
  });

  it("does nothing and stays read-only without a stored manifest", async () => {
    const { deps, createWindow } = harness({
      readManifest: () => ({ hadManifest: false, records: [] }),
    });

    await restoreFleetAfterCrash(deps);

    expect(createWindow).not.toHaveBeenCalled();
    expect(deps.suppressSaves).not.toHaveBeenCalled();
    expect(deps.enableSaves).not.toHaveBeenCalled();
  });

  it("skips picker windows", async () => {
    const { deps, createWindow } = harness({
      readManifest: () => ({
        hadManifest: true,
        records: [{ projectId: null }, { projectId: "b" }],
      }),
    });

    await restoreFleetAfterCrash(deps);

    expect(createWindow.mock.calls.map((c) => c[0])).toEqual(["b"]);
  });

  it("hands background projects over only when session restore is on", async () => {
    const records: OpenWindowRecord[] = [{ projectId: "a", backgroundProjectIds: ["x"] }];

    const on = harness({ readManifest: () => ({ hadManifest: true, records }) });
    await restoreFleetAfterCrash(on.deps);
    expect(on.createWindow.mock.calls[0][1]).toMatchObject({ backgroundProjectIds: ["x"] });

    const off = harness({
      readManifest: () => ({ hadManifest: true, records }),
      restoreLiveProjects: false,
    });
    await restoreFleetAfterCrash(off.deps);
    expect(off.createWindow.mock.calls[0][1]?.backgroundProjectIds).toBeUndefined();
  });
});

describe("requestCrashFleetRestore", () => {
  beforeEach(() => {
    resetCrashFleetRestoreForTests();
  });

  it("does nothing when no restorer is installed", () => {
    expect(() => requestCrashFleetRestore(1)).not.toThrow();
  });

  it("runs the restorer once per process, with the requesting view", async () => {
    const restorer = vi.fn(async () => {});
    setCrashFleetRestorer(restorer);

    requestCrashFleetRestore(7);
    requestCrashFleetRestore(8);
    await new Promise((r) => setTimeout(r, 0));

    expect(restorer).toHaveBeenCalledTimes(1);
    expect(restorer).toHaveBeenCalledWith(7);
  });

  it("returns before the restore runs and contains its failures", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const restorer = vi.fn(async () => {
      throw new Error("window failed");
    });
    setCrashFleetRestorer(restorer);

    requestCrashFleetRestore(1);
    expect(restorer).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));

    expect(restorer).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("contains a restorer that throws synchronously", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setCrashFleetRestorer(() => {
      throw new Error("sync");
    });

    requestCrashFleetRestore(1);
    await new Promise((r) => setTimeout(r, 0));

    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
