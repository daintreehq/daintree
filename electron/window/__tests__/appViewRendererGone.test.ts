import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("electron", () => ({
  app: { quit: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

const recordRendererGone = vi.fn();
vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => ({ recordRendererGone }),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));

const availableMemory = { mb: null as number | null };
vi.mock("../../utils/systemMemory.js", () => ({
  readAvailableSystemMemoryMb: () => availableMemory.mb,
}));

vi.mock("../../utils/logger.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { notifyError } from "../../ipc/errorHandlers.js";
import { logError, logWarn } from "../../utils/logger.js";
import { attachAppViewRendererGoneHandler } from "../appViewRendererGone.js";
import { isWindowRecreating } from "../../lifecycle/windowRecreationState.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";

type Handler = (event: unknown, details: { reason: string; exitCode: number }) => void;

function createHarness(
  opts: {
    pvm?: Pick<
      ProjectViewManager,
      "getProjectIdForWebContents" | "notifyActiveViewCrashed" | "getLowMemoryFreeThresholdMb"
    > | null;
    onRecreateWindow?: () => Promise<void>;
  } = {}
) {
  const handlers: Handler[] = [];
  const appWebContents = {
    id: 2,
    on: vi.fn((event: string, handler: Handler) => {
      if (event === "render-process-gone") handlers.push(handler);
    }),
    reload: vi.fn(),
    loadURL: vi.fn(),
  };
  const win = { id: 7, isDestroyed: vi.fn(() => false), destroy: vi.fn() };
  attachAppViewRendererGoneHandler({
    win: win as never,
    appWebContents: appWebContents as never,
    getProjectViewManager: () => (opts.pvm ?? null) as ProjectViewManager | null,
    getRecoveryUrl: (reason, exitCode) => `app://daintree/recovery.html?${reason}-${exitCode}`,
    onRecreateWindow: opts.onRecreateWindow,
  });
  const crash = (reason: string, exitCode = 1) => {
    for (const handler of handlers) handler({}, { reason, exitCode });
  };
  return { appWebContents, win, handlers, crash };
}

/**
 * Stands in for the manager's claim: `notifyActiveViewCrashed` reports whether
 * it ran the hook, which it only does for the claimed, active view. The
 * gating itself is covered against the real manager in
 * ProjectViewManager.lifecycle.test.ts.
 */
function createClaimingManager(opts: { claimed: boolean; active: boolean }) {
  const onViewCrashed = vi.fn();
  const pvm = {
    getProjectIdForWebContents: (id: number) => (opts.claimed && id === 2 ? "proj-a" : null),
    notifyActiveViewCrashed: vi.fn((wc: Electron.WebContents) => {
      if (!opts.claimed || !opts.active) return false;
      onViewCrashed(wc);
      return true;
    }),
    getLowMemoryFreeThresholdMb: (): number | null => null,
  };
  return { pvm, onViewCrashed };
}

describe("app-view render-process-gone (#12954)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    availableMemory.mb = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("registers exactly one render-process-gone listener", () => {
    const { handlers } = createHarness();
    expect(handlers).toHaveLength(1);
  });

  it("routes a startup-view crash to onViewCrashed exactly once, before the reload", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { appWebContents, crash } = createHarness({ pvm });

    crash("crashed");

    expect(onViewCrashed).toHaveBeenCalledTimes(1);
    expect(onViewCrashed).toHaveBeenCalledWith(appWebContents);
    expect(appWebContents.reload).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(appWebContents.reload).toHaveBeenCalledTimes(1);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(recordRendererGone).toHaveBeenCalledTimes(1);
    expect(recordRendererGone).toHaveBeenCalledWith(
      expect.objectContaining({ process: "app-view", projectId: "proj-a", webContentsId: 2 })
    );
  });

  it("fires the hook on memory-eviction too, matching ProjectViewHandlers", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { appWebContents, crash } = createHarness({ pvm });

    crash("memory-eviction");

    expect(onViewCrashed).toHaveBeenCalledTimes(1);
    vi.runAllTimers();
    expect(appWebContents.reload).toHaveBeenCalledTimes(1);
    expect(recordRendererGone).not.toHaveBeenCalled();
  });

  it("fires the hook when the crash loop sends the view to the recovery page", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { appWebContents, crash } = createHarness({ pvm });

    crash("crashed");
    crash("crashed");
    crash("crashed");
    vi.runAllTimers();

    expect(onViewCrashed).toHaveBeenCalledTimes(3);
    expect(appWebContents.loadURL).toHaveBeenCalledWith("app://daintree/recovery.html?crashed-1");
  });

  it("does not fire the hook for an unbound window's picker", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: false, active: true });
    const { appWebContents, crash } = createHarness({ pvm });

    crash("crashed");
    vi.runAllTimers();

    expect(onViewCrashed).not.toHaveBeenCalled();
    expect(appWebContents.reload).toHaveBeenCalledTimes(1);
  });

  it("does not fire the hook when the app view is no longer the active project", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: false });
    const { crash } = createHarness({ pvm });

    crash("crashed");

    expect(onViewCrashed).not.toHaveBeenCalled();
  });

  it("still recovers when the window has no manager yet", () => {
    const { appWebContents, crash } = createHarness({ pvm: null });

    crash("crashed");
    vi.runAllTimers();

    expect(appWebContents.reload).toHaveBeenCalledTimes(1);
  });

  it("skips the hook and recovery once the window is destroyed", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { appWebContents, win, crash } = createHarness({ pvm });
    win.isDestroyed.mockReturnValue(true);

    crash("crashed");
    vi.runAllTimers();

    expect(onViewCrashed).not.toHaveBeenCalled();
    expect(appWebContents.reload).not.toHaveBeenCalled();
  });

  it("ignores clean-exit entirely", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { crash } = createHarness({ pvm });

    crash("clean-exit", 0);

    expect(onViewCrashed).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });

  it("writes the reason and exit code to the log file", () => {
    const { pvm } = createClaimingManager({ claimed: true, active: true });
    const { crash } = createHarness({ pvm });

    crash("killed", 9);

    expect(logError).toHaveBeenCalledWith(
      "Renderer process gone",
      undefined,
      expect.objectContaining({
        process: "app-view",
        reason: "killed",
        exitCode: 9,
        webContentsId: 2,
        projectId: "proj-a",
      })
    );
  });

  it("routes a probable OOM to window recreation after firing the hook", async () => {
    availableMemory.mb = 100;
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    pvm.getLowMemoryFreeThresholdMb = () => 500;
    const onRecreateWindow = vi.fn(() => Promise.resolve());
    const { win, crash } = createHarness({ pvm, onRecreateWindow });

    crash("crashed");
    expect(onViewCrashed).toHaveBeenCalledTimes(1);
    await vi.runAllTimersAsync();

    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(onRecreateWindow).toHaveBeenCalledTimes(1);
    expect(isWindowRecreating()).toBe(false);
  });

  it("releases the recreation guard when recreating after an explicit oom fails", async () => {
    const onRecreateWindow = vi.fn(() => Promise.reject(new Error("recreate failed")));
    const { win, crash } = createHarness({ onRecreateWindow });
    vi.spyOn(console, "error").mockImplementation(() => {});

    crash("oom");
    await vi.runAllTimersAsync();

    expect(win.destroy).toHaveBeenCalledTimes(1);
    expect(onRecreateWindow).toHaveBeenCalledTimes(1);
    expect(isWindowRecreating()).toBe(false);
  });

  it("does not reload when the window is destroyed between the crash and the deferred reload", () => {
    const { pvm, onViewCrashed } = createClaimingManager({ claimed: true, active: true });
    const { appWebContents, win, crash } = createHarness({ pvm });

    crash("crashed");
    expect(onViewCrashed).toHaveBeenCalledTimes(1);
    win.isDestroyed.mockReturnValue(true);
    vi.runAllTimers();

    expect(appWebContents.reload).not.toHaveBeenCalled();
  });

  it("does not count memory evictions toward the crash-loop budget", () => {
    const { appWebContents, crash } = createHarness();

    crash("memory-eviction", 0);
    crash("memory-eviction", 0);
    crash("crashed");
    vi.runAllTimers();

    expect(appWebContents.loadURL).not.toHaveBeenCalled();
    expect(appWebContents.reload).toHaveBeenCalledTimes(3);
  });

  it("logs memory eviction as a warning, not an error", () => {
    const { crash } = createHarness();

    crash("memory-eviction", 0);

    expect(logWarn).toHaveBeenCalledWith(
      "Renderer process gone",
      expect.objectContaining({ process: "app-view", reason: "memory-eviction" })
    );
    expect(logError).not.toHaveBeenCalled();
  });
});
