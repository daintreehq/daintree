import { beforeEach, describe, expect, it, vi } from "vitest";

const broadcastToRendererMock = vi.hoisted(() => vi.fn());
const getProjectByIdMock = vi.hoisted(() => vi.fn<(id: string) => unknown>());

vi.mock("../utils.js", () => ({
  broadcastToRenderer: broadcastToRendererMock,
}));

vi.mock("../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: getProjectByIdMock,
  },
}));

import { broadcastProjectSwitchUpdates } from "../projectSwitchBroadcast.js";
import { CHANNELS } from "../channels.js";

describe("broadcastProjectSwitchUpdates", () => {
  beforeEach(() => {
    broadcastToRendererMock.mockClear();
    getProjectByIdMock.mockReset();
  });

  it("broadcasts both departing and activated rows on a real switch", () => {
    const prevRow = { id: "prev", name: "Previous" };
    const activeRow = { id: "active", name: "Active" };
    getProjectByIdMock.mockImplementation((id: string) =>
      id === "prev" ? prevRow : id === "active" ? activeRow : null
    );

    broadcastProjectSwitchUpdates("prev", "active");

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(2);
    expect(broadcastToRendererMock).toHaveBeenNthCalledWith(1, CHANNELS.PROJECT_UPDATED, prevRow);
    expect(broadcastToRendererMock).toHaveBeenNthCalledWith(2, CHANNELS.PROJECT_UPDATED, activeRow);
  });

  it("skips the departing broadcast when there was no previous project (cold start)", () => {
    const activeRow = { id: "active", name: "Active" };
    getProjectByIdMock.mockReturnValue(activeRow);

    broadcastProjectSwitchUpdates(null, "active");

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, activeRow);
  });

  it("skips the departing broadcast when re-activating the same project", () => {
    const activeRow = { id: "same", name: "Same" };
    getProjectByIdMock.mockReturnValue(activeRow);

    broadcastProjectSwitchUpdates("same", "same");

    expect(broadcastToRendererMock).toHaveBeenCalledTimes(1);
    expect(broadcastToRendererMock).toHaveBeenCalledWith(CHANNELS.PROJECT_UPDATED, activeRow);
  });

  it("silently drops broadcasts when getProjectById returns null", () => {
    getProjectByIdMock.mockReturnValue(null);

    broadcastProjectSwitchUpdates("prev", "active");

    expect(broadcastToRendererMock).not.toHaveBeenCalled();
  });
});
