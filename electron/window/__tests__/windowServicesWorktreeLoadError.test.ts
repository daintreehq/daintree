import { describe, expect, it, vi } from "vitest";
import {
  attachStartupWorktreePort,
  describeStartupPortFailure,
  selectStatusTarget,
  sendStartupWorktreeLoadFailure,
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
  isLoadingMainFrame(): boolean;
  once(event: "did-finish-load", listener: () => void): unknown;
  send(channel: string, payload: unknown): void;
  destroyed: boolean;
  sent: { channel: string; payload: unknown }[];
  pendingDidFinishLoad: (() => void)[];
};

function makeWebContents(opts: {
  loadingMainFrame: boolean;
  destroyed?: boolean;
  onSend?: () => void;
}): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: opts.destroyed ?? false,
    sent: [],
    pendingDidFinishLoad: [],
    isDestroyed: () => wc.destroyed,
    isLoadingMainFrame: () => opts.loadingMainFrame,
    once: (_event, listener) => {
      wc.pendingDidFinishLoad.push(listener);
      return wc;
    },
    send: (channel, payload) => {
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
    // `isLoading()` would be true here, but `did-finish-load` only fires for
    // the main frame — deferring on it would park the send forever (#11818).
    const wc = makeWebContents({ loadingMainFrame: false });
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

  it("does not throw when the target webContents is missing", () => {
    expect(() =>
      sendStartupWorktreeLoadFailure(null, "proj-a", new Error("folder is gone"))
    ).not.toThrow();
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
