import { beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  getActiveWorktreeIdForProjectAsync: vi.fn(),
  getAllStatesForProjectAsync: vi.fn(),
};
const getWorkspaceClientRef = vi.fn<() => typeof client | null>(() => client);
vi.mock("../../../window/serviceRefs.js", () => ({
  getWorkspaceClientRef: () => getWorkspaceClientRef(),
}));

const getProjectById = vi.fn();
vi.mock("../../ProjectStore.js", () => ({
  projectStore: { getProjectById: (id: string) => getProjectById(id) },
}));

import { resolveActiveWorktreeIdForProject } from "../pluginInvokeContext.js";

describe("resolveActiveWorktreeIdForProject (#17069)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getWorkspaceClientRef.mockReturnValue(client);
    getProjectById.mockReturnValue({ id: "proj-a", path: "/repo/a" });
  });

  it("reads the id alone from the project's own host, guarded by its id", async () => {
    client.getActiveWorktreeIdForProjectAsync.mockResolvedValue("wt-a");

    expect(await resolveActiveWorktreeIdForProject("proj-a")).toBe("wt-a");
    expect(client.getActiveWorktreeIdForProjectAsync).toHaveBeenCalledWith("/repo/a", "proj-a");
    expect(client.getAllStatesForProjectAsync).not.toHaveBeenCalled();
  });

  it("answers null for a project this host doesn't know", async () => {
    getProjectById.mockReturnValue(undefined);

    expect(await resolveActiveWorktreeIdForProject("proj-x")).toBeNull();
    expect(client.getActiveWorktreeIdForProjectAsync).not.toHaveBeenCalled();
  });

  it("degrades to null when the workspace host fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    client.getActiveWorktreeIdForProjectAsync.mockRejectedValue(new Error("host down"));

    expect(await resolveActiveWorktreeIdForProject("proj-a")).toBeNull();
    error.mockRestore();
  });
});
