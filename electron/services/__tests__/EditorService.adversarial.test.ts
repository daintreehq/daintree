import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockExecaChildren } from "./helpers/editorChild.js";

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { isFile: () => boolean }>(),
  accessSync: vi.fn<(path: string, mode?: number) => void>(),
  constants: { X_OK: 1 },
}));

const execaMock = vi.hoisted(() => ({ execa: vi.fn() }));
const shellMock = vi.hoisted(() => ({ openPath: vi.fn<(p: string) => Promise<string>>() }));

vi.mock("fs", () => ({ default: fsMock, ...fsMock }));
vi.mock("os", () => ({
  default: { homedir: () => "/Users/testuser" },
  homedir: () => "/Users/testuser",
}));
vi.mock("electron", () => ({ shell: shellMock }));
vi.mock("execa", () => ({ execa: execaMock.execa }));

const originalPlatform = process.platform;
let originalPATH: string | undefined;
let originalVISUAL: string | undefined;
let originalEDITOR: string | undefined;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

function mockExistingFiles(paths: string[], options: { executable?: boolean } = {}) {
  const set = new Set(paths);
  const executable = options.executable ?? true;
  fsMock.statSync.mockImplementation((p: string) => {
    if (set.has(p)) return { isFile: () => true };
    throw new Error("ENOENT");
  });
  fsMock.accessSync.mockImplementation((p: string) => {
    if (set.has(p) && executable) return;
    throw new Error("EACCES");
  });
}

type EditorModule = typeof import("../EditorService.js");

async function loadModule(): Promise<EditorModule> {
  return (await import("../EditorService.js")) as EditorModule;
}

describe("EditorService adversarial", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPATH = process.env.PATH;
    originalVISUAL = process.env.VISUAL;
    originalEDITOR = process.env.EDITOR;
    process.env.PATH = "/usr/local/bin";
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    setPlatform("linux");
    shellMock.openPath.mockResolvedValue("");
    mockExecaChildren(execaMock.execa, ["spawned"]);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPATH;
    if (originalVISUAL === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVISUAL;
    if (originalEDITOR === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEDITOR;
  });

  it("rejects non-absolute paths before attempting any launcher", async () => {
    const { openFile } = await loadModule();

    await expect(openFile("relative/file.ts")).rejects.toThrow(/absolute paths/i);
    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("re-resolves the configured editor at openFile time; stale discovery is not cached", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { discover, openFile } = await loadModule();

    const first = discover();
    expect(first.find((e) => e.id === "vscode")?.available).toBe(true);

    mockExistingFiles([]);

    await openFile("/abs/file.ts", 10, 2, { id: "vscode" });

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("launches Antigravity IDE from its bundle, passing the spaced launcher path unquoted", async () => {
    const launcher = "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide";
    setPlatform("darwin");
    process.env.PATH = "";
    mockExistingFiles([launcher]);
    const child = { unref: vi.fn(), catch: vi.fn() };
    execaMock.execa.mockReturnValue(child);

    const { openFile } = await loadModule();
    await openFile("/repo with spaces/src/app.ts", 12, 5, { id: "antigravity-ide" });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const [binary, args, options] = execaMock.execa.mock.calls[0];
    expect(binary).toBe(launcher);
    expect(args).toEqual(["--goto", "/repo with spaces/src/app.ts:12:5"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", cleanup: false });
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.catch).toHaveBeenCalledWith(expect.any(Function));
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("omits the column from the Antigravity IDE --goto target when only a line is given", async () => {
    const launcher = "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide";
    setPlatform("darwin");
    process.env.PATH = "";
    mockExistingFiles([launcher]);

    const { openFile } = await loadModule();
    await openFile("/repo/src/app.ts", 12, undefined, { id: "antigravity-ide" });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][1]).toEqual(["--goto", "/repo/src/app.ts:12"]);
  });

  it("custom template tokenizes before substitution — file path with spaces stays one arg", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file with spaces.ts", 12, 5, {
      id: "custom",
      customCommand: "code",
      customTemplate: "--goto {file}:{line}:{col}",
    });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const [binary, args] = execaMock.execa.mock.calls[0];
    expect(binary).toBe("code");
    expect(args).toEqual(["--goto", "/abs/file with spaces.ts:12:5"]);
  });

  it("VISUAL='code --reuse-window' is split into binary + args", async () => {
    process.env.VISUAL = "code --reuse-window";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      ["--reuse-window", "/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
  });

  it("VISUAL with quoted Windows-style path preserves the path as a single binary token", async () => {
    process.env.VISUAL = '"C:\\Program Files\\Sublime Text\\subl.exe" -w';
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "C:\\Program Files\\Sublime Text\\subl.exe",
      ["-w", "/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
  });

  it("VISUAL=vim is skipped (terminal editor) and falls through to shell.openPath", async () => {
    process.env.VISUAL = "vim";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("VISUAL='/usr/bin/nvim' with absolute path is still detected as a terminal editor and skipped", async () => {
    process.env.VISUAL = "/usr/bin/nvim";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("VISUAL=vim falls through to EDITOR=code instead of dropping it", async () => {
    process.env.VISUAL = "vim";
    process.env.EDITOR = "code";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      ["/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
  });

  it("VISUAL=nvim.exe on Windows is detected as a terminal editor and skipped", async () => {
    setPlatform("win32");
    process.env.VISUAL = "nvim.exe";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("custom template substitutes every occurrence of {file}/{line}/{col}, not just the first", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 10, 2, {
      id: "custom",
      customCommand: "code",
      customTemplate: "--arg={file}:{line}:{col}:{file}",
    });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const [, args] = execaMock.execa.mock.calls[0];
    expect(args).toEqual(["--arg=/abs/file.ts:10:2:/abs/file.ts"]);
  });

  it("findBinaryInPath skips files that exist but are not executable on Unix", async () => {
    mockExistingFiles(["/usr/local/bin/code"], { executable: false });
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 1, 1, { id: "vscode" });

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("falls through to shell.openPath and wraps its error string when every launcher fails", async () => {
    execaMock.execa.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    shellMock.openPath.mockResolvedValue("Access denied");
    process.env.VISUAL = "nope";
    const { openFile } = await loadModule();

    await expect(openFile("/abs/file.ts")).rejects.toThrow("Failed to open file: Access denied");
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("accepts absolute paths that traverse outside any project root (no traversal guard)", async () => {
    process.env.VISUAL = "code";
    const { openFile } = await loadModule();

    await openFile("/repo/../secret.txt");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      ["/repo/../secret.txt"],
      expect.any(Object)
    );
  });

  it("custom editor with empty command string falls through to env/discovery instead of silently succeeding", async () => {
    process.env.VISUAL = "code";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 1, 1, {
      id: "custom",
      customCommand: "   ",
      customTemplate: "{file}",
    });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][0]).toBe("code");
  });

  it("macOS 'open -t' fallback is used only on darwin when no editor resolves", async () => {
    setPlatform("darwin");
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "open",
      ["-t", "/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("on non-darwin with no editors available, shell.openPath is the only fallback", async () => {
    setPlatform("linux");
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });
});
