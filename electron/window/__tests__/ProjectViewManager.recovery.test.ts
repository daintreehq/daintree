import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import path from "path";

const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_THRESHOLD = 3;

type WebContentsEventHandler = (event: unknown, ...args: unknown[]) => void;

function createMockWebContents() {
  const handlers = new Map<string, WebContentsEventHandler[]>();
  const wc = {
    id: 1,
    isDestroyed: vi.fn(() => false),
    loadURL: vi.fn(),
    reload: vi.fn(),
    on: vi.fn((event: string, handler: WebContentsEventHandler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    _emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) {
        handler({}, ...args);
      }
    },
  };
  return wc;
}

function createMockWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
  };
}

interface ViewEntryLike {
  projectPath: string;
  crashTimestamps: number[];
  state: "loading" | "active" | "cached";
}

interface SetupOptions {
  entry?: ViewEntryLike | null;
  backupTimestamp?: number | null;
  onViewCrashed?: (wc: ReturnType<typeof createMockWebContents>) => void;
  /** Mirrors `projectId === activeProjectId` in the real PVM. Defaults to true. */
  isActiveProject?: boolean;
  /** Mirrors the real `notifyError` import — kept as an injected fn so the test
   *  doesn't need to vi.mock the module. Auto-reload branch only. */
  notifyError?: (err: Error, ctx: { source: string }) => void;
  /** Mirrors `evictDeadView` in the real PVM — a crashed CACHED view is
   *  evicted instead of background-reloaded. */
  onEvictDeadView?: () => void;
}

/**
 * Mirrors the crash-loop branch of ProjectViewManager's `render-process-gone` handler.
 * The real handler lives in ProjectViewManager.ts but is deeply coupled to the manager's
 * view map; this test isolates the URL-construction logic that matters for issue #5375.
 */
function setupCrashRecovery(
  win: ReturnType<typeof createMockWindow>,
  wc: ReturnType<typeof createMockWebContents>,
  options: SetupOptions = {}
) {
  const {
    entry = null,
    backupTimestamp = null,
    onViewCrashed,
    isActiveProject = true,
    notifyError,
    onEvictDeadView,
  } = options;
  const crashTimestamps: number[] = entry?.crashTimestamps ?? [];

  wc.on("render-process-gone", (_event, ...args) => {
    const details = args[0] as { reason: string; exitCode: number };
    if (details.reason === "clean-exit") return;
    if (win.isDestroyed()) return;
    if (entry?.state === "loading") return;

    if (isActiveProject) {
      onViewCrashed?.(wc);
    }

    const now = Date.now();
    while (crashTimestamps.length > 0 && now - crashTimestamps[0] > CRASH_LOOP_WINDOW_MS) {
      crashTimestamps.shift();
    }
    crashTimestamps.push(now);

    if (crashTimestamps.length >= CRASH_LOOP_THRESHOLD) {
      setImmediate(() => {
        if (wc.isDestroyed()) return;
        const params = new URLSearchParams({
          reason: details.reason,
          exitCode: String(details.exitCode),
        });
        if (entry?.projectPath) {
          params.set("project", path.basename(entry.projectPath));
        }
        if (backupTimestamp !== null) {
          params.set("backupTimestamp", String(backupTimestamp));
        }
        wc.loadURL(`app://daintree/recovery.html?${params}`);
      });
    } else if (!isActiveProject && entry?.state === "cached") {
      // Mirrors the real handler: a crashed cached view is evicted instead
      // of background-reloaded — no toast, no renderer respawn.
      setImmediate(() => {
        onEvictDeadView?.();
      });
    } else {
      // Mirrors the gated notifyError in the real handler: only the active
      // view's auto-reload is observable to the user.
      if (isActiveProject) {
        notifyError?.(new Error("A project view crashed and was automatically reloaded."), {
          source: "renderer-crash",
        });
      }
      setImmediate(() => {
        if (!wc.isDestroyed()) wc.reload();
      });
    }
  });

  return { crashTimestamps };
}

function crashThrice(
  wc: ReturnType<typeof createMockWebContents>,
  reason = "crashed",
  exitCode = 1
) {
  wc._emit("render-process-gone", { reason, exitCode });
  vi.advanceTimersByTime(0);
  wc._emit("render-process-gone", { reason, exitCode });
  vi.advanceTimersByTime(0);
  wc._emit("render-process-gone", { reason, exitCode });
  vi.advanceTimersByTime(0);
}

describe("ProjectViewManager — crash recovery URL", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes project basename on crash loop when entry has projectPath", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/my-project",
      crashTimestamps: [],
      state: "active",
    };
    setupCrashRecovery(win, wc, { entry });

    crashThrice(wc);

    expect(wc.loadURL).toHaveBeenCalledOnce();
    const url = wc.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("recovery.html");
    expect(url).toContain("project=my-project");
  });

  it("includes backupTimestamp when service returns one", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    setupCrashRecovery(win, wc, { entry, backupTimestamp: 1_700_000_000_000 });

    crashThrice(wc);

    const url = wc.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("backupTimestamp=1700000000000");
  });

  it("omits project and backupTimestamp when both are missing", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    setupCrashRecovery(win, wc, { entry: null, backupTimestamp: null });

    crashThrice(wc);

    const url = wc.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("recovery.html");
    expect(url).not.toContain("project=");
    expect(url).not.toContain("backupTimestamp");
  });

  it("still loads recovery on third crash for killed reason (not filtered)", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    setupCrashRecovery(win, wc, { entry });

    crashThrice(wc, "killed", 137);

    expect(wc.loadURL).toHaveBeenCalledOnce();
    const url = wc.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("reason=killed");
    expect(url).toContain("exitCode=137");
  });

  it("encodes project names that contain spaces", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/My Project",
      crashTimestamps: [],
      state: "active",
    };
    setupCrashRecovery(win, wc, { entry });

    crashThrice(wc);

    const url = wc.loadURL.mock.calls[0][0] as string;
    expect(url).toContain("project=My+Project");
  });
});

describe("ProjectViewManager — onViewCrashed callback (#6244)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires synchronously on non-clean render-process-gone", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(onViewCrashed).toHaveBeenCalledTimes(1);
    expect(onViewCrashed).toHaveBeenCalledWith(wc);
  });

  it("does not fire on clean-exit", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed });

    wc._emit("render-process-gone", { reason: "clean-exit", exitCode: 0 });

    expect(onViewCrashed).not.toHaveBeenCalled();
  });

  it("does not fire when view is in loading state (loadView handles rollback)", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "loading",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(onViewCrashed).not.toHaveBeenCalled();
  });

  it("does not fire when window is destroyed", () => {
    const win = createMockWindow();
    win.isDestroyed.mockReturnValue(true);
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(onViewCrashed).not.toHaveBeenCalled();
  });

  it("fires on every non-clean crash including the loop threshold", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed });

    crashThrice(wc);

    expect(onViewCrashed).toHaveBeenCalledTimes(3);
  });

  it("does not fire when a cached (non-active) project view crashes", () => {
    // The per-window PTY MessagePort is only ever held by the active view
    // (handleDidFinishLoad gates onViewReady on activeProjectId). Tearing
    // it down on a cached-view crash would leave the active terminals with
    // no port and no recovery path — worse than the bug being fixed.
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-cached",
      crashTimestamps: [],
      state: "cached",
    };
    const onViewCrashed = vi.fn();
    setupCrashRecovery(win, wc, { entry, onViewCrashed, isActiveProject: false });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });

    expect(onViewCrashed).not.toHaveBeenCalled();
  });
});

describe("ProjectViewManager — auto-reload notifyError gate (#7565)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires notifyError on auto-reload when the active view crashes", () => {
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const notifyError = vi.fn();
    setupCrashRecovery(win, wc, { entry, notifyError, isActiveProject: true });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.mock.calls[0][1]).toEqual({ source: "renderer-crash" });
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it("does NOT fire notifyError when a cached (non-active) view crashes — it is evicted, not reloaded", () => {
    // Per CLAUDE.md notify() policy: only emit for events the user could not
    // otherwise observe. A cached-view crash is invisible — the user is
    // looking at a different project — and resurrecting the renderer in the
    // background would pay a full respawn for nothing, so the view is
    // evicted and revives through the cold-start path on the next visit.
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-cached",
      crashTimestamps: [],
      state: "cached",
    };
    const notifyError = vi.fn();
    const onEvictDeadView = vi.fn();
    setupCrashRecovery(win, wc, { entry, notifyError, isActiveProject: false, onEvictDeadView });

    wc._emit("render-process-gone", { reason: "crashed", exitCode: 1 });
    vi.advanceTimersByTime(0);

    expect(notifyError).not.toHaveBeenCalled();
    expect(wc.reload).not.toHaveBeenCalled();
    expect(onEvictDeadView).toHaveBeenCalledTimes(1);
  });

  it("does not fire notifyError on the crash-loop branch (recovery page)", () => {
    // The crash-loop threshold loads recovery.html; that's a separate UX
    // surface from the auto-reload toast and shouldn't trigger notifyError.
    const win = createMockWindow();
    const wc = createMockWebContents();
    const entry: ViewEntryLike = {
      projectPath: "/home/user/proj-a",
      crashTimestamps: [],
      state: "active",
    };
    const notifyError = vi.fn();
    setupCrashRecovery(win, wc, { entry, notifyError, isActiveProject: true });

    crashThrice(wc);

    // Two auto-reload notifies (first two crashes) then the third loads
    // recovery.html without notifying.
    expect(notifyError).toHaveBeenCalledTimes(2);
    expect(wc.loadURL).toHaveBeenCalledTimes(1);
  });
});
