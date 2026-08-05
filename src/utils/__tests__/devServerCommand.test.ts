import { describe, it, expect, vi, beforeEach } from "vitest";

const getSettingsMock = vi.fn();
const viewWorkspaceIdRef: { current: string | null } = { current: null };
const projectStateRef: {
  current: { projects: Array<{ id: string; path: string }>; currentProject: unknown };
} = { current: { projects: [], currentProject: null } };

vi.mock("@/clients", () => ({
  projectClient: { getSettings: (...args: unknown[]) => getSettingsMock(...args) },
}));

vi.mock("@/store/projectStore", () => ({
  useProjectStore: { getState: () => projectStateRef.current },
}));

vi.mock("@/store/viewWorkspaceId", () => ({
  getViewWorkspaceId: () => viewWorkspaceIdRef.current,
}));

import { readDevServerCommand, readViewDevServerCommand } from "../devServerCommand";

const PROJECT_A = { id: "proj-a", path: "/a" };
const PROJECT_B = { id: "proj-b", path: "/b" };

beforeEach(() => {
  getSettingsMock
    .mockReset()
    .mockImplementation((id: string) =>
      Promise.resolve({ devServerCommand: id === "proj-a" ? "npm run dev:a" : "npm run dev:b" })
    );
  viewWorkspaceIdRef.current = null;
  projectStateRef.current = { projects: [], currentProject: null };
});

describe("readDevServerCommand", () => {
  it("trims the configured command", async () => {
    getSettingsMock.mockResolvedValue({ devServerCommand: "  npm start  " });
    await expect(readDevServerCommand("proj-a")).resolves.toBe("npm start");
  });

  it("treats a blank command as unset", async () => {
    getSettingsMock.mockResolvedValue({ devServerCommand: "   " });
    await expect(readDevServerCommand("proj-a")).resolves.toBeUndefined();
  });

  it("treats absent settings as unset", async () => {
    getSettingsMock.mockResolvedValue(undefined);
    await expect(readDevServerCommand("proj-a")).resolves.toBeUndefined();
  });
});

describe("readViewDevServerCommand", () => {
  it("reads the view's own project, not the globally-current one", async () => {
    // Another window switched to B, which repoints `currentProject` in every
    // view — running B's command in A's folder is the bug this guards.
    viewWorkspaceIdRef.current = PROJECT_A.id;
    projectStateRef.current = {
      projects: [PROJECT_A, PROJECT_B],
      currentProject: PROJECT_B,
    };

    await expect(readViewDevServerCommand()).resolves.toBe("npm run dev:a");
    expect(getSettingsMock).toHaveBeenCalledWith(PROJECT_A.id);
  });

  it("falls back to the current project only for a view with no identity", async () => {
    viewWorkspaceIdRef.current = null;
    projectStateRef.current = { projects: [PROJECT_B], currentProject: PROJECT_B };

    await expect(readViewDevServerCommand()).resolves.toBe("npm run dev:b");
  });

  it("reads no settings when the view's workspace is not a project", async () => {
    viewWorkspaceIdRef.current = "scratch-1";
    projectStateRef.current = { projects: [PROJECT_A], currentProject: PROJECT_A };

    await expect(readViewDevServerCommand()).resolves.toBeUndefined();
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it("does not fail the launch when the settings read rejects", async () => {
    viewWorkspaceIdRef.current = PROJECT_A.id;
    projectStateRef.current = { projects: [PROJECT_A], currentProject: PROJECT_A };
    getSettingsMock.mockRejectedValue(new Error("IPC unavailable"));

    await expect(readViewDevServerCommand()).resolves.toBeUndefined();
  });
});
