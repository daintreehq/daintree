import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Real files under a redirected temp root: the permission bits, the symlink
// refusal and the exclusive create are properties of the filesystem calls, so a
// mocked fs could only restate the implementation.

const clipboardMock = vi.hoisted(() => ({
  readImage: vi.fn(),
  writeImage: vi.fn(),
  writeText: vi.fn(),
  readText: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn((key: string) => `/mock/electron/${key}`) },
  clipboard: clipboardMock,
  nativeImage: { createFromBuffer: vi.fn(), createFromPath: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getFocusedWindow: vi.fn(() => null), fromWebContents: vi.fn(() => null) },
}));

vi.mock("../services/ProjectStore.js", () => ({
  projectStore: {
    getAllProjects: vi.fn(() => []),
    getCurrentProjectId: vi.fn(() => null),
  },
}));

const osMockState = vi.hoisted(() => ({ base: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:os");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  osMockState.base = nodeFs.mkdtempSync(nodePath.join(actual.tmpdir(), "clipboard-perms-"));
  return { ...actual, tmpdir: () => osMockState.base };
});

const cryptoState = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:crypto");
  return {
    ...actual,
    randomBytes: (size: number) =>
      cryptoState.id === null
        ? actual.randomBytes(size)
        : { toString: () => cryptoState.id as string },
  };
});

const { ipcMain } = await import("electron");
const { cleanupOldClipboardImages, registerClipboardHandlers } =
  await import("../ipc/handlers/clipboard.js");

const posixIt = process.platform === "win32" ? it.skip : it;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function clipboardDir(): string {
  return path.join(osMockState.base, "daintree-clipboard");
}

async function modeOf(p: string): Promise<number> {
  return (await fs.stat(p)).mode & 0o777;
}

type SaveImage = () => Promise<{ filePath: string; thumbnailDataUrl: string }>;

function saveImageHandler(): SaveImage {
  const match = vi
    .mocked(ipcMain.handle)
    .mock.calls.find(([channel]) => channel === "clipboard:save-image");
  if (!match) throw new Error("clipboard:save-image was not registered");
  const handler = match[1] as (event: unknown) => ReturnType<SaveImage>;
  return () => handler({});
}

let unregister: (() => void) | null = null;

beforeEach(async () => {
  vi.mocked(ipcMain.handle).mockClear();
  cryptoState.id = null;
  await fs.rm(clipboardDir(), { recursive: true, force: true });
  clipboardMock.readImage.mockReturnValue({
    isEmpty: () => false,
    toPNG: () => PNG,
    getSize: () => ({ width: 80, height: 40 }),
    resize: () => ({ toPNG: () => Buffer.from([0x89]) }),
  });
});

afterEach(async () => {
  unregister?.();
  unregister = null;
  vi.restoreAllMocks();
  // Let the fire-and-forget startup/save cleanups settle before the next reset.
  await new Promise((resolve) => setTimeout(resolve, 10));
});

afterAll(async () => {
  await fs.rm(osMockState.base, { recursive: true, force: true });
});

describe("clipboard image save permissions", () => {
  posixIt("creates the clipboard dir 0700 and the PNG 0600", async () => {
    unregister = registerClipboardHandlers();
    const { filePath } = await saveImageHandler()();

    expect(path.dirname(filePath)).toBe(clipboardDir());
    expect(await modeOf(clipboardDir())).toBe(0o700);
    expect(await modeOf(filePath)).toBe(0o600);
    expect(await fs.readFile(filePath)).toEqual(PNG);
  });

  posixIt("tightens a clipboard dir an earlier version left at 0755", async () => {
    await fs.mkdir(clipboardDir(), { mode: 0o755 });
    await fs.chmod(clipboardDir(), 0o755);

    unregister = registerClipboardHandlers();
    await saveImageHandler()();

    expect(await modeOf(clipboardDir())).toBe(0o700);
  });

  posixIt("refuses a symlink planted at the clipboard dir name", async () => {
    const elsewhere = path.join(osMockState.base, "someone-elses-dir");
    await fs.mkdir(elsewhere, { mode: 0o777 });
    await fs.symlink(elsewhere, clipboardDir());

    unregister = registerClipboardHandlers();
    await expect(saveImageHandler()()).rejects.toThrow();

    expect(await fs.readdir(elsewhere)).toEqual([]);
    expect((await fs.lstat(clipboardDir())).isSymbolicLink()).toBe(true);
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  posixIt("refuses to overwrite a file already sitting at the new name", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    cryptoState.id = "abc123";
    await fs.mkdir(clipboardDir(), { mode: 0o700 });
    const planted = path.join(clipboardDir(), "clipboard-1700000000000-abc123.png");
    await fs.writeFile(planted, "planted");

    unregister = registerClipboardHandlers();
    await expect(saveImageHandler()()).rejects.toMatchObject({ code: "EEXIST" });

    expect(await fs.readFile(planted, "utf8")).toBe("planted");
  });

  posixIt("refuses a final-component symlink at the new name", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    cryptoState.id = "abc123";
    await fs.mkdir(clipboardDir(), { mode: 0o700 });
    const target = path.join(osMockState.base, "target.png");
    await fs.writeFile(target, "original");
    await fs.symlink(target, path.join(clipboardDir(), "clipboard-1700000000000-abc123.png"));

    unregister = registerClipboardHandlers();
    await expect(saveImageHandler()()).rejects.toThrow();

    expect(await fs.readFile(target, "utf8")).toBe("original");
    await fs.rm(target, { force: true });
  });
});

describe("clipboard cleanup through a planted symlink", () => {
  posixIt("never unlinks files in the directory a symlinked dir points at", async () => {
    const elsewhere = path.join(osMockState.base, "victim");
    await fs.mkdir(elsewhere);
    const victim = path.join(elsewhere, "clipboard-1-aaaaaa.png");
    await fs.writeFile(victim, "keep me");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(victim, old, old);
    await fs.symlink(elsewhere, clipboardDir());

    await cleanupOldClipboardImages();

    expect(await fs.readFile(victim, "utf8")).toBe("keep me");
    await fs.rm(elsewhere, { recursive: true, force: true });
  });

  posixIt("never sweeps a real directory owned by another user", async () => {
    await fs.mkdir(clipboardDir(), { mode: 0o700 });
    const stale = path.join(clipboardDir(), "clipboard-1-aaaaaa.png");
    await fs.writeFile(stale, "not mine");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);

    await cleanupOldClipboardImages();

    expect(await fs.readFile(stale, "utf8")).toBe("not mine");
  });
});
