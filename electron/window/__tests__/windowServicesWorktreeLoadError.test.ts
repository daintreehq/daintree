import { describe, expect, it } from "vitest";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";

/**
 * Tests the startup worktree-load-failure decision logic from
 * windowServices.ts (#8796).
 *
 * setupWindowServices cannot be imported directly (side effects, Electron
 * deps), so we replicate the catch-block decision logic: given a resolved
 * projectId and a target webContents, when — and what — does it send?
 *
 * The interesting branch is IPC timing: a `project:worktree-load-status`
 * sent before the renderer wires its ipcRenderer listener is silently
 * dropped, so the send must defer to `did-finish-load` while loading.
 */

type FakeWebContents = {
  loading: boolean;
  destroyed: boolean;
  sent: { channel: string; payload: unknown }[];
  pendingDidFinishLoad: (() => void)[];
};

const PROJECT_WORKTREE_LOAD_STATUS = "project:worktree-load-status";

function makeWebContents(opts: { loading: boolean; destroyed?: boolean }): FakeWebContents {
  return {
    loading: opts.loading,
    destroyed: opts.destroyed ?? false,
    sent: [],
    pendingDidFinishLoad: [],
  };
}

/**
 * Replicates the status-target selection from windowServices.ts (#8796):
 * prefer the project view's webContents, but fall through to the window's
 * app webContents when it's already destroyed — selecting a destroyed
 * target would silently drop the message.
 */
function selectStatusTarget(
  initialAppViewWc: FakeWebContents | null,
  fallbackWc: FakeWebContents | null
): FakeWebContents | null {
  if (initialAppViewWc && !initialAppViewWc.destroyed) return initialAppViewWc;
  return fallbackWc;
}

/** Replicates the windowServices.ts worktree-load catch block (#8796). */
function simulateStartupWorktreeLoadFailure(
  failedProjectId: string | undefined,
  statusTarget: FakeWebContents | null,
  error: unknown
): void {
  if (!failedProjectId || !statusTarget) return;
  const worktreeLoadError = formatErrorMessage(error, "Failed to load worktrees");
  const sendLoadStatus = (): void => {
    if (statusTarget.destroyed) return;
    statusTarget.sent.push({
      channel: PROJECT_WORKTREE_LOAD_STATUS,
      payload: { projectId: failedProjectId, worktreeLoadError },
    });
  };
  if (statusTarget.loading) {
    statusTarget.pendingDidFinishLoad.push(sendLoadStatus);
  } else {
    sendLoadStatus();
  }
}

describe("windowServices startup worktree-load failure (#8796)", () => {
  it("sends the load-status immediately when the renderer has finished loading", () => {
    const wc = makeWebContents({ loading: false });
    simulateStartupWorktreeLoadFailure("proj-a", wc, new Error("folder is gone"));

    expect(wc.sent).toEqual([
      {
        channel: PROJECT_WORKTREE_LOAD_STATUS,
        payload: { projectId: "proj-a", worktreeLoadError: "folder is gone" },
      },
    ]);
    expect(wc.pendingDidFinishLoad).toHaveLength(0);
  });

  it("defers the load-status until did-finish-load while the renderer is still loading", () => {
    const wc = makeWebContents({ loading: true });
    simulateStartupWorktreeLoadFailure("proj-a", wc, new Error("folder is gone"));

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

  it("sends nothing when no projectId could be resolved (explicit-path window)", () => {
    const wc = makeWebContents({ loading: false });
    simulateStartupWorktreeLoadFailure(undefined, wc, new Error("folder is gone"));

    expect(wc.sent).toHaveLength(0);
    expect(wc.pendingDidFinishLoad).toHaveLength(0);
  });

  it("does not send when the webContents was destroyed before did-finish-load", () => {
    const wc = makeWebContents({ loading: true });
    simulateStartupWorktreeLoadFailure("proj-a", wc, new Error("folder is gone"));
    expect(wc.pendingDidFinishLoad).toHaveLength(1);

    // Window closed between the throw and did-finish-load.
    wc.destroyed = true;
    wc.pendingDidFinishLoad.forEach((cb) => cb());
    expect(wc.sent).toHaveLength(0);
  });

  it("does not send when the target webContents is already destroyed at call time", () => {
    const wc = makeWebContents({ loading: false, destroyed: true });
    simulateStartupWorktreeLoadFailure("proj-a", wc, new Error("folder is gone"));

    expect(wc.sent).toHaveLength(0);
  });

  it("does not throw when the target webContents is missing", () => {
    expect(() =>
      simulateStartupWorktreeLoadFailure("proj-a", null, new Error("folder is gone"))
    ).not.toThrow();
  });

  describe("status-target selection", () => {
    it("prefers the project view's webContents when it is alive", () => {
      const viewWc = makeWebContents({ loading: false });
      const fallbackWc = makeWebContents({ loading: false });
      expect(selectStatusTarget(viewWc, fallbackWc)).toBe(viewWc);
    });

    it("falls through to the app webContents when the project view is destroyed", () => {
      const viewWc = makeWebContents({ loading: false, destroyed: true });
      const fallbackWc = makeWebContents({ loading: false });
      expect(selectStatusTarget(viewWc, fallbackWc)).toBe(fallbackWc);
    });

    it("uses the app webContents when there is no project view", () => {
      const fallbackWc = makeWebContents({ loading: false });
      expect(selectStatusTarget(null, fallbackWc)).toBe(fallbackWc);
    });
  });
});
