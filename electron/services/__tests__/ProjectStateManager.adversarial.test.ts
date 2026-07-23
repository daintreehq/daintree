import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "path";
import os from "os";

const fsPromisesMock = vi.hoisted(() => ({
  readFile: vi.fn(),
  mkdir: vi.fn(),
  unlink: vi.fn(),
  rm: vi.fn(),
  rename: vi.fn(),
}));

const utilsMock = vi.hoisted(() => ({
  resilientAtomicWriteFile: vi.fn(),
  resilientRename: vi.fn(),
  resilientUnlink: vi.fn(),
}));

vi.mock("fs/promises", () => ({ default: fsPromisesMock, ...fsPromisesMock }));
vi.mock("../../utils/fs.js", () => utilsMock);
vi.mock("../../utils/performance.js", () => ({
  markPerformance: vi.fn(),
  withPerformanceSpan: vi.fn(async (_mark: string, task: () => Promise<unknown>) => task()),
}));

import { ProjectStateManager } from "../ProjectStateManager.js";
import { generateProjectId } from "../projectStorePaths.js";
import type { ProjectState } from "../../types/index.js";

function makeState(overrides?: Partial<ProjectState>): ProjectState {
  return {
    projectId: "adversarial-project",
    sidebarWidth: 350,
    terminals: [],
    ...overrides,
  };
}

describe("ProjectStateManager.clearProjectState adversarial", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    tempDir = path.join(os.tmpdir(), "daintree-clear-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-project");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("treats ENOENT from resilientUnlink as success (already gone)", async () => {
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 100 }));

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    utilsMock.resilientUnlink.mockRejectedValueOnce(enoent);

    await expect(manager.clearProjectState(projectId)).resolves.toBeUndefined();
  });

  it("invalidates cache before unlink — ENOENT path leaves no cached entry", async () => {
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 111 }));

    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    utilsMock.resilientUnlink.mockRejectedValueOnce(enoent);

    await manager.clearProjectState(projectId);

    // Subsequent read must miss the cache. resilientUnlink "succeeded"
    // (ENOENT-as-success), so the file is gone — readFile would ENOENT.
    // We assert via behavior: the cached value is NOT returned.
    // Since fs.readFile is unmocked here and the file path doesn't exist,
    // readFile throws ENOENT, which the fixed getProjectState turns into null.
    const result = await manager.getProjectState(projectId);
    expect(result).toBeNull();
  });

  it("invalidates cache before unlink — non-ENOENT error still wipes the cache", async () => {
    await manager.saveProjectState(projectId, makeState({ sidebarWidth: 222 }));

    const eacces = Object.assign(new Error("EACCES"), { code: "EACCES" });
    utilsMock.resilientUnlink.mockRejectedValueOnce(eacces);

    await expect(manager.clearProjectState(projectId)).rejects.toThrow("EACCES");

    // Even though clearProjectState rejected, the cache must be empty so
    // callers don't continue reading the presumed-deleted state for 60s.
    const result = await manager.getProjectState(projectId);
    expect(result).toBeNull();
  });

  it("re-throws non-ENOENT errors from resilientUnlink", async () => {
    await manager.saveProjectState(projectId, makeState());

    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" });
    utilsMock.resilientUnlink.mockRejectedValueOnce(eperm);

    await expect(manager.clearProjectState(projectId)).rejects.toThrow("EPERM");
  });

  it("calls resilientUnlink even when the file may not exist (no pre-flight existsSync)", async () => {
    // Pre-fix: an existsSync gate would short-circuit and never call unlink
    // when the file appeared missing — racy and inconsistent with the
    // resilient-fs layer. Post-fix: always attempt unlink; ENOENT is success.
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    utilsMock.resilientUnlink.mockRejectedValueOnce(enoent);

    await expect(manager.clearProjectState(projectId)).resolves.toBeUndefined();
    expect(utilsMock.resilientUnlink).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectStateManager.enqueueProjectStateUpdate adversarial", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    tempDir = path.join(os.tmpdir(), "daintree-queue-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-queue-project");
  });

  it("a write failure rejects its caller but does not poison subsequent queued updates", async () => {
    const epipe = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    utilsMock.resilientAtomicWriteFile.mockRejectedValueOnce(epipe);

    const first = manager.enqueueProjectStateUpdate(projectId, () =>
      makeState({ sidebarWidth: 1 })
    );
    const second = manager.enqueueProjectStateUpdate(projectId, () =>
      makeState({ sidebarWidth: 2 })
    );

    await expect(first).rejects.toThrow("EPIPE");
    await expect(second).resolves.toBeUndefined();
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(2);
  });

  it("returning null from the updater skips the disk write entirely", async () => {
    await manager.enqueueProjectStateUpdate(projectId, () => null);

    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("the second queued update reads the first's committed cache, not stale disk", async () => {
    const seen: Array<number | null> = [];

    await Promise.all([
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing?.sidebarWidth ?? null);
        return makeState({ sidebarWidth: 123 });
      }),
      manager.enqueueProjectStateUpdate(projectId, (existing) => {
        seen.push(existing?.sidebarWidth ?? null);
        return { ...existing!, sidebarWidth: existing!.sidebarWidth + 1 };
      }),
    ]);

    expect(seen).toEqual([null, 123]);
    // The second read is served from the post-save cache — only the initial
    // cache miss hits the disk.
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectStateManager.getProjectState ENOENT branch (mocked fs)", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);

    tempDir = path.join(os.tmpdir(), "daintree-get-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-get-project");
  });

  it("does not invoke resilientRename (quarantine) when readFile yields ENOENT mid-flight", async () => {
    // Deterministic TOCTOU: readFile rejects with ENOENT. The fixed catch
    // block must short-circuit BEFORE the corruption-recovery rename path,
    // proving the ENOENT branch was actually entered.
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })
    );

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("getProjectStateWithRecovery surfaces no quarantinedPath on ENOENT readFile", async () => {
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });

  it("still quarantines on a genuine corruption error (non-ENOENT)", async () => {
    // Sanity check: the ENOENT short-circuit must not swallow real corruption.
    fsPromisesMock.readFile.mockResolvedValue("{ not valid json");

    const result = await manager.getProjectState(projectId);

    expect(result).toBeNull();
    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectStateManager unreadable-session mark under rename double-fault (mocked fs)", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);
    // The quarantine rename itself fails — the double fault (unreadable AND
    // unrenameable) that would otherwise be invisible to every signal.
    utilsMock.resilientRename.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" })
    );

    tempDir = path.join(os.tmpdir(), "daintree-unreadable-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-unreadable-project");
  });

  it("marks the project when a corruption read AND its quarantine rename both fail", async () => {
    fsPromisesMock.readFile.mockResolvedValue("{ not valid json");

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    // Rename failed, so hydration gets no recovery path...
    expect(result.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    // ...but the destructive-safety mark must still be set.
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });

  it("marks the project when a future-version read AND its quarantine rename both fail", async () => {
    fsPromisesMock.readFile.mockResolvedValue(
      JSON.stringify({ _schemaVersion: 99, projectId, terminals: [] })
    );

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });
});
