import { beforeEach, describe, expect, it, vi } from "vitest";

const crashServiceMock = vi.hoisted(() => ({
  recordCrash: vi.fn(),
  recordRendererGone: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { isPackaged: true, getAppPath: vi.fn(() => "/app") },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

vi.mock("../../services/CrashRecoveryService.js", () => ({
  getCrashRecoveryService: () => crashServiceMock,
}));

vi.mock("../../utils/openExternal.js", () => ({
  canOpenExternalUrl: vi.fn(() => false),
  openExternalUrl: vi.fn(),
}));

vi.mock("../../ipc/errorHandlers.js", () => ({ notifyError: vi.fn() }));

vi.mock("../rendererConsoleCapture.js", () => ({
  attachRendererConsoleCapture: vi.fn(),
  detachRendererConsoleCapture: vi.fn(),
}));

vi.mock("../ProjectViewEvictionController.js", () => ({
  evictDeadView: vi.fn(),
  getAvailableMemoryMb: vi.fn(() => null),
}));

vi.mock("../powerPolicyDelivery.js", () => ({ deliverPowerPolicy: vi.fn() }));

const loggerMock = vi.hoisted(() => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../utils/logger.js", () => loggerMock);

import { setupViewHandlers } from "../ProjectViewHandlers.js";
import type { ProjectViewManager } from "../ProjectViewManager.js";
import type { ViewEntry } from "../ProjectViewManagerTypes.js";

type Listener = (...args: unknown[]) => void;

function setup() {
  const listeners = new Map<string, Listener>();
  const wc = {
    id: 42,
    isDestroyed: () => false,
    on: vi.fn((event: string, listener: Listener) => listeners.set(event, listener)),
    removeListener: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  };
  const host = {
    win: { isDestroyed: () => true },
    webContentsToProject: new Map([[42, "proj-a"]]),
    views: new Map(),
    activeProjectId: "proj-a",
  } as unknown as ProjectViewManager;
  const entry = { cleanupHandlers: () => {} } as unknown as ViewEntry;
  setupViewHandlers(host, { webContents: wc } as never, entry);
  const fire = (reason: string, exitCode: number) =>
    listeners.get("render-process-gone")!({}, { reason, exitCode });
  return { fire };
}

describe("ProjectViewHandlers render-process-gone recording (#12884)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("records a view renderer death as a non-fatal event, never as a crash", () => {
    const { fire } = setup();

    fire("killed", 15);

    expect(crashServiceMock.recordRendererGone).toHaveBeenCalledWith({
      process: "project-view",
      projectId: "proj-a",
      webContentsId: 42,
      reason: "killed",
      exitCode: 15,
    });
    expect(crashServiceMock.recordCrash).not.toHaveBeenCalled();
  });

  it.each(["clean-exit", "memory-eviction"])("records nothing for %s", (reason) => {
    const { fire } = setup();

    fire(reason, 0);

    expect(crashServiceMock.recordRendererGone).not.toHaveBeenCalled();
    expect(crashServiceMock.recordCrash).not.toHaveBeenCalled();
  });

  it("writes the reason and exit code to the log file (#12954)", () => {
    const { fire } = setup();

    fire("crashed", 5);

    expect(loggerMock.logError).toHaveBeenCalledWith(
      "View renderer gone",
      undefined,
      expect.objectContaining({
        process: "project-view",
        reason: "crashed",
        exitCode: 5,
        webContentsId: 42,
        projectId: "proj-a",
      })
    );
    expect(loggerMock.logWarn).not.toHaveBeenCalled();
  });

  it("logs memory eviction as a warning, not an error", () => {
    const { fire } = setup();

    fire("memory-eviction", 0);

    expect(loggerMock.logWarn).toHaveBeenCalledWith(
      "View renderer gone",
      expect.objectContaining({ reason: "memory-eviction" })
    );
    expect(loggerMock.logError).not.toHaveBeenCalled();
  });

  it("logs nothing for a clean exit", () => {
    const { fire } = setup();

    fire("clean-exit", 0);

    expect(loggerMock.logError).not.toHaveBeenCalled();
    expect(loggerMock.logWarn).not.toHaveBeenCalled();
  });
});
