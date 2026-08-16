import { describe, expect, it, vi } from "vitest";
import {
  attachStartupWorktreePort,
  describeStartupPortFailure,
  runStartupWorktreeLoad,
  selectStatusTarget,
  sendStartupWorktreeLoadFailure,
  STARTUP_NO_WORKSPACE_CLIENT_MESSAGE,
} from "../startupWorktreeLoad.js";

/**
 * Tests the startup worktree-load reporting used by windowServices.ts
 * (#8796, #11818).
 *
 * These exercise the production helpers directly — the module is structurally
 * typed and Electron-free precisely so the boot decision logic can be tested
 * without importing setupWindowServices (side effects, Electron deps).
 *
 * The interesting branches: IPC timing (a `project:worktree-load-status` sent
 * before the renderer wires its ipcRenderer listener is silently dropped, so
 * the send defers to `did-finish-load` while the *main frame* loads), and the
 * port-attach outcomes that leave the renderer with no worktree port at all.
 */

const PROJECT_WORKTREE_LOAD_STATUS = "project:worktree-load-status";

type FakeWebContents = {
  isDestroyed(): boolean;
  /** Present so a subframe-only load is distinguishable from a settled one. */
  isLoading(): boolean;
  isLoadingMainFrame(): boolean;
  once(event: "did-finish-load", listener: () => void): unknown;
  send(channel: string, payload: unknown): void;
  destroyed: boolean;
  sent: { channel: string; payload: unknown }[];
  sendAttempts: number;
  pendingDidFinishLoad: (() => void)[];
};

function makeWebContents(opts: {
  loadingMainFrame: boolean;
  /** Defaults to the main-frame value; set true alone to model a subframe. */
  loading?: boolean;
  destroyed?: boolean;
  onSend?: () => void;
}): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: opts.destroyed ?? false,
    sent: [],
    sendAttempts: 0,
    pendingDidFinishLoad: [],
    isDestroyed: () => wc.destroyed,
    isLoading: () => opts.loading ?? opts.loadingMainFrame,
    isLoadingMainFrame: () => opts.loadingMainFrame,
    once: (_event, listener) => {
      wc.pendingDidFinishLoad.push(listener);
      return wc;
    },
    send: (channel, payload) => {
      wc.sendAttempts += 1;
      opts.onSend?.();
      wc.sent.push({ channel, payload });
    },
  };
  return wc;
}

describe("startup worktree-load failure reporting (#8796)", () => {
  it("sends the load-status immediately when the main frame has finished loading", () => {
    const wc = makeWebContents({ loadingMainFrame: false });
    expect(sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"))).toBe(true);

    expect(wc.sent).toEqual([
      {
        channel: PROJECT_WORKTREE_LOAD_STATUS,
        payload: { projectId: "proj-a", worktreeLoadError: "folder is gone" },
      },
    ]);
    expect(wc.pendingDidFinishLoad).toHaveLength(0);
  });

  it("defers the load-status until did-finish-load while the main frame is loading", () => {
    const wc = makeWebContents({ loadingMainFrame: true });
    sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"));

    // Nothing sent yet — a message before the renderer wires its
    // ipcRenderer listener would be silently dropped.
    expect(wc.sent).toHaveLength(0);
    expect(wc.pendingDidFinishLoad).toHaveLength(1);

    wc.pendingDidFinishLoad.forEach((cb) => cb());
    expect(wc.sent).toEqual([
      {
        channel: PROJECT_WORKTREE_LOAD_STATUS,
        payload: { projectId: "proj-a", worktreeLoadError: "folder is gone" },
      },
    ]);
  });

  it("sends immediately when only a subframe is loading", () => {
    // `isLoading()` is true here but the main frame has settled, so
    // `did-finish-load` will never fire again — deferring on it would park the
    // send forever (#11818).
    const wc = makeWebContents({ loadingMainFrame: false, loading: true });
    expect(wc.isLoading()).toBe(true);

    sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"));

    expect(wc.pendingDidFinishLoad).toHaveLength(0);
    expect(wc.sent).toHaveLength(1);
  });

  it("sends nothing when no projectId could be resolved", () => {
    const wc = makeWebContents({ loadingMainFrame: false });
    expect(sendStartupWorktreeLoadFailure(wc, undefined, new Error("folder is gone"))).toBe(false);

    expect(wc.sent).toHaveLength(0);
    expect(wc.pendingDidFinishLoad).toHaveLength(0);
  });

  it("does not send when the webContents was destroyed before did-finish-load", () => {
    const wc = makeWebContents({ loadingMainFrame: true });
    sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"));
    expect(wc.pendingDidFinishLoad).toHaveLength(1);

    // Window closed between the throw and did-finish-load.
    wc.destroyed = true;
    wc.pendingDidFinishLoad.forEach((cb) => cb());
    expect(wc.sent).toHaveLength(0);
  });

  it("does not send when the target webContents is already destroyed at call time", () => {
    const wc = makeWebContents({ loadingMainFrame: false, destroyed: true });
    expect(sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"))).toBe(false);

    expect(wc.sent).toHaveLength(0);
  });

  it("reports no send when the target webContents is missing", () => {
    expect(sendStartupWorktreeLoadFailure(null, "proj-a", new Error("folder is gone"))).toBe(false);
  });

  it("swallows a teardown race inside the send itself", () => {
    const wc = makeWebContents({
      loadingMainFrame: false,
      onSend: () => {
        throw new Error("Object has been destroyed");
      },
    });

    // A throw here must not abort the rest of window startup.
    expect(() =>
      sendStartupWorktreeLoadFailure(wc, "proj-a", new Error("folder is gone"))
    ).not.toThrow();
    // The send was genuinely attempted — not skipped by an earlier guard.
    expect(wc.sendAttempts).toBe(1);
  });

  it("falls back to a generic message for a non-Error throw", () => {
    const wc = makeWebContents({ loadingMainFrame: false });
    sendStartupWorktreeLoadFailure(wc, "proj-a", { weird: true });

    expect(wc.sent[0]?.payload).toEqual({
      projectId: "proj-a",
      worktreeLoadError: "Failed to load worktrees",
    });
  });

  describe("status-target selection", () => {
    it("prefers the project view's webContents when it is alive", () => {
      const viewWc = makeWebContents({ loadingMainFrame: false });
      const fallbackWc = makeWebContents({ loadingMainFrame: false });
      expect(selectStatusTarget(viewWc, fallbackWc)).toBe(viewWc);
    });

    it("falls through to the app webContents when the project view is destroyed", () => {
      const viewWc = makeWebContents({ loadingMainFrame: false, destroyed: true });
      const fallbackWc = makeWebContents({ loadingMainFrame: false });
      expect(selectStatusTarget(viewWc, fallbackWc)).toBe(fallbackWc);
    });

    it("uses the app webContents when there is no project view", () => {
      const fallbackWc = makeWebContents({ loadingMainFrame: false });
      expect(selectStatusTarget(null, fallbackWc)).toBe(fallbackWc);
    });

    it("yields no target when both candidates are destroyed", () => {
      const viewWc = makeWebContents({ loadingMainFrame: false, destroyed: true });
      const fallbackWc = makeWebContents({ loadingMainFrame: false, destroyed: true });
      expect(selectStatusTarget(viewWc, fallbackWc)).toBeNull();
    });
  });
});

describe("startup worktree port attach (#11818)", () => {
  const host = { id: "host-1" };
  type HostType = typeof host;

  function attach(overrides: {
    target?: FakeWebContents | null;
    host?: HostType | null;
    brokerPort?: ((host: HostType, target: FakeWebContents) => boolean) | null;
    attachDirectPort?: (target: FakeWebContents) => void;
  }) {
    return attachStartupWorktreePort({
      target:
        overrides.target === undefined
          ? makeWebContents({ loadingMainFrame: false })
          : overrides.target,
      host: overrides.host === undefined ? host : overrides.host,
      attachDirectPort: overrides.attachDirectPort ?? (() => {}),
      brokerPort: overrides.brokerPort === undefined ? () => true : overrides.brokerPort,
    });
  }

  it("reports success once the port is brokered", () => {
    const attachDirectPort = vi.fn();
    const brokerPort = vi.fn(() => true);
    expect(attach({ attachDirectPort, brokerPort })).toEqual({ ok: true });
    expect(attachDirectPort).toHaveBeenCalledOnce();
    expect(brokerPort).toHaveBeenCalledOnce();
  });

  it("fails without attaching when there is no renderer target", () => {
    const attachDirectPort = vi.fn();
    expect(attach({ target: null, attachDirectPort })).toEqual({
      ok: false,
      reason: "no-renderer-target",
    });
    expect(attachDirectPort).not.toHaveBeenCalled();
  });

  it("fails without attaching when the renderer target is destroyed", () => {
    const attachDirectPort = vi.fn();
    const target = makeWebContents({ loadingMainFrame: false, destroyed: true });
    expect(attach({ target, attachDirectPort })).toEqual({
      ok: false,
      reason: "no-renderer-target",
    });
    expect(attachDirectPort).not.toHaveBeenCalled();
  });

  it("fails when the project has no workspace host", () => {
    expect(attach({ host: null })).toEqual({ ok: false, reason: "no-host" });
  });

  it("fails when no broker was constructed", () => {
    expect(attach({ brokerPort: null })).toEqual({ ok: false, reason: "no-broker" });
  });

  it("fails when the broker rejects the target", () => {
    // brokerPort() returns false for a destroyed webContents — a resolved
    // loadProject() is not proof the renderer got a port.
    expect(attach({ brokerPort: () => false })).toEqual({ ok: false, reason: "broker-rejected" });
  });

  it("still attaches the direct port before discovering the host is missing", () => {
    const attachDirectPort = vi.fn();
    attach({ host: null, attachDirectPort });
    expect(attachDirectPort).toHaveBeenCalledOnce();
  });

  it("describes every failure reason with distinct reader-facing text", () => {
    const reasons = ["no-renderer-target", "no-host", "no-broker", "broker-rejected"] as const;
    const messages = reasons.map(describeStartupPortFailure);

    expect(new Set(messages).size).toBe(reasons.length);
    for (const message of messages) {
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe("startup worktree load orchestration (#11818)", () => {
  const host = { id: "host-1" };
  type HostType = typeof host;

  type Scenario = {
    loadProject?: (() => Promise<void>) | null;
    target?: FakeWebContents | null;
    host?: HostType | null;
    brokerPort?: ((host: HostType, target: FakeWebContents) => boolean) | null;
  };

  function run(scenario: Scenario) {
    const report = vi.fn();
    const attachDirectPort = vi.fn();
    const target =
      scenario.target === undefined
        ? makeWebContents({ loadingMainFrame: false })
        : scenario.target;

    const outcome = runStartupWorktreeLoad<HostType, FakeWebContents>({
      loadProject:
        scenario.loadProject === undefined ? () => Promise.resolve() : scenario.loadProject,
      getPortTarget: () => target,
      getHost: () => (scenario.host === undefined ? host : scenario.host),
      attachDirectPort,
      getBrokerPort: () => (scenario.brokerPort === undefined ? () => true : scenario.brokerPort),
      report,
    });

    return { outcome, report, attachDirectPort };
  }

  it("brokers the port and reports nothing on the happy path", async () => {
    const { outcome, report, attachDirectPort } = run({});

    expect(await outcome).toEqual({ status: "loaded" });
    expect(attachDirectPort).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
  });

  // The #11818 regression witness: a boot with no workspace client used to skip
  // the whole block in silence, leaving the sidebar on an endless skeleton.
  it("reports instead of silently skipping when there is no workspace client", async () => {
    const { outcome, report, attachDirectPort } = run({ loadProject: null });

    expect(await outcome).toEqual({ status: "no-client" });
    expect(report).toHaveBeenCalledOnce();
    expect((report.mock.calls[0]![0] as Error).message).toBe(STARTUP_NO_WORKSPACE_CLIENT_MESSAGE);
    // Nothing was loaded, so nothing may be attached either.
    expect(attachDirectPort).not.toHaveBeenCalled();
  });

  it("reports the original error when the load throws", async () => {
    const failure = new Error("folder is gone");
    const { outcome, report } = run({ loadProject: () => Promise.reject(failure) });

    expect(await outcome).toEqual({ status: "load-failed", error: failure });
    expect(report).toHaveBeenCalledWith(failure);
  });

  // A resolved load with no brokered port leaves the renderer in exactly the
  // state a thrown load does, so each of these must report too.
  it.each([
    ["no renderer target", { target: null }, "no-renderer-target"],
    ["no workspace host", { host: null }, "no-host"],
    ["no port broker", { brokerPort: null }, "no-broker"],
    ["a broker that rejects the target", { brokerPort: () => false }, "broker-rejected"],
  ] as const)("reports a load that succeeded but left %s", async (_label, scenario, reason) => {
    const { outcome, report } = run(scenario);

    expect(await outcome).toEqual({ status: "port-failed", reason });
    expect(report).toHaveBeenCalledOnce();
    expect((report.mock.calls[0]![0] as Error).message).toBe(describeStartupPortFailure(reason));
  });

  it("resolves the broker after the load rather than before it", async () => {
    // The broker is constructed during init, which can still be in flight when
    // the load starts — reading it up front would lose it.
    let broker: ((host: HostType, target: FakeWebContents) => boolean) | null = null;
    const report = vi.fn();

    const outcome = await runStartupWorktreeLoad<HostType, FakeWebContents>({
      loadProject: () => {
        broker = () => true;
        return Promise.resolve();
      },
      getPortTarget: () => makeWebContents({ loadingMainFrame: false }),
      getHost: () => host,
      attachDirectPort: () => {},
      getBrokerPort: () => broker,
      report,
    });

    expect(outcome).toEqual({ status: "loaded" });
    expect(report).not.toHaveBeenCalled();
  });
});
