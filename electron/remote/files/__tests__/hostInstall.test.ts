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
vi.mock("../../../services/copyTreeOutputFile.js", () => ({ contextDir: () => "/unused" }));
vi.mock("../../../services/DriveLeaseService.js", () => ({ getDriveLeaseService: vi.fn() }));
vi.mock("../../../ipc/endpointRegistry.js", () => ({ getEndpointRegistry: vi.fn() }));

import { grantContextBundle } from "../hostInstall.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ctx-")));
  state.projectPath = path.join(dir, "projects", "My App");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("grantContextBundle", () => {
  it("grants a fresh bundle generated from the project, and nothing else in the folder", async () => {
    const own = path.join(dir, "My-App-main-2026-09-25T00-00-00-000Z-abcd1234.xml");
    const other = path.join(dir, "Other-main-2026-09-25T00-00-00-000Z-abcd1234.xml");
    await fs.writeFile(own, "x");
    await fs.writeFile(other, "x");
    await expect(grantContextBundle("p1", own, dir)).resolves.toBe(own);
    await expect(grantContextBundle("p1", other, dir)).resolves.toBeNull();
    await expect(grantContextBundle("p2", own, dir)).resolves.toBeNull();
  });

  it("refuses stale bundles and paths outside the context folder", async () => {
    const stale = path.join(dir, "My-App-main-old.xml");
    await fs.writeFile(stale, "x");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    await expect(grantContextBundle("p1", stale, dir)).resolves.toBeNull();
    await fs.mkdir(path.join(dir, "nested"));
    const nested = path.join(dir, "nested", "My-App-x.xml");
    await fs.writeFile(nested, "x");
    await expect(grantContextBundle("p1", nested, dir)).resolves.toBeNull();
  });
});
