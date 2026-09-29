import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemMemoryPressurePayload } from "../../../shared/types/ipc/system.js";

vi.mock("../../ipc/errorHandlers.js", () => ({
  notifyError: vi.fn(),
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: { getProjectById: vi.fn(() => null) },
}));

let openEpisode: SystemMemoryPressurePayload | null = null;
vi.mock("../systemMemoryPressureDelivery.js", () => ({
  getOpenSystemMemoryPressure: () => openEpisode,
}));

import { notifyError } from "../../ipc/errorHandlers.js";
import { projectStore } from "../../services/ProjectStore.js";
import { AppError } from "../../utils/errorTypes.js";
import {
  createCancelledSwitchError,
  formatCancelledSwitchMessage,
  reportSwitchFailure,
} from "../projectSwitchCancelledError.js";

const DEGRADED: SystemMemoryPressurePayload = {
  status: "degraded",
  swapUsedPercent: 89,
  swapKind: "swap",
  fseventsdRssMb: null,
  kernelPressureLevel: "warn",
};

function view(id: number, destroyed = false) {
  return { webContents: { id, isDestroyed: () => destroyed } } as never;
}

function cancelledError() {
  return createCancelledSwitchError({
    message: "View never painted: cached project view parked after warm paint gate timeout",
    context: { phase: "paint", projectId: "proj-b", waitedMs: 4021 },
    previousProjectId: "proj-a",
  });
}

describe("formatCancelledSwitchMessage", () => {
  it("names the project the user is still in", () => {
    expect(formatCancelledSwitchMessage("Alpha", null)).toBe(
      "The project didn't finish displaying, so the switch was cancelled and you're still in Alpha."
    );
  });

  it("drops the 'still in' clause when there is no previous project name", () => {
    expect(formatCancelledSwitchMessage(null, null)).toBe(
      "The project didn't finish displaying, so the switch was cancelled."
    );
  });

  it("adds the memory observation without claiming it as the cause", () => {
    const message = formatCancelledSwitchMessage("Alpha", DEGRADED);
    expect(message).toBe(
      "The project didn't finish displaying, so the switch was cancelled and you're still in Alpha. Daintree is also reporting high system memory use."
    );
    expect(message).not.toMatch(/because|caused|due to/i);
  });
});

describe("createCancelledSwitchError", () => {
  beforeEach(() => {
    openEpisode = null;
    vi.mocked(projectStore.getProjectById).mockReset();
  });

  it("keeps the technical message and context and carries the user copy separately", () => {
    vi.mocked(projectStore.getProjectById).mockReturnValue({ name: "Alpha" } as never);
    openEpisode = DEGRADED;

    const error = cancelledError();

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toContain("View never painted");
    expect(error.context).toMatchObject({ phase: "paint", projectId: "proj-b" });
    expect(error.userMessage).toBe(formatCancelledSwitchMessage("Alpha", DEGRADED));
    expect(projectStore.getProjectById).toHaveBeenCalledWith("proj-a");
  });

  it("falls back to the nameless copy when the lookup throws or the name is blank", () => {
    vi.mocked(projectStore.getProjectById).mockImplementationOnce(() => {
      throw new Error("db closed");
    });
    expect(cancelledError().userMessage).toBe(formatCancelledSwitchMessage(null, null));

    vi.mocked(projectStore.getProjectById).mockReturnValueOnce({ name: "   " } as never);
    expect(cancelledError().userMessage).toBe(formatCancelledSwitchMessage(null, null));
  });

  it("skips the lookup when there was no previous project", () => {
    const error = createCancelledSwitchError({
      message: "View never painted",
      context: {},
      previousProjectId: null,
    });
    expect(projectStore.getProjectById).not.toHaveBeenCalled();
    expect(error.userMessage).toBe(formatCancelledSwitchMessage(null, null));
  });
});

describe("reportSwitchFailure", () => {
  beforeEach(() => {
    vi.mocked(notifyError).mockClear();
  });

  it("stays quiet when the requester is the restored view", () => {
    reportSwitchFailure(cancelledError(), 7, view(7));
    expect(notifyError).not.toHaveBeenCalled();
  });

  it.each([
    ["no requester", undefined, view(7)],
    ["a different requester", 8, view(7)],
    ["no restored view", 7, null],
    ["a destroyed restored view", 7, view(7, true)],
  ])("reports a cancelled switch with %s", (_label, requester, restored) => {
    const error = cancelledError();
    reportSwitchFailure(error, requester, restored);
    expect(notifyError).toHaveBeenCalledWith(error, { source: "project-switch" });
  });

  it("reports when the restored view's webContents can no longer be read", () => {
    const error = cancelledError();
    const torn = {
      get webContents(): never {
        throw new Error("Object has been destroyed");
      },
    };
    reportSwitchFailure(error, 7, torn as never);
    expect(notifyError).toHaveBeenCalledWith(error, { source: "project-switch" });
  });

  it("reports any other switch failure even to the restored requester", () => {
    const error = new AppError({ code: "INTERNAL", message: "load failed" });
    reportSwitchFailure(error, 7, view(7));
    expect(notifyError).toHaveBeenCalledWith(error, { source: "project-switch" });
  });
});
