import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import { promises as fs } from "fs";
import path from "path";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
  dialog: {
    showOpenDialog: vi.fn(),
    showErrorBox: vi.fn(),
  },
  shell: {
    openPath: vi.fn(),
    openExternal: vi.fn(),
  },
  app: {
    getPath: vi.fn().mockReturnValue(os.tmpdir()),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getCurrentProjectId: vi.fn(),
    getProjectById: vi.fn(),
    setCurrentProject: vi.fn(),
    getProjectState: vi.fn(),
    saveProjectState: vi.fn(),
    getAllProjects: vi.fn(() => []),
    getCurrentProject: vi.fn(() => null),
    updateProjectStatus: vi.fn(),
  },
}));

vi.mock("../../../services/ProjectSwitchService.js", () => ({
  ProjectSwitchService: class MockProjectSwitchService {
    onSwitch = vi.fn();
    switchProject = vi.fn();
    reopenProject = vi.fn();
  },
}));

vi.mock("../../../services/RunCommandDetector.js", () => ({
  runCommandDetector: { detect: vi.fn().mockResolvedValue([]) },
}));

vi.mock("../../../window/webContentsRegistry.js", () => ({
  getWindowForWebContents: vi.fn(() => null),
  getProjectForWebContents: vi.fn(() => null),
  getAllAppWebContents: vi.fn(() => []),
}));

vi.mock("../../../window/portDistribution.js", () => ({
  distributePortsToView: vi.fn(),
}));

import { ipcMain } from "electron";
import { CHANNELS } from "../../channels.js";
import { createProjectCrudRegistrar } from "./helpers/projectCrudLifecycle.js";
import type { HandlerDependencies } from "../../types.js";
import {
  clearPluginProjectTemplateRegistry,
  registerPluginProjectTemplates,
} from "../../../services/plugin/PluginProjectTemplateRegistry.js";
import { previewProjectTemplate } from "../../../services/plugin/projectTemplateFiles.js";

const registerProjectCrudHandlers = createProjectCrudRegistrar();

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
  const call = [...calls].reverse().find((entry) => entry[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

describe("project:create-folder with a project template (#13825)", () => {
  let tmp: string;
  let parent: string;
  let pluginDir: string;
  let createFolder: (payload: unknown) => Promise<unknown>;

  async function putTemplateFile(relPath: string, content: string): Promise<void> {
    const abs = path.join(pluginDir, "project-templates", "site", ...relPath.split("/"));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async function approvedDigest(): Promise<string> {
    const preview = await previewProjectTemplate("acme.sites", "site");
    if (preview.status !== "ready") throw new Error(preview.reason);
    return preview.digest;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-create-folder-"));
    parent = path.join(tmp, "projects");
    pluginDir = path.join(tmp, "plugin");
    await fs.mkdir(parent);
    await putTemplateFile("README.md", "# Site\n");
    await putTemplateFile("src/main.ts", "console.log('hi');\n");
    registerPluginProjectTemplates("acme.sites", "Acme Sites", pluginDir, [
      { id: "site", title: "Site", description: "A site." },
    ]);

    registerProjectCrudHandlers({
      mainWindow: { id: 1 } as unknown,
      windowRegistry: {
        getPrimary: () => ({
          windowId: 1,
          webContentsId: 10,
          browserWindow: { id: 1, isDestroyed: () => false },
        }),
        getByWindowId: () => undefined,
        getByWebContentsId: () => undefined,
        all: () => [],
        size: 1,
      },
    } as unknown as HandlerDependencies);
    const handler = getHandler(CHANNELS.PROJECT_CREATE_FOLDER);
    createFolder = (payload) => handler({ sender: { id: 1 } }, payload);
  });

  afterEach(async () => {
    clearPluginProjectTemplateRegistry();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("still creates an empty folder when no template is chosen", async () => {
    const created = await createFolder({ parentPath: parent, folderName: "plain" });
    expect(created).toBe(path.join(parent, "plain"));
    expect(await fs.readdir(created as string)).toEqual([]);
  });

  it("copies the previewed files into the new folder", async () => {
    const digest = await approvedDigest();
    const created = (await createFolder({
      parentPath: parent,
      folderName: "my-site",
      template: { pluginId: "acme.sites", templateId: "site", digest },
    })) as string;

    expect((await fs.readdir(created)).sort()).toEqual(["README.md", "src"]);
    expect(await fs.readFile(path.join(created, "src", "main.ts"), "utf8")).toBe(
      "console.log('hi');\n"
    );
  });

  it("refuses files that changed after the preview, and creates nothing", async () => {
    const digest = await approvedDigest();
    await putTemplateFile("README.md", "# Something else\n");

    await expect(
      createFolder({
        parentPath: parent,
        folderName: "my-site",
        template: { pluginId: "acme.sites", templateId: "site", digest },
      })
    ).rejects.toThrow("changed after they were listed");
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses a template it can't read in words, without the errno or path (#15232)", async () => {
    const digest = await approvedDigest();
    const readdir = vi.spyOn(fs, "readdir").mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, scandir '${pluginDir}'`), {
        code: "EACCES",
      })
    );

    try {
      const failure = await createFolder({
        parentPath: parent,
        folderName: "my-site",
        template: { pluginId: "acme.sites", templateId: "site", digest },
      }).then(
        () => null,
        (err: unknown) => err as Error
      );
      expect(failure?.message).toBe("Couldn't read this template's files.");
    } finally {
      readdir.mockRestore();
    }
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it.each([
    ["ENOSPC", "Not enough disk space to copy the template's files"],
    ["EACCES", "Permission denied: cannot copy the template's files into this folder"],
    ["EIO", "Couldn't copy the template's files into the new folder."],
  ])(
    "says why a %s copy failed in words, and leaves no folder behind (#15232)",
    async (code, message) => {
      const digest = await approvedDigest();
      const failure = Object.assign(
        new Error(`${code}: open '${path.join(parent, "my-site", "README.md")}'`),
        { code }
      );
      // Only the copy's own opens fail ("wx"); reading the template still works.
      const realOpen = fs.open;
      const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
        if (flags === "wx") throw failure;
        return realOpen(file, flags, mode);
      });

      try {
        const refusal = await createFolder({
          parentPath: parent,
          folderName: "my-site",
          template: { pluginId: "acme.sites", templateId: "site", digest },
        }).then(
          () => null,
          (err: unknown) => err as Error
        );
        expect(refusal?.message).toBe(message);
        expect(open).toHaveBeenCalledWith(expect.any(String), "wx", expect.anything());
      } finally {
        open.mockRestore();
      }
      expect(await fs.readdir(parent)).toEqual([]);
    }
  );

  it("refuses a template no plugin offers any more, and creates nothing", async () => {
    const digest = await approvedDigest();
    clearPluginProjectTemplateRegistry();

    await expect(
      createFolder({
        parentPath: parent,
        folderName: "my-site",
        template: { pluginId: "acme.sites", templateId: "site", digest },
      })
    ).rejects.toThrow("no longer available");
    expect(await fs.readdir(parent)).toEqual([]);
  });

  it("refuses a malformed template selection before touching disk", async () => {
    await expect(
      createFolder({
        parentPath: parent,
        folderName: "my-site",
        template: { pluginId: "acme.sites", templateId: "site", digest: 42 },
      })
    ).rejects.toThrow("Invalid project template");
    expect(await fs.readdir(parent)).toEqual([]);
  });
});
