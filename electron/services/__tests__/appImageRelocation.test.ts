import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliMock = vi.hoisted(() => ({ repointAppImageWrapper: vi.fn(() => true) }));

vi.mock("../CliInstallService.js", () => cliMock);

const relaunchMock = vi.hoisted(() => ({ retargetRelaunch: vi.fn() }));

vi.mock("../../lifecycle/armRelaunch.js", () => relaunchMock);

import {
  notifyAppImageRelocated,
  onAppImageRelocated,
  reconcileAppImageReferences,
  resetAppImageRelocationHandlersForTests,
} from "../appImageRelocation.js";

const relocation = {
  previous: "/home/u/Applications/Daintree-1.2.0.AppImage",
  next: "/home/u/Applications/Daintree-1.3.0.AppImage",
};

describe("appImageRelocation", () => {
  beforeEach(() => {
    cliMock.repointAppImageWrapper.mockReset().mockReturnValue(true);
    relaunchMock.retargetRelaunch.mockReset();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    resetAppImageRelocationHandlersForTests();
    vi.restoreAllMocks();
  });

  it("points the daintree command at the new image and tells every handler", () => {
    const handler = vi.fn();
    onAppImageRelocated(handler);

    notifyAppImageRelocated(relocation);

    expect(cliMock.repointAppImageWrapper).toHaveBeenCalledWith(relocation.next);
    expect(handler).toHaveBeenCalledWith(relocation);
  });

  // A restart armed before electron-updater's install-on-quit would otherwise
  // run the path the install just deleted.
  it("moves an armed relaunch to the new image before anything else", () => {
    notifyAppImageRelocated(relocation);

    expect(relaunchMock.retargetRelaunch).toHaveBeenCalledWith(
      relocation.previous,
      relocation.next
    );
    expect(relaunchMock.retargetRelaunch.mock.invocationCallOrder[0]).toBeLessThan(
      cliMock.repointAppImageWrapper.mock.invocationCallOrder[0]!
    );
  });

  // The process is about to quit: a step that throws must not cost the others.
  it("keeps going past a step that fails", () => {
    relaunchMock.retargetRelaunch.mockImplementation(() => {
      throw new Error("ENOSPC");
    });
    cliMock.repointAppImageWrapper.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const failing = vi.fn(() => {
      throw new Error("boom");
    });
    const after = vi.fn();
    onAppImageRelocated(failing);
    onAppImageRelocated(after);

    expect(() => notifyAppImageRelocated(relocation)).not.toThrow();
    expect(cliMock.repointAppImageWrapper).toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(relocation);
  });

  it("repoints at startup only when this process runs from an AppImage", () => {
    reconcileAppImageReferences(null);
    expect(cliMock.repointAppImageWrapper).not.toHaveBeenCalled();

    reconcileAppImageReferences(relocation.next);
    expect(cliMock.repointAppImageWrapper).toHaveBeenCalledWith(relocation.next);
  });
});
