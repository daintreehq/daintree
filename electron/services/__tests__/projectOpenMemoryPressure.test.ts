import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  getFocusedWindow: vi.fn<() => unknown>(() => null),
  getAllWindows: vi.fn<() => unknown[]>(() => []),
  checkKernelPressureCritical: vi.fn<() => Promise<boolean>>(),
  logInfo: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: { showMessageBox: mocks.showMessageBox },
  BrowserWindow: { getFocusedWindow: mocks.getFocusedWindow, getAllWindows: mocks.getAllWindows },
}));
vi.mock("../SystemMemoryPressureMonitor.js", () => ({
  checkKernelPressureCritical: mocks.checkKernelPressureCritical,
}));
vi.mock("../../utils/logger.js", () => ({ logInfo: mocks.logInfo }));

import { confirmColdOpenAtMemoryPressure } from "../projectOpenMemoryPressure.js";

const fakeWindow = ({ destroyed = false, visible = true } = {}) =>
  ({ isDestroyed: () => destroyed, isVisible: () => visible }) as unknown as BrowserWindow;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkKernelPressureCritical.mockResolvedValue(true);
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.getFocusedWindow.mockReturnValue(null);
  mocks.getAllWindows.mockReturnValue([]);
});

describe("confirmColdOpenAtMemoryPressure (#13638)", () => {
  it("admits without asking while pressure isn't critical", async () => {
    mocks.checkKernelPressureCritical.mockResolvedValue(false);

    await expect(
      confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1" })
    ).resolves.toBe("open");
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("asks at critical pressure, Cancel being the default, and holds the open on Cancel", async () => {
    await expect(
      confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1" })
    ).resolves.toBe("cancel");

    const [options] = mocks.showMessageBox.mock.calls[0];
    expect(options.message).toContain('"app"');
    expect(options.buttons[options.defaultId]).toBe("Cancel");
    expect(options.cancelId).toBe(options.defaultId);
    expect(mocks.logInfo).toHaveBeenCalledWith("project-open-held-memory-pressure", {
      projectId: "p1",
    });
  });

  it("admits the open when the user chooses to open anyway", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(
      confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: null })
    ).resolves.toBe("open-anyway");
  });

  it("sits the dialog on the window that asked", async () => {
    const parent = fakeWindow();
    mocks.getFocusedWindow.mockReturnValue(fakeWindow());

    await confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1", parent });

    expect(mocks.showMessageBox.mock.calls[0][0]).toBe(parent);
  });

  it("finds a window for the dialog when the one that asked is gone or there was none", async () => {
    // Unparented, the macOS message box runs synchronously and stalls main.
    const focused = fakeWindow();
    mocks.getFocusedWindow.mockReturnValue(focused);
    await confirmColdOpenAtMemoryPressure({
      projectName: "app",
      projectId: "p1",
      parent: fakeWindow({ destroyed: true }),
    });
    expect(mocks.showMessageBox.mock.calls[0][0]).toBe(focused);

    const shown = fakeWindow();
    mocks.getFocusedWindow.mockReturnValue(null);
    mocks.getAllWindows.mockReturnValue([fakeWindow({ visible: false }), shown]);
    await confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1", parent: null });
    expect(mocks.showMessageBox.mock.calls[1][0]).toBe(shown);
  });

  it("stands alone only when no window is showing", async () => {
    mocks.getAllWindows.mockReturnValue([fakeWindow({ visible: false })]);

    await confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1" });

    expect(mocks.showMessageBox.mock.calls[0]).toHaveLength(1);
  });

  it("answers a question its request abandoned as a Cancel", async () => {
    const abort = new AbortController();
    mocks.showMessageBox.mockImplementation(async (options: { signal?: AbortSignal }) => {
      expect(options.signal).toBe(abort.signal);
      abort.abort();
      return { response: 0 };
    });

    await expect(
      confirmColdOpenAtMemoryPressure({
        projectName: "app",
        projectId: "p1",
        signal: abort.signal,
      })
    ).resolves.toBe("cancel");
  });
});
