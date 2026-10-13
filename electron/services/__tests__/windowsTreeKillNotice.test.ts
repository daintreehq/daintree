import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { broadcastMock, unavailableListeners } = vi.hoisted(() => ({
  broadcastMock: vi.fn(),
  unavailableListeners: [] as Array<(reason: string) => void>,
}));

vi.mock("../../ipc/utils.js", () => ({ broadcastToRenderer: broadcastMock }));
vi.mock("../../utils/windowsTreeKill.js", () => ({
  onWindowsTreeKillUnavailable: (listener: (reason: string) => void) => {
    unavailableListeners.push(listener);
    return () => {};
  },
}));

import { CHANNELS } from "../../ipc/channels.js";
import {
  installWindowsTreeKillNotice,
  reportWindowsTreeKillUnavailable,
  resetWindowsTreeKillNoticeForTest,
} from "../windowsTreeKillNotice.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("windowsTreeKillNotice", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    broadcastMock.mockReset();
    resetWindowsTreeKillNoticeForTest();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    warnSpy.mockRestore();
  });

  it("tells the user once per session, whichever process ran into it", () => {
    reportWindowsTreeKillUnavailable("spawn powershell.exe EACCES", "daintree-pty-host");
    reportWindowsTreeKillUnavailable("exited 1: Cannot set property", "main");
    reportWindowsTreeKillUnavailable("spawn powershell.exe EACCES", "daintree-pty-host:p1");

    expect(broadcastMock).toHaveBeenCalledTimes(1);
    expect(broadcastMock).toHaveBeenCalledWith(
      CHANNELS.NOTIFICATION_SHOW_TOAST,
      expect.objectContaining({
        type: "warning",
        message: expect.stringContaining("Terminals still close"),
      })
    );
    // One clear line in the log, naming the cause.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("spawn powershell.exe EACCES"));
  });

  it("routes Main's own helper failures to the same notice on Windows", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    installWindowsTreeKillNotice();
    installWindowsTreeKillNotice();

    expect(unavailableListeners).toHaveLength(1);
    unavailableListeners[0]("exited 1");
    reportWindowsTreeKillUnavailable("exited 1", "daintree-pty-host");
    expect(broadcastMock).toHaveBeenCalledTimes(1);
  });
});
