import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { mkdir, mkdtemp, rm } from "fs/promises";
import path from "path";
import os from "os";
import stubbornFs from "stubborn-fs";

const { mockedOpen, mockedSync, mockedClose, syncTap } = vi.hoisted(() => ({
  mockedOpen: vi.fn(),
  mockedSync: vi.fn(),
  mockedClose: vi.fn(),
  syncTap: { writeFileSync: vi.fn(), openSync: vi.fn(), fsyncSync: vi.fn() },
}));

vi.mock("fs/promises", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, open: mockedOpen };
});

// Each tap records the call and then defers to the real fs, so the sync writer
// still lands a real file the tests can read back. A tap that throws stops the
// real call, which is how a failing step is injected.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      syncTap.writeFileSync(...args);
      return actual.writeFileSync(...args);
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      syncTap.openSync(...args);
      return actual.openSync(...args);
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      syncTap.fsyncSync(...args);
      return actual.fsyncSync(...args);
    },
  };
});

import { resilientAtomicWriteFile, resilientAtomicWriteFileSync } from "../fs.js";

describe("syncParentDirectory", () => {
  let tmpDir: string;
  let platformRestore: (() => void) | undefined;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-test-"));
    vi.clearAllMocks();
    mockedOpen.mockResolvedValue({ sync: mockedSync, close: mockedClose });
    mockedSync.mockResolvedValue(undefined);
    mockedClose.mockResolvedValue(undefined);
    if (process.platform === "win32") {
      platformRestore = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    platformRestore?.();
    platformRestore = undefined;
    vi.restoreAllMocks();
  });

  it("opens parent dir, syncs, and closes after rename", async () => {
    const calls: string[] = [];
    mockedSync.mockImplementation(() => {
      calls.push("dir-sync");
      return Promise.resolve();
    });

    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).toHaveBeenCalledWith(tmpDir, "r");
    expect(mockedSync).toHaveBeenCalled();
    expect(mockedClose).toHaveBeenCalled();
    // Sync must happen after rename (rename occurs before syncParentDirectory call)
    expect(calls).toEqual(["dir-sync"]);
  });

  it("propagates sync error and still closes handle", async () => {
    mockedSync.mockRejectedValue(new Error("EIO: fsync failed"));

    const target = path.join(tmpDir, "test.json");
    await expect(resilientAtomicWriteFile(target, "data")).rejects.toThrow("EIO");

    expect(mockedClose).toHaveBeenCalled();
  });

  it("treats unsupported directory fsync as best-effort", async () => {
    const error = Object.assign(new Error("EPERM: operation not permitted, fsync"), {
      code: "EPERM",
    });
    mockedSync.mockRejectedValue(error);

    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data");

    expect(mockedClose).toHaveBeenCalled();
  });

  it("opens correct parent dir for nested paths", async () => {
    const nestedDir = path.join(tmpDir, "sub", "nested");
    const target = path.join(nestedDir, "file.json");

    await mkdir(nestedDir, { recursive: true });
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).toHaveBeenCalledWith(nestedDir, "r");
  });
});

describe("syncParentDirectory win32 skip", () => {
  let tmpDir: string;
  let platformRestore: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-win-test-"));
    vi.clearAllMocks();
    platformRestore = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    platformRestore();
    vi.restoreAllMocks();
  });

  it("skips dir fsync on win32", async () => {
    const target = path.join(tmpDir, "test.json");
    await resilientAtomicWriteFile(target, "data");

    expect(mockedOpen).not.toHaveBeenCalled();
  });
});

describe("resilientAtomicWriteFileSync durability", () => {
  let tmpDir: string;
  let target: string;
  const isWindows = process.platform === "win32";

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-dirsync-sync-test-"));
    target = path.join(tmpDir, "test.json");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function tempPathsWritten(): string[] {
    return syncTap.writeFileSync.mock.calls.map((call) => call[0] as string);
  }

  function flushOptionsWritten(): unknown[] {
    return syncTap.writeFileSync.mock.calls.map((call) => (call[2] as { flush?: unknown }).flush);
  }

  // A real directory fsync needs a directory fd, which Windows cannot open.
  it.skipIf(isWindows)(
    "flushes the temp file and syncs the parent after the rename by default",
    () => {
      let contentAtDirSync: string | null = null;
      syncTap.fsyncSync.mockImplementationOnce(() => {
        contentAtDirSync = readFileSync(target, "utf8");
      });

      resilientAtomicWriteFileSync(target, "data");
      resilientAtomicWriteFileSync(target, "again", "utf-8", { durable: true });

      expect(flushOptionsWritten()).toEqual([true, true]);
      expect(syncTap.openSync.mock.calls).toEqual([
        [tmpDir, "r"],
        [tmpDir, "r"],
      ]);
      expect(syncTap.fsyncSync).toHaveBeenCalledTimes(2);
      expect(contentAtDirSync).toBe("data");
    }
  );

  it("skips the temp-file flush and the parent sync when not durable", () => {
    resilientAtomicWriteFileSync(target, "data", "utf-8", { durable: false });

    expect(flushOptionsWritten()).toEqual([false]);
    expect(syncTap.openSync).not.toHaveBeenCalled();
    expect(syncTap.fsyncSync).not.toHaveBeenCalled();
    expect(readFileSync(target, "utf8")).toBe("data");
    expect(readdirSync(tmpDir)).toEqual(["test.json"]);
  });

  it("writes each non-durable replacement through its own sibling temp file", () => {
    resilientAtomicWriteFileSync(target, "first", "utf-8", { durable: false });
    resilientAtomicWriteFileSync(target, "second", "utf-8", { durable: false });

    const temps = tempPathsWritten();
    expect(temps).toHaveLength(2);
    expect(new Set(temps).size).toBe(2);
    for (const temp of temps) {
      expect(path.dirname(temp)).toBe(tmpDir);
      expect(path.basename(temp).startsWith("test.json.")).toBe(true);
      expect(temp.endsWith(".tmp")).toBe(true);
    }
    expect(readFileSync(target, "utf8")).toBe("second");
    expect(readdirSync(tmpDir)).toEqual(["test.json"]);
  });

  it("renames through the resilient retry on both paths", () => {
    const renameSpy = vi.spyOn(stubbornFs.retry, "renameSync");

    resilientAtomicWriteFileSync(target, "durable");
    resilientAtomicWriteFileSync(target, "not durable", "utf-8", { durable: false });

    expect(renameSpy).toHaveBeenCalledTimes(2);
    expect(readFileSync(target, "utf8")).toBe("not durable");
  });

  it("removes the temp file and rethrows when a non-durable rename fails", () => {
    // A non-empty directory at the target refuses the rename on every platform.
    mkdirSync(target);
    writeFileSync(path.join(target, "keep"), "x");
    syncTap.writeFileSync.mockClear();

    expect(() =>
      resilientAtomicWriteFileSync(target, "data", "utf-8", { durable: false })
    ).toThrow();

    expect(tempPathsWritten()).toHaveLength(1);
    expect(readdirSync(tmpDir)).toEqual(["test.json"]);
  });

  it("removes the temp file and rethrows when a non-durable write fails", () => {
    syncTap.writeFileSync.mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    expect(() => resilientAtomicWriteFileSync(target, "data", "utf-8", { durable: false })).toThrow(
      "ENOSPC"
    );

    expect(readdirSync(tmpDir)).toEqual([]);
  });

  describe("on Windows", () => {
    let restorePlatform: () => void;

    beforeEach(() => {
      const spy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      restorePlatform = () => spy.mockRestore();
    });

    afterEach(() => {
      restorePlatform();
    });

    it("never syncs the parent, so durability only decides the flush", () => {
      resilientAtomicWriteFileSync(target, "durable");
      resilientAtomicWriteFileSync(target, "not durable", "utf-8", { durable: false });

      expect(flushOptionsWritten()).toEqual([true, false]);
      expect(syncTap.openSync).not.toHaveBeenCalled();
      expect(readFileSync(target, "utf8")).toBe("not durable");
    });
  });
});
