import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ projectPath: "" }));

vi.mock("../../../services/ProjectStore.js", () => ({
  projectStore: {
    getProjectById: (id: string) => (id === "p1" ? { id, path: state.projectPath } : null),
  },
}));
vi.mock("../../../services/GitServiceCache.js", () => ({
  gitServiceCache: { getGitService: () => ({ listWorktrees: async () => [] }) },
}));
vi.mock("../../../services/DriveLeaseService.js", () => ({ getDriveLeaseService: vi.fn() }));
vi.mock("../../../ipc/endpointRegistry.js", () => ({ getEndpointRegistry: vi.fn() }));

import { registerRemoteService } from "../../runtime.js";
import type { HostFileService } from "../HostFileService.js";
import { projectFileRoots, recordHostBundle } from "../hostInstall.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ctx-")));
  state.projectPath = path.join(dir, "projects", "My App");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("projectFileRoots", () => {
  it("is the project's folder, and nothing for an unknown project", async () => {
    await expect(projectFileRoots("p1")).resolves.toEqual([state.projectPath]);
    await expect(projectFileRoots("p2")).resolves.toEqual([]);
  });
});

describe("recordHostBundle", () => {
  it("records the exact generated file with the running host file service", () => {
    const recordBundle = vi.fn();
    const off = registerRemoteService("hostFileService", {
      recordBundle,
    } as unknown as HostFileService);
    try {
      const bundle = path.join(dir, "My-App-main-x.xml");
      recordHostBundle({ endpointId: "e1", projectId: "p1" }, bundle);
      expect(recordBundle).toHaveBeenCalledWith({ endpointId: "e1", projectId: "p1" }, bundle);
    } finally {
      off();
    }
  });

  it("does nothing when the host isn't serving files", () => {
    expect(() => recordHostBundle({ endpointId: "e1", projectId: "p1" }, "/tmp/x")).not.toThrow();
  });
});
