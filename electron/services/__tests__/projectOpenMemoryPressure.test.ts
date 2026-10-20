import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  checkKernelPressureCritical: vi.fn<() => Promise<boolean>>(),
  logInfo: vi.fn(),
}));

vi.mock("electron", () => ({ dialog: { showMessageBox: mocks.showMessageBox } }));
vi.mock("../SystemMemoryPressureMonitor.js", () => ({
  checkKernelPressureCritical: mocks.checkKernelPressureCritical,
}));
vi.mock("../../utils/logger.js", () => ({ logInfo: mocks.logInfo }));

import { confirmColdOpenAtMemoryPressure } from "../projectOpenMemoryPressure.js";

const fakeWindow = (destroyed = false) =>
  ({ isDestroyed: () => destroyed }) as unknown as BrowserWindow;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.checkKernelPressureCritical.mockResolvedValue(true);
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
});

describe("confirmColdOpenAtMemoryPressure (#13638)", () => {
  it("admits without asking while pressure isn't critical", async () => {
    mocks.checkKernelPressureCritical.mockResolvedValue(false);

    await expect(
      confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1" })
    ).resolves.toBe(true);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it("asks at critical pressure, Cancel being the default, and holds the open on Cancel", async () => {
    await expect(
      confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1" })
    ).resolves.toBe(false);

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
    ).resolves.toBe(true);
  });

  it("sits the dialog on the window that asked, and stands alone without one", async () => {
    const parent = fakeWindow();
    await confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1", parent });
    expect(mocks.showMessageBox.mock.calls[0][0]).toBe(parent);

    await confirmColdOpenAtMemoryPressure({
      projectName: "app",
      projectId: "p1",
      parent: fakeWindow(true),
    });
    await confirmColdOpenAtMemoryPressure({ projectName: "app", projectId: "p1", parent: null });
    for (const call of mocks.showMessageBox.mock.calls.slice(1)) {
      expect(call).toHaveLength(1);
    }
  });
});
