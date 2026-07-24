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
    // Rename happens after the copy, so Finder never sees a partial bundle.
    expect(resilientRenameSyncMock).toHaveBeenCalledWith(stagePath, TARGET);
  });

  it("parks an existing install as a backup and removes it once the swap lands", async () => {
    seedFiles({ ...sourceFiles("new", "new-wflow"), ...targetFiles("old", "old-wflow") });

    const { install } = await import("../FinderQuickActionService.js");
    await install();

    const renames = resilientRenameSyncMock.mock.calls;
    expect(renames).toHaveLength(2);
    const [movedFrom, backupPath] = renames[0];
    expect(movedFrom).toBe(TARGET);
    // Backup is parked before the replacement moves in, then swept afterwards.
    expect(renames[1][1]).toBe(TARGET);
    expect(fsMock.rmSync).toHaveBeenCalledWith(backupPath, { recursive: true, force: true });
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
    expect(fsMock.cpSync).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
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
