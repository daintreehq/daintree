import { describe, expect, it, vi } from "vitest";
import { ResyncCoordinator } from "../ResyncCoordinator.js";

describe("ResyncCoordinator", () => {
  it("tells each reopened view once after a fresh session", () => {
    const resync = vi.fn();
    const coordinator = new ResyncCoordinator({ resync });

    coordinator.onSessionAttached("studio-01", { resumed: false, reopened: [11, 12, 11] });

    expect(resync.mock.calls).toEqual([
      [11, "studio-01", "reconnected"],
      [12, "studio-01", "reconnected"],
    ]);
  });

  it("leaves a resumed session to the host's own announcement", () => {
    const resync = vi.fn();
    new ResyncCoordinator({ resync }).onSessionAttached("studio-01", {
      resumed: true,
      reopened: [],
    });
    expect(resync).not.toHaveBeenCalled();
  });

  it("keeps telling the other views when one of them throws", () => {
    const resync = vi.fn((webContentsId: number) => {
      if (webContentsId === 11) throw new Error("view gone");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    new ResyncCoordinator({ resync }).onSessionAttached("studio-01", {
      resumed: false,
      reopened: [11, 12],
    });
    expect(resync).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
