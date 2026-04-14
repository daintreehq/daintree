import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { isFile: () => boolean }>(),
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

function mockExistingFiles(paths: string[]) {
  const set = new Set(paths);
  fsMock.statSync.mockImplementation((p: string) => {
    if (set.has(p)) return { isFile: () => true };
    throw new Error("ENOENT");
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
    execaMock.execa.mockReturnValue({ unref: vi.fn(), catch: vi.fn() });
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

  it("custom template with whitespace splits args naively — file path with spaces is fragmented", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file with spaces.ts", 12, 5, {
      id: "custom",
      customCommand: "code",
      customTemplate: "--goto {file}:{line}:{col}",
    });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const [binary, args] = execaMock.execa.mock.calls[0];
    expect(binary).toBe("code");
    expect(args).toEqual(["--goto", "/abs/file", "with", "spaces.ts:12:5"]);
  });

  it("VISUAL='code --reuse-window' is passed as a single binary string, not parsed", async () => {
    process.env.VISUAL = "code --reuse-window";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "code --reuse-window",
      ["/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
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
    process.env.VISUAL = "vim";
    const { openFile } = await loadModule();

    await openFile("/repo/../secret.txt");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "vim",
      ["/repo/../secret.txt"],
      expect.any(Object)
    );
  });

  it("custom editor with empty command string falls through to env/discovery instead of silently succeeding", async () => {
    process.env.VISUAL = "vim";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 1, 1, {
      id: "custom",
      customCommand: "   ",
      customTemplate: "{file}",
    });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][0]).toBe("vim");
  });

  it("macOS 'open' fallback is used only on darwin when no editor resolves", async () => {
    setPlatform("darwin");
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith(
      "open",
      ["/abs/file.ts"],
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
