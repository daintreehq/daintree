import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn<(p: string) => boolean>(),
  readFileSync: vi.fn<(p: string, encoding: string) => string>(),
  cpSync: vi.fn<(from: string, to: string, opts?: unknown) => void>(),
  mkdirSync: vi.fn(),
  rmSync: vi.fn<(p: string, opts?: unknown) => void>(),
}));

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

const appMock = vi.hoisted(() => ({
  app: {
    isPackaged: false as boolean,
    getAppPath: vi.fn(() => "/repo"),
  },
}));

vi.mock("electron", () => ({ ...appMock }));

vi.mock("os", () => ({
  default: { homedir: () => "/home/test" },
  homedir: () => "/home/test",
}));

const resilientRenameSyncMock = vi.hoisted(() => vi.fn<(from: string, to: string) => void>());
vi.mock("../../utils/fs.js", () => ({
  resilientRenameSync: resilientRenameSyncMock,
}));

const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: { timeout?: number },
      callback: (err: Error | null) => void
    ) => void
  >()
);
vi.mock("child_process", () => ({
  default: { execFile: execFileMock },
  execFile: execFileMock,
}));

const BUNDLE_NAME = "Open in Daintree.workflow";
const TARGET = path.join("/home/test", "Library", "Services", BUNDLE_NAME);
const DEV_SOURCE = path.join("/repo", "build", "macos", BUNDLE_NAME);
const INFO_PLIST = path.join("Contents", "Info.plist");
const DOCUMENT_WFLOW = path.join("Contents", "document.wflow");

const originalPlatform = process.platform;
const originalResourcesPath = process.resourcesPath;

function setPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** Contents keyed by absolute path; anything absent reads as missing. */
function seedFiles(files: Record<string, string>): void {
  fsMock.existsSync.mockImplementation((p) =>
    Object.keys(files).some((known) => known === p || known.startsWith(`${p}${path.sep}`))
  );
  fsMock.readFileSync.mockImplementation((p) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  });
}

function sourceFiles(info: string, wflow: string): Record<string, string> {
  return {
    [path.join(DEV_SOURCE, INFO_PLIST)]: info,
    [path.join(DEV_SOURCE, DOCUMENT_WFLOW)]: wflow,
  };
}

function targetFiles(info: string, wflow: string): Record<string, string> {
  return {
    [path.join(TARGET, INFO_PLIST)]: info,
    [path.join(TARGET, DOCUMENT_WFLOW)]: wflow,
  };
}

describe("FinderQuickActionService", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("darwin");
    appMock.app.isPackaged = false;
    // clearAllMocks() wipes recorded calls but keeps implementations, so a
    // throwing rename set by one case would leak into every later one.
    resilientRenameSyncMock.mockReset();
    fsMock.readFileSync.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null));
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    Object.defineProperty(process, "resourcesPath", {
      value: originalResourcesPath,
      configurable: true,
    });
  });

  it("installs from the packaged resources dir when packaged", async () => {
    appMock.app.isPackaged = true;
    Object.defineProperty(process, "resourcesPath", {
      value: "/Apps/Daintree.app/Contents/Resources",
      configurable: true,
    });
    const packagedSource = path.join("/Apps/Daintree.app/Contents/Resources", BUNDLE_NAME);
    seedFiles({
      [path.join(packagedSource, INFO_PLIST)]: "info",
      [path.join(packagedSource, DOCUMENT_WFLOW)]: "wflow",
    });

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    expect(fsMock.cpSync.mock.calls[0][0]).toBe(packagedSource);
  });

  it("installs from the repo build dir in development", async () => {
    seedFiles(sourceFiles("info", "wflow"));

    const { install } = await import("../FinderQuickActionService.js");
    const result = await install();

    expect(fsMock.cpSync.mock.calls[0][0]).toBe(DEV_SOURCE);
    expect(result).toBe(TARGET);
  });

  it("stages a complete copy beside the target before replacing it", async () => {
    seedFiles(sourceFiles("info", "wflow"));

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    const [, stagePath, options] = fsMock.cpSync.mock.calls[0];
    // Staging must land beside the target, never inside it, and must be a full
    // recursive bundle copy — Finder reads ~/Library/Services continuously.
    expect(stagePath.startsWith(`${TARGET}.`)).toBe(true);
    expect(options).toEqual({ recursive: true });
    expect(resilientRenameSyncMock).toHaveBeenCalledWith(stagePath, TARGET);
    // The copy must COMPLETE before the rename publishes it, otherwise Finder
    // can observe a partial bundle. Order, not mere occurrence, is the contract.
    expect(fsMock.cpSync.mock.invocationCallOrder[0]).toBeLessThan(
      resilientRenameSyncMock.mock.invocationCallOrder[0]
    );
  });

  it("parks an existing install as a backup and removes it once the swap lands", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    const renames = resilientRenameSyncMock.mock.calls;
    expect(renames).toHaveLength(2);
    const [movedFrom, backupPath] = renames[0];
    expect(movedFrom).toBe(TARGET);
    expect(renames[1][1]).toBe(TARGET);
    const sweep = fsMock.rmSync.mock.calls.findIndex(([p]) => p === backupPath);
    expect(sweep).toBeGreaterThanOrEqual(0);
    // The backup may only be swept AFTER the replacement has landed — sweeping
    // first would leave nothing to roll back to if the swap then failed.
    expect(fsMock.rmSync.mock.invocationCallOrder[sweep]).toBeGreaterThan(
      resilientRenameSyncMock.mock.invocationCallOrder[1]
    );
  });

  it("restores the previous install when the swap fails", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });
    let backupPath = "";
    resilientRenameSyncMock.mockImplementation((from, to) => {
      if (from === TARGET) {
        backupPath = to;
        // Parking the target means it no longer exists under its own name;
        // the restore branch keys off exactly that.
        fsMock.existsSync.mockImplementation((p) => p !== TARGET);
        return;
      }
      if (to === TARGET && from !== backupPath) throw new Error("rename failed");
    });

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow("rename failed");

    // The parked backup must be moved back, and never deleted on the failure path.
    expect(resilientRenameSyncMock).toHaveBeenLastCalledWith(backupPath, TARGET);
    expect(fsMock.rmSync).not.toHaveBeenCalledWith(
      backupPath,
      expect.objectContaining({ recursive: true })
    );
  });

  it("leaves the backup on disk when the restore also fails", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });
    let backupPath = "";
    resilientRenameSyncMock.mockImplementation((from, to) => {
      if (from === TARGET) {
        backupPath = to;
        fsMock.existsSync.mockImplementation((p) => p !== TARGET);
        return;
      }
      // Both the swap and the restore attempt fail.
      throw new Error("rename failed");
    });

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow("rename failed");

    // The restore was attempted and itself failed, so the backup is the user's
    // only surviving copy and must not be swept.
    expect(resilientRenameSyncMock).toHaveBeenLastCalledWith(backupPath, TARGET);
    expect(backupPath).not.toBe("");
    expect(fsMock.rmSync).not.toHaveBeenCalledWith(backupPath, expect.anything());
  });

  it("cleans up the staged copy when the swap fails", async () => {
    seedFiles(sourceFiles("info", "wflow"));
    resilientRenameSyncMock.mockImplementation(() => {
      throw new Error("rename failed");
    });

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow("rename failed");

    const stagePath = fsMock.cpSync.mock.calls[0][1];
    expect(fsMock.rmSync).toHaveBeenCalledWith(stagePath, { recursive: true, force: true });
  });

  it("skips the copy entirely when both managed files already match", async () => {
    seedFiles({ ...sourceFiles("info", "wflow"), ...targetFiles("info", "wflow") });

    const { install } = await import("../FinderQuickActionService.js");
    const result = await install();

    expect(result).toBe(TARGET);
    // No copy and no rename: an unchanged bundle must not be republished under
    // Finder. (The cache flush still runs — see the failure-modes suite.)
    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(resilientRenameSyncMock).not.toHaveBeenCalled();
  });

  it("reinstalls when only one managed file drifted", async () => {
    seedFiles({ ...sourceFiles("info", "new-wflow"), ...targetFiles("info", "old-wflow") });

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    expect(fsMock.cpSync).toHaveBeenCalled();
  });

  it("flushes the Finder services cache after a fresh install", async () => {
    seedFiles(sourceFiles("info", "wflow"));

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    const [file, args, options] = execFileMock.mock.calls[0];
    expect(file.endsWith("/pbs")).toBe(true);
    // Argument array (never a shell string) and a bounded wait, so a wedged pbs
    // cannot hang the menu action.
    expect(args).toEqual(["-flush"]);
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("still resolves when the services-cache flush fails", async () => {
    seedFiles(sourceFiles("info", "wflow"));
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error("pbs exploded"))
    );

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).resolves.toBe(TARGET);
  });

  it("rejects on non-darwin platforms before touching the filesystem", async () => {
    setPlatform("win32");

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow(/macOS/);

    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
  });

  it("rejects when the bundled source is missing", async () => {
    fsMock.existsSync.mockReturnValue(false);

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow(/not found/);

    expect(fsMock.cpSync).not.toHaveBeenCalled();
  });
});

describe("FinderQuickActionService — remove", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("darwin");
    appMock.app.isPackaged = false;
    resilientRenameSyncMock.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.rmSync.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null));
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  /** Index of the first execFile call whose executable basename matches. */
  const callIndexFor = (name: string): number =>
    execFileMock.mock.calls.findIndex(([file]) => file.endsWith(`/${name}`));

  it("unregisters the bundle from Launch Services before deleting it", async () => {
    seedFiles(targetFiles("info", "wflow"));

    const { remove } = await import("../FinderQuickActionService.js");
    const result = await remove();

    expect(result).toEqual({ removed: true, path: TARGET });
    const unregister = callIndexFor("lsregister");
    expect(execFileMock.mock.calls[unregister][1]).toEqual(["-u", TARGET]);
    // Order is the contract: once the bundle is gone there is no longer a path
    // for Launch Services to be told about.
    expect(execFileMock.mock.invocationCallOrder[unregister]).toBeLessThan(
      fsMock.rmSync.mock.invocationCallOrder[0]
    );
  });

  it("deletes the whole bundle and only then refreshes Finder", async () => {
    seedFiles(targetFiles("info", "wflow"));

    const { remove } = await import("../FinderQuickActionService.js");
    await remove();

    // A .workflow is a directory; a non-recursive unlink would leave it behind.
    expect(fsMock.rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
    // Flushing before the delete would rebuild the menu from a bundle that is
    // still on disk, leaving the stale entry the removal exists to clear.
    const flush = callIndexFor("pbs");
    expect(execFileMock.mock.invocationCallOrder[flush]).toBeGreaterThan(
      fsMock.rmSync.mock.invocationCallOrder[0]
    );
  });

  it("reports the target path without touching anything when nothing is installed", async () => {
    fsMock.existsSync.mockReturnValue(false);

    const { remove } = await import("../FinderQuickActionService.js");
    const result = await remove();

    // The path still has to reach the caller: it is what the "nothing to
    // remove" message names so a user can check for themselves.
    expect(result).toEqual({ removed: false, path: TARGET });
    expect(fsMock.rmSync).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("still removes the bundle when the Launch Services unregister fails", async () => {
    seedFiles(targetFiles("info", "wflow"));
    execFileMock.mockImplementation((file, _args, _options, callback) =>
      callback(file.endsWith("/lsregister") ? new Error("lsregister exploded") : null)
    );

    const { remove } = await import("../FinderQuickActionService.js");
    await expect(remove()).resolves.toEqual({ removed: true, path: TARGET });

    // The bundle on disk is the real state; a failed cache nudge must not strand it.
    expect(fsMock.rmSync).toHaveBeenCalledWith(TARGET, { recursive: true, force: true });
  });

  it("surfaces a delete failure instead of claiming the bundle is gone", async () => {
    seedFiles(targetFiles("info", "wflow"));
    fsMock.rmSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { remove } = await import("../FinderQuickActionService.js");
    await expect(remove()).rejects.toThrow("EACCES");

    // Finder must not be told the entry is gone while the bundle is still there.
    expect(callIndexFor("pbs")).toBe(-1);
  });

  it("rejects on non-darwin platforms before touching the filesystem", async () => {
    setPlatform("win32");

    const { remove } = await import("../FinderQuickActionService.js");
    await expect(remove()).rejects.toThrow(/macOS/);

    expect(fsMock.rmSync).not.toHaveBeenCalled();
  });
});

describe("FinderQuickActionService — failure modes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    setPlatform("darwin");
    appMock.app.isPackaged = false;
    resilientRenameSyncMock.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.cpSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.rmSync.mockReset();
    execFileMock.mockImplementation((_file, _args, _options, callback) => callback(null));
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
  });

  it("leaves the previous install untouched when the copy itself fails", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });
    fsMock.cpSync.mockImplementation(() => {
      throw new Error("ENOSPC");
    });

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow("ENOSPC");

    // Nothing was renamed, so the working Quick Action is still in place.
    expect(resilientRenameSyncMock).not.toHaveBeenCalled();
    expect(fsMock.rmSync).not.toHaveBeenCalledWith(TARGET, expect.anything());
  });

  it("surfaces the backup location when the rollback also fails", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });
    let backupPath = "";
    resilientRenameSyncMock.mockImplementation((from, to) => {
      if (from === TARGET) {
        backupPath = to;
        fsMock.existsSync.mockImplementation((p) => p !== TARGET);
        return;
      }
      throw new Error("rename failed");
    });

    const { install } = await import("../FinderQuickActionService.js");
    const error = await install().then(
      () => null,
      (err: unknown) => (err instanceof Error ? err : new Error(String(err)))
    );

    // A stranded backup under a random suffix is unrecoverable unless its path
    // reaches the user, and the original cause must survive too.
    expect(backupPath).not.toBe("");
    expect(error?.message).toContain(backupPath);
    expect(error?.message).toContain("rename failed");
  });

  it("propagates a failure to create the Services directory", async () => {
    seedFiles(sourceFiles("info", "wflow"));
    fsMock.mkdirSync.mockImplementation(() => {
      throw new Error("EACCES");
    });

    const { install } = await import("../FinderQuickActionService.js");
    await expect(install()).rejects.toThrow("EACCES");

    expect(fsMock.cpSync).not.toHaveBeenCalled();
  });

  it("flushes the services cache when the bundle is already current", async () => {
    seedFiles({ ...sourceFiles("info", "wflow"), ...targetFiles("info", "wflow") });

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    // Re-running the menu action is the user's only retry after a flush that
    // failed on a previous install, so the no-copy path must still flush.
    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });
});
