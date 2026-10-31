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

  it("marks a non-ENOENT read failure (EACCES) unreadable without quarantining it", async () => {
    // A read errno other than ENOENT must not take the empty-state
    // short-circuit — otherwise an unreadable project would be treated as
    // authoritatively empty and lose its restore files. Nor is it evidence the
    // bytes are bad, so the file stays where it is rather than being moved to
    // .corrupted (#15613).
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" })
    );

    const result = await manager.getProjectStateWithRecovery(projectId);

    expect(result.state).toBeNull();
    expect(result.quarantinedPath).toBeUndefined();
    expect(result.unreadableInPlace).toBe(true);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
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
    // ...but the destructive-safety mark must still be set...
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
    // ...and the null is not "nothing saved": the file is still there (#15613).
    expect(result.unreadableInPlace).toBe(true);
    await expect(
      manager.enqueueProjectStateUpdate(projectId, (existing) => existing ?? makeState())
    ).rejects.toThrow(/leaving it untouched/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
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
    expect(result.unreadableInPlace).toBe(true);
    await expect(
      manager.enqueueProjectStateUpdate(projectId, (existing) => existing ?? makeState())
    ).rejects.toThrow(/leaving it untouched/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });
});

describe("ProjectStateManager late reads racing saves and clears (mocked fs)", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  const terminal = (id: string) => ({ id, title: id, location: "grid" as const, cwd: "/tmp" });
  const oldBytes = () =>
    JSON.stringify({
      _schemaVersion: 1,
      sidebarWidth: 350,
      terminals: [terminal("t1"), terminal("t2")],
    });

  /** Hold the next readFile open until the test releases it with the given bytes. */
  function holdNextRead(): (result: string | Error) => void {
    let settle!: (result: string | Error) => void;
    fsPromisesMock.readFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve, reject) => {
          settle = (result) => (result instanceof Error ? reject(result) : resolve(result));
        })
    );
    return (result) => settle(result);
  }

  function lastWrittenTerminalIds(): string[] {
    const calls = utilsMock.resilientAtomicWriteFile.mock.calls;
    const payload = JSON.parse(calls[calls.length - 1][1] as string);
    return payload.terminals.map((t: { id: string }) => t.id);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    fsPromisesMock.mkdir.mockResolvedValue(undefined);
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    tempDir = path.join(os.tmpdir(), "daintree-late-read-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-late-read-project");
  });

  afterEach(() => {
    manager.dispose();
  });

  it("a read that finishes after a save does not replace the saved state", async () => {
    const release = holdNextRead();
    const lateRead = manager.getProjectState(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    await manager.saveProjectState(projectId, makeState({ terminals: [terminal("new")] }));
    release(oldBytes());

    // The late reader is handed the newer state too, not the bytes it read.
    expect((await lateRead)?.terminals.map((t) => t.id)).toEqual(["new"]);
    expect((await manager.getProjectState(projectId))?.terminals.map((t) => t.id)).toEqual(["new"]);

    await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
      ...existing!,
      sidebarWidth: 400,
    }));
    expect(lastWrittenTerminalIds()).toEqual(["new"]);
  });

  it("a read that finishes after a clear does not resurrect the cleared panels", async () => {
    const release = holdNextRead();
    const lateRead = manager.getProjectState(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    await manager.clearProjectState(projectId);
    release(oldBytes());

    // The file is gone, so the retried read reports no state.
    expect(await lateRead).toBeNull();
    expect(await manager.getProjectState(projectId)).toBeNull();

    await manager.enqueueProjectStateUpdate(projectId, (existing) =>
      makeState({ ...existing, sidebarWidth: 400 })
    );
    expect(lastWrittenTerminalIds()).toEqual([]);
  });

  it("a read that finishes after a global invalidation does not repopulate the cache", async () => {
    const release = holdNextRead();
    const lateRead = manager.getProjectState(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    manager.invalidateProjectStateCache();
    release(oldBytes());

    // The retry re-reads disk (ENOENT here) rather than trusting the stale bytes.
    expect(await lateRead).toBeNull();
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(2);
  });

  it("a read that opened the file during a clear that ends in ENOENT is still retired", async () => {
    let finishUnlink!: (error: Error) => void;
    utilsMock.resilientUnlink.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (finishUnlink = reject))
    );
    const clearing = manager.clearProjectState(projectId);

    // Starts after the clear's eager invalidation, so only its completion can fence it.
    const release = holdNextRead();
    const lateRead = manager.getProjectState(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    finishUnlink(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await clearing;
    release(oldBytes());

    expect(await lateRead).toBeNull();
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(2);
  });

  it("a read that outlives a failed save re-reads rather than trust its bytes", async () => {
    const release = holdNextRead();
    const lateRead = manager.getProjectState(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    // The atomic write can rename into place and then fail its directory sync.
    utilsMock.resilientAtomicWriteFile.mockRejectedValueOnce(
      Object.assign(new Error("EIO"), { code: "EIO" })
    );
    await expect(
      manager.saveProjectState(projectId, makeState({ terminals: [terminal("new")] }))
    ).rejects.toThrow("EIO");
    release(oldBytes());

    expect(await lateRead).toBeNull();
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(2);
  });

  it("a read superseded on every attempt fails rather than return stale state", async () => {
    fsPromisesMock.readFile.mockImplementation(async () => {
      manager.invalidateProjectStateCache(projectId);
      return oldBytes();
    });

    await expect(manager.getProjectState(projectId)).rejects.toThrow(/kept changing/);
    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(3);

    // The queued update never sees the stale snapshot, so nothing is written.
    await expect(
      manager.enqueueProjectStateUpdate(projectId, (existing) => existing)
    ).rejects.toThrow(/kept changing/);
    expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
  });

  it("a stale read of a corrupt file does not quarantine the file a newer save wrote", async () => {
    const release = holdNextRead();
    const lateRead = manager.getProjectStateWithRecovery(projectId);
    await vi.waitFor(() => expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(1));

    await manager.saveProjectState(projectId, makeState({ terminals: [terminal("new")] }));
    release("{ not valid json");

    const result = await lateRead;
    expect(result.state?.terminals.map((t) => t.id)).toEqual(["new"]);
    expect(result.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });
});

describe("ProjectStateManager never writes over an unpreserved state file (#15613)", () => {
  let tempDir: string;
  let manager: ProjectStateManager;
  let projectId: string;

  const terminal = (id: string) => ({ id, title: id, location: "grid" as const, cwd: "/tmp" });
  const validBytes = () =>
    JSON.stringify({ _schemaVersion: 1, sidebarWidth: 350, terminals: [terminal("t1")] });
  const renameDenied = () => Object.assign(new Error("EBUSY: locked"), { code: "EBUSY" });

  beforeEach(() => {
    vi.clearAllMocks();
    utilsMock.resilientAtomicWriteFile.mockResolvedValue(undefined);
    utilsMock.resilientUnlink.mockResolvedValue(undefined);
    utilsMock.resilientRename.mockRejectedValue(renameDenied());
    fsPromisesMock.mkdir.mockResolvedValue(undefined);

    tempDir = path.join(os.tmpdir(), "daintree-unpreserved-adv");
    manager = new ProjectStateManager(tempDir);
    projectId = generateProjectId("/test/adversarial-unpreserved-project");
  });

  afterEach(() => {
    manager.dispose();
  });

  const unreadable: Array<[string, () => void]> = [
    ["malformed JSON", () => fsPromisesMock.readFile.mockResolvedValue("{ not valid json")],
    [
      "a future-schema file",
      () =>
        fsPromisesMock.readFile.mockResolvedValue(
          JSON.stringify({ _schemaVersion: 99, terminals: [terminal("t1")] })
        ),
    ],
    [
      "a non-ENOENT read error",
      () =>
        fsPromisesMock.readFile.mockRejectedValue(
          Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
        ),
    ],
  ];

  it.each(unreadable)(
    "%s with a rejected rename refuses a queued update instead of saving an empty state",
    async (_label, arrange) => {
      arrange();

      const read = await manager.getProjectStateWithRecovery(projectId);
      expect(read.state).toBeNull();
      expect(read.quarantinedPath).toBeUndefined();
      expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);

      // The hydrate seed's updater shape: build a fresh state on a null base.
      const updater = vi.fn((existing: ProjectState | null) => existing ?? makeState());
      await expect(manager.enqueueProjectStateUpdate(projectId, updater)).rejects.toThrow(
        /leaving it untouched/
      );
      expect(updater).not.toHaveBeenCalled();
      expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
    }
  );

  it.each(unreadable)(
    "%s with a rejected rename refuses a direct save",
    async (_label, arrange) => {
      arrange();

      expect(await manager.getProjectState(projectId)).toBeNull();
      await expect(manager.saveProjectState(projectId, makeState())).rejects.toThrow(
        /leaving it untouched/
      );
      expect(utilsMock.resilientAtomicWriteFile).not.toHaveBeenCalled();
    }
  );

  it("does not move a file aside for an operational read error", async () => {
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
    );
    utilsMock.resilientRename.mockResolvedValue(undefined);

    const read = await manager.getProjectStateWithRecovery(projectId);

    expect(read.state).toBeNull();
    expect(read.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
  });

  it("retries a transient read error before giving up on the file", async () => {
    fsPromisesMock.readFile
      .mockRejectedValueOnce(Object.assign(new Error("EBUSY: busy"), { code: "EBUSY" }))
      .mockRejectedValueOnce(Object.assign(new Error("EMFILE: too many"), { code: "EMFILE" }))
      .mockResolvedValue(validBytes());

    const read = await manager.getProjectStateWithRecovery(projectId);

    expect(read.state?.terminals.map((t) => t.id)).toEqual(["t1"]);
    expect(read.quarantinedPath).toBeUndefined();
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
    expect(manager.wasStateUnreadableThisSession(projectId)).toBe(false);
  });

  it.each(unreadable)(
    "%s does not cache a null that masks the next successful read",
    async (_label, arrange) => {
      arrange();
      expect(await manager.getProjectState(projectId)).toBeNull();

      fsPromisesMock.readFile.mockReset();
      fsPromisesMock.readFile.mockResolvedValue(validBytes());

      expect((await manager.getProjectState(projectId))?.terminals.map((t) => t.id)).toEqual([
        "t1",
      ]);
      // Readable again, so queued updates build on what is really there.
      await manager.enqueueProjectStateUpdate(projectId, (existing) => ({
        ...existing!,
        sidebarWidth: 400,
      }));
      const calls = utilsMock.resilientAtomicWriteFile.mock.calls;
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0][1] as string).terminals.map((t: { id: string }) => t.id)).toEqual(
        ["t1"]
      );
      // The session mark stays: the orphan sweep still must not trust this project.
      expect(manager.wasStateUnreadableThisSession(projectId)).toBe(true);
    }
  );

  it("writes again once a later read manages to move the file aside", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      fsPromisesMock.readFile.mockResolvedValue("{ not valid json");
      expect(await manager.getProjectState(projectId)).toBeNull();
      expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);

      // The lock clears, but the failed rename is not retried straight away.
      utilsMock.resilientRename.mockResolvedValue(undefined);
      const cooling = await manager.getProjectStateWithRecovery(projectId);
      expect(cooling.unreadableInPlace).toBe(true);
      expect(utilsMock.resilientRename).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 30_001);
      const read = await manager.getProjectStateWithRecovery(projectId);
      expect(read.state).toBeNull();
      expect(read.quarantinedPath).toMatch(/\.corrupted\.\d+$/);
      expect(read.unreadableInPlace).toBeUndefined();
      expect(utilsMock.resilientRename).toHaveBeenCalledTimes(2);

      // Moved aside, so the live path is genuinely empty and a fresh state may land.
      fsPromisesMock.readFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      );
      await manager.enqueueProjectStateUpdate(projectId, (existing) => existing ?? makeState());
      expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a rename that finds the file already gone as moved aside", async () => {
    fsPromisesMock.readFile.mockResolvedValue("{ not valid json");
    // A concurrent read won the rename; this one's source no longer exists.
    utilsMock.resilientRename.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" })
    );

    const read = await manager.getProjectStateWithRecovery(projectId);

    expect(read.state).toBeNull();
    expect(read.unreadableInPlace).toBeUndefined();
    await manager.enqueueProjectStateUpdate(projectId, (existing) => existing ?? makeState());
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing saves across a cache invalidation, and lets a clear release them", async () => {
    fsPromisesMock.readFile.mockResolvedValue("{ not valid json");
    expect(await manager.getProjectState(projectId)).toBeNull();

    manager.invalidateProjectStateCache(projectId);
    await expect(manager.saveProjectState(projectId, makeState())).rejects.toThrow(
      /leaving it untouched/
    );

    await manager.clearProjectState(projectId);
    await manager.saveProjectState(projectId, makeState());
    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
  });

  it("only blocks the project whose file is unreadable", async () => {
    const otherId = generateProjectId("/test/adversarial-unpreserved-other");
    fsPromisesMock.readFile.mockImplementation(async (file: string) =>
      file.includes(projectId) ? "{ not valid json" : validBytes()
    );

    expect(await manager.getProjectState(projectId)).toBeNull();
    await manager.enqueueProjectStateUpdate(otherId, (existing) => ({
      ...existing!,
      sidebarWidth: 400,
    }));

    expect(utilsMock.resilientAtomicWriteFile).toHaveBeenCalledTimes(1);
    expect(utilsMock.resilientAtomicWriteFile.mock.calls[0][0]).toContain(otherId);
  });

  it("gives up on a transient read error that outlasts its retries without moving the file", async () => {
    fsPromisesMock.readFile.mockRejectedValue(
      Object.assign(new Error("EBUSY: busy"), { code: "EBUSY" })
    );
    utilsMock.resilientRename.mockResolvedValue(undefined);

    const read = await manager.getProjectStateWithRecovery(projectId);

    expect(fsPromisesMock.readFile).toHaveBeenCalledTimes(3);
    expect(read.unreadableInPlace).toBe(true);
    expect(utilsMock.resilientRename).not.toHaveBeenCalled();
  });
});
