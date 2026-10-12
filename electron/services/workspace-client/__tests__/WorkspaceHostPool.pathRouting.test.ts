import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessEntry } from "../types.js";

vi.mock("electron", () => ({}));
vi.mock("../../WorkspaceHostProcess.js", () => ({ WorkspaceHostProcess: class {} }));
vi.mock("../../../store.js", () => ({ store: { get: vi.fn(() => undefined), set: vi.fn() } }));
vi.mock("../../../utils/logger.js", () => ({ isValidLogOverrideLevel: () => false }));
vi.mock("../../ProjectStore.js", () => ({
  projectStore: {
    getProjectSettings: vi.fn().mockResolvedValue(null),
    resolveProjectIdForPath: vi.fn((p: string) => `id-for-${p}`),
  },
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

type Platform = "win32" | "linux";

/**
 * A pool whose `path` module and `process.platform` both belong to `platform`,
 * so `normalizeProjectPath` resolves the way it would on that OS.
 */
async function poolFor(platform: Platform) {
  vi.resetModules();
  // Both ways, so a Linux pool resolves POSIX paths on a Windows test machine too.
  vi.doMock("path", async (importOriginal) => {
    const actual = await importOriginal<typeof import("path")>();
    const flavour = platform === "win32" ? actual.win32 : actual.posix;
    return { ...flavour, default: flavour };
  });
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const { WorkspaceHostPool } = await import("../WorkspaceHostPool.js");
  return new WorkspaceHostPool({ config: {}, emit: vi.fn() });
}

function addProject(
  pool: { entries: Map<string, ProcessEntry> },
  projectPath: string
): ProcessEntry["host"] {
  const host = { isReady: () => true, label: projectPath } as unknown as ProcessEntry["host"];
  pool.entries.set(projectPath, { host, projectPath } as unknown as ProcessEntry);
  return host;
}

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.doUnmock("path");
});

describe("WorkspaceHostPool.resolveHostForPath on Windows", () => {
  it("routes a path under a project whatever its drive-letter or folder case", async () => {
    const pool = await poolFor("win32");
    const hello = addProject(pool, "C:\\dev\\projects\\hello-app");
    addProject(pool, "C:\\dev\\projects\\other-app");

    expect(pool.resolveHostForPath("c:\\dev\\projects\\hello-app\\src")).toBe(hello);
    expect(pool.resolveHostForPath("C:/Dev/Projects/Hello-App")).toBe(hello);
  });

  it("routes git's forward-slash spelling of a linked worktree to its project", async () => {
    const pool = await poolFor("win32");
    const hello = addProject(pool, "C:\\dev\\projects\\hello-app");
    addProject(pool, "C:\\dev\\projects\\other-app");
    pool.worktreePathToProject.set(
      "C:\\dev\\projects\\hello-app-worktrees\\feature-x",
      "C:\\dev\\projects\\hello-app"
    );

    expect(pool.resolveHostForPath("c:/dev/projects/hello-app-worktrees/Feature-X")).toBe(hello);
    expect(pool.resolveHostForPath("c:/dev/projects/hello-app-worktrees/feature-x/src")).toBe(
      hello
    );
  });

  it("still refuses a sibling that only shares a name prefix", async () => {
    const pool = await poolFor("win32");
    addProject(pool, "C:\\dev\\projects\\hello-app");
    addProject(pool, "C:\\dev\\projects\\other-app");
    pool.worktreePathToProject.set(
      "C:\\dev\\projects\\hello-app-worktrees\\feature-x",
      "C:\\dev\\projects\\hello-app"
    );

    expect(pool.resolveHostForPath("C:\\dev\\projects\\HELLO-APP-copy")).toBeUndefined();
    expect(
      pool.resolveHostForPath("C:\\dev\\projects\\hello-app-worktrees\\feature-x-2")
    ).toBeUndefined();
  });
});

describe("WorkspaceHostPool.resolveHostForPath on POSIX", () => {
  it("keeps project routing case-sensitive", async () => {
    const pool = await poolFor("linux");
    const appA = addProject(pool, "/repos/app-a");
    addProject(pool, "/repos/app-b");

    expect(pool.resolveHostForPath("/repos/app-a/src")).toBe(appA);
    expect(pool.resolveHostForPath("/repos/App-A/src")).toBeUndefined();
  });

  it("keeps worktree routing case-sensitive", async () => {
    const pool = await poolFor("linux");
    const appA = addProject(pool, "/repos/app-a");
    addProject(pool, "/repos/app-b");
    pool.worktreePathToProject.set("/repos/app-a-worktrees/feature", "/repos/app-a");

    expect(pool.resolveHostForPath("/repos/app-a-worktrees/feature/src")).toBe(appA);
    expect(pool.resolveHostForPath("/repos/app-a-worktrees/Feature/src")).toBeUndefined();
  });
});
