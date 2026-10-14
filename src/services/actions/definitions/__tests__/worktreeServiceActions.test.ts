// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyActionDefinition } from "../../actionTypes";

const mockNotify = vi.fn();
vi.mock("@/lib/notify", () => ({
  notify: (...args: unknown[]) => mockNotify(...args),
}));

const mockLogWarn = vi.fn();
vi.mock("@/utils/logger", () => ({
  logWarn: (...args: unknown[]) => mockLogWarn(...args),
}));

const mockRefreshPullRequests = vi.fn().mockResolvedValue(undefined);
const retryProjectLoadMock = vi.fn<() => Promise<void>>();
const setWorktreeLoadErrorMock = vi.fn<(error: string | null) => void>();

let worktreeLoadError: string | null = null;
let currentProject: { id: string } | null = null;
let viewState: { isInitialized: boolean; isLoading: boolean; error: string | null } | null = null;

vi.mock("@/clients", () => ({
  worktreeClient: {
    refreshPullRequests: () => mockRefreshPullRequests(),
    retryProjectLoad: () => retryProjectLoadMock(),
  },
}));

vi.mock("@/store/createWorktreeStore", () => ({
  getCurrentViewStoreOrNull: () => (viewState ? { getState: () => viewState } : null),
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: {
    getState: () => ({
      worktreeLoadError,
      currentProject,
      setWorktreeLoadError: setWorktreeLoadErrorMock,
    }),
  },
}));

const mockRequest = vi.fn();
let readyCallbacks: Array<() => void> = [];
let portReady = false;
const mockOnReady = vi.fn((callback: () => void) => {
  if (portReady) callback();
  readyCallbacks.push(callback);
  return () => {
    const idx = readyCallbacks.indexOf(callback);
    if (idx >= 0) readyCallbacks.splice(idx, 1);
  };
});

async function attachPort(): Promise<void> {
  portReady = true;
  // Mirrors preload: iterate the live array, so an in-loop unsubscribe would skip a listener.
  for (const cb of readyCallbacks) cb();
  await Promise.resolve();
  await Promise.resolve();
}

type ActionFactory = () => AnyActionDefinition;

describe("worktree service action definitions", () => {
  const registry = new Map<string, ActionFactory>();
  const runRefresh = () => registry.get("worktree.refresh")!().run!(undefined, {});

  beforeAll(async () => {
    (globalThis as unknown as { window: Window }).window = globalThis.window ?? ({} as Window);
    (window as unknown as { electron: unknown }).electron = {
      worktreePort: {
        request: (...args: unknown[]) => mockRequest(...args),
        onReady: (callback: () => void) => mockOnReady(callback),
      },
    };

    const { registerWorktreeServiceActions } = await import("../worktreeServiceActions");
    registerWorktreeServiceActions(registry as never, {} as never);
  });

  beforeEach(async () => {
    // Flush any refresh a previous test left waiting on the port.
    await attachPort();
    readyCallbacks = [];
    portReady = false;
    vi.clearAllMocks();
    mockRequest.mockResolvedValue({ ok: true });
    mockRefreshPullRequests.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["succeeds", () => mockRequest.mockResolvedValueOnce({ ok: true })],
    ["fails", () => mockRequest.mockRejectedValueOnce(new Error("Worktree port timed out"))],
    [
      "defers on a missing port",
      () => mockRequest.mockRejectedValueOnce(new Error("[BrokerError|HOST_EXITED] not ready")),
    ],
  ])(
    "worktree.refresh settles every refresh it starts when the host %s",
    async (_label, arrange) => {
      // The sidebar counts in-flight refreshes off this pair, so a start with no
      // settle would leave its refresh icon spinning for good.
      arrange();
      const events: string[] = [];
      const record = (e: Event) => events.push(e.type);
      window.addEventListener("daintree:refresh-sidebar", record);
      window.addEventListener("daintree:refresh-sidebar-settled", record);
      try {
        const run = runRefresh();
        expect(events).toEqual(["daintree:refresh-sidebar"]);
        await run;
        expect(events).toEqual(["daintree:refresh-sidebar", "daintree:refresh-sidebar-settled"]);
      } finally {
        window.removeEventListener("daintree:refresh-sidebar", record);
        window.removeEventListener("daintree:refresh-sidebar-settled", record);
      }
    }
  );

  it("worktree.refresh surfaces an error toast when the host does not respond", async () => {
    mockRequest.mockRejectedValueOnce(new Error("Worktree port timed out"));

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Refresh failed");
    expect(payload.message).toContain("Worktree port timed out");
  });

  it.each([
    ["HOST_EXITED", "Worktree port not ready"],
    ["HOST_EXITED", "Worktree port replaced"],
    ["APP_SHUTDOWN", "Broker disposed"],
  ])(
    "worktree.refresh logs instead of toasting when the port is unavailable (%s: %s)",
    async (code, message) => {
      // The exact shape preload's encodeBrokerError produces across contextBridge.
      mockRequest.mockRejectedValueOnce(new Error(`[BrokerError|${code}] ${message}`));

      await runRefresh();

      expect(mockNotify).not.toHaveBeenCalled();
      expect(mockLogWarn).toHaveBeenCalledWith("Worktree refresh deferred: port unavailable", {
        code,
        reason: message,
      });
      // The pool-wide PR refresh doesn't depend on this view's port.
      expect(mockRefreshPullRequests).toHaveBeenCalledTimes(1);
    }
  );

  it("worktree.refresh runs a port-not-ready refresh once the port attaches", async () => {
    mockRequest.mockRejectedValueOnce(
      new Error("[BrokerError|HOST_EXITED] Worktree port not ready")
    );
    await runRefresh();
    // A second miss before the port arrives coalesces into the same pending refresh.
    mockRequest.mockRejectedValueOnce(
      new Error("[BrokerError|HOST_EXITED] Worktree port not ready")
    );
    await runRefresh();

    const otherListener = vi.fn();
    expect(readyCallbacks).toHaveLength(1);
    readyCallbacks.push(otherListener);
    mockRequest.mockClear();

    await attachPort();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith("refresh");
    expect(otherListener).toHaveBeenCalledTimes(1);
    expect(readyCallbacks).toEqual([otherListener]);

    // Later re-attaches don't repeat it.
    mockRequest.mockClear();
    await attachPort();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.refresh does not defer a refresh when the app is shutting down", async () => {
    mockRequest.mockRejectedValueOnce(new Error("[BrokerError|APP_SHUTDOWN] Broker disposed"));
    await runRefresh();

    expect(mockOnReady).not.toHaveBeenCalled();
  });

  it("worktree.refresh toasts a broker timeout without the transport prefix", async () => {
    mockRequest.mockRejectedValueOnce(
      new Error("[BrokerError|TIMEOUT] Request timeout: refresh (10000ms)")
    );

    await runRefresh();

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Refresh failed",
        message: "Request timeout: refresh (10000ms)",
      })
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("worktree.refresh surfaces an error toast when the host reports ok:false (watchdog tripped)", async () => {
    mockRequest.mockResolvedValueOnce({ ok: false, error: "Refresh watchdog tripped" });

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const payload = mockNotify.mock.calls[0]![0] as {
      type: string;
      title: string;
      message: string;
    };
    expect(payload.type).toBe("error");
    expect(payload.title).toBe("Refresh failed");
    expect(payload.message).toBe("Refresh watchdog tripped");
  });

  it("worktree.refresh drives both the active host and the pool-wide PR fan-out", async () => {
    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    // These reach different hosts and are NOT interchangeable: the worktree
    // port is bound to this view's project alone, while refreshPullRequests
    // fans out across every pooled project. Dropping either as a "duplicate"
    // silently narrows what a refresh actually covers — the duplicate work it
    // used to cause is coalesced host-side instead (#11633).
    expect(mockRequest).toHaveBeenCalledWith("refresh");
    expect(mockRefreshPullRequests).toHaveBeenCalledTimes(1);
  });

  it("worktree.refresh does not let a PR-refresh failure surface as a refresh error", async () => {
    mockRefreshPullRequests.mockRejectedValueOnce(new Error("rate limited"));

    const def = registry.get("worktree.refresh")!();
    await def.run!(undefined as never, undefined as never);

    // Only the worktree refresh request governs the error toast; a PR fetch
    // failure is independent and must not raise "Refresh failed".
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("worktree.reconcileTopology forces the reconcile so it can't be coalesced away", async () => {
    const def = registry.get("worktree.reconcileTopology")!();
    await def.run!(undefined as never, undefined as never);

    expect(mockRequest).toHaveBeenCalledWith("reconcile-topology", { force: true });
  });
});

const { registerWorktreeServiceActions } = await import("../worktreeServiceActions");

type Registry = Map<string, () => { [k: string]: unknown }>;

function buildRegistry(): Registry {
  const registry: Registry = new Map();
  registerWorktreeServiceActions(registry as never, {} as never);
  return registry;
}

function getAction() {
  const factory = buildRegistry().get("worktree.retryProjectLoad");
  if (!factory) throw new Error("worktree.retryProjectLoad not registered");
  return factory() as {
    danger: string;
    isEnabled: (ctx: unknown) => boolean;
    disabledReason: (ctx: unknown) => string | undefined;
    run: (args: unknown, ctx: unknown) => Promise<void>;
  };
}

describe("worktree.retryProjectLoad (#8400)", () => {
  beforeEach(() => {
    retryProjectLoadMock.mockReset();
    retryProjectLoadMock.mockResolvedValue(undefined);
    setWorktreeLoadErrorMock.mockReset();
    worktreeLoadError = null;
    currentProject = null;
    viewState = null;
  });

  it("is disabled when there is no worktree load failure", () => {
    worktreeLoadError = null;
    const action = getAction();
    expect(action.isEnabled({})).toBe(false);
    expect(action.disabledReason({})).toBe("No worktree load failure to retry");
  });

  it("is enabled while a worktree load failure is present", () => {
    worktreeLoadError = "Not a git repository";
    const action = getAction();
    expect(action.isEnabled({})).toBe(true);
    expect(action.disabledReason({})).toBeUndefined();
  });

  it("is enabled for an open project whose worktree store settled without a snapshot (#12576)", () => {
    // No error to show, but no port either — the state that used to read as an
    // empty repository. It must be retryable, not a dead end.
    currentProject = { id: "p1" };
    viewState = { isInitialized: false, isLoading: false, error: null };
    const action = getAction();
    expect(action.isEnabled({})).toBe(true);
    expect(action.disabledReason({})).toBeUndefined();
  });

  it("stays disabled while the first snapshot is still loading or once one has landed", () => {
    currentProject = { id: "p1" };
    viewState = { isInitialized: false, isLoading: true, error: null };
    expect(getAction().isEnabled({})).toBe(false);

    viewState = { isInitialized: true, isLoading: false, error: null };
    expect(getAction().isEnabled({})).toBe(false);
  });

  it("leaves a crashed workspace service to Restart service", () => {
    // setFatalError also leaves the store uninitialized and settled, but a
    // reload can't bring back a host that exhausted its restart budget.
    currentProject = { id: "p1" };
    viewState = { isInitialized: false, isLoading: false, error: "Workspace service crashed" };
    const action = getAction();
    expect(action.isEnabled({})).toBe(false);
    expect(action.disabledReason({})).toMatch(/restart/i);
  });

  it("leaves a crashed service to Restart even when a load failure is also reported", () => {
    // A dead host is usually why the load failed; a reload can't fix either.
    worktreeLoadError = "Not a git repository";
    currentProject = { id: "p1" };
    viewState = { isInitialized: true, isLoading: false, error: "Workspace service crashed" };
    const action = getAction();
    expect(action.isEnabled({})).toBe(false);
    expect(action.disabledReason({})).toMatch(/restart/i);
  });

  it("stays disabled for an unbound view", () => {
    currentProject = null;
    viewState = { isInitialized: false, isLoading: false, error: null };
    expect(getAction().isEnabled({})).toBe(false);
  });

  it("clears the banner after a successful retry", async () => {
    worktreeLoadError = "Not a git repository";
    await getAction().run(undefined, {});
    expect(retryProjectLoadMock).toHaveBeenCalledTimes(1);
    expect(setWorktreeLoadErrorMock).toHaveBeenCalledWith(null);
  });

  it("leaves the banner in place when the retry fails", async () => {
    worktreeLoadError = "Not a git repository";
    retryProjectLoadMock.mockRejectedValue(new Error("still broken"));
    await expect(getAction().run(undefined, {})).rejects.toThrow("still broken");
    expect(setWorktreeLoadErrorMock).not.toHaveBeenCalled();
  });

  it("does not clobber a new error that arrived mid-retry", async () => {
    worktreeLoadError = "Not a git repository";
    let resolveRetry: () => void = () => {};
    retryProjectLoadMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRetry = resolve;
      })
    );

    const runPromise = getAction().run(undefined, {});
    // A concurrent switch surfaces a different failure while the retry is in
    // flight — the success path must not wipe it.
    worktreeLoadError = "A different project failed";
    resolveRetry();
    await runPromise;

    expect(setWorktreeLoadErrorMock).not.toHaveBeenCalled();
  });
});
