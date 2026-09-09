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
    // clearAllMocks() clears calls but keeps implementations, so a previous test's
    // "installed" filesystem would otherwise persist into this one.
    mockExistingFiles([]);
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

  const ANTIGRAVITY_LAUNCHER =
    "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide";

  it.each([
    {
      what: "line and column",
      line: 12 as number | undefined,
      col: 5 as number | undefined,
      expected: ["--goto", "/repo with spaces/src/app.ts:12:5"],
    },
    {
      what: "a line only",
      line: 12 as number | undefined,
      col: undefined,
      expected: ["--goto", "/repo with spaces/src/app.ts:12"],
    },
    {
      what: "no location",
      line: undefined,
      col: undefined,
      expected: ["--goto", "/repo with spaces/src/app.ts"],
    },
  ])("builds Antigravity IDE argv for $what", async ({ line, col, expected }) => {
    setPlatform("darwin");
    process.env.PATH = "";
    mockExistingFiles([ANTIGRAVITY_LAUNCHER]);

    const { openFile } = await loadModule();
    await openFile("/repo with spaces/src/app.ts", line, col, { id: "antigravity-ide" });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][1]).toEqual(expected);
  });

  it("launches Antigravity IDE from its bundle, passing the spaced launcher path unquoted", async () => {
    setPlatform("darwin");
    process.env.PATH = "";
    mockExistingFiles([ANTIGRAVITY_LAUNCHER]);
    const children = mockExecaChildren(execaMock.execa, ["spawned"]);

    const { openFile } = await loadModule();
    await openFile("/repo with spaces/src/app.ts", 12, 5, { id: "antigravity-ide" });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const [binary, , options] = execaMock.execa.mock.calls[0];
    expect(binary).toBe(ANTIGRAVITY_LAUNCHER);
    expect(options).toMatchObject({ detached: true, stdio: "ignore", cleanup: false });
    const child = children[0]!;
    expect(child.unref).toHaveBeenCalledTimes(1);
    expect(child.catch).toHaveBeenCalledWith(expect.any(Function));
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("honours a configured Antigravity IDE over an earlier-listed installed editor", async () => {
    // Both installed: only the configured-editor branch can pick Antigravity, since
    // VS Code wins the discovery-order fallback.
    setPlatform("darwin");
    process.env.PATH = "/usr/local/bin";
    mockExistingFiles([ANTIGRAVITY_LAUNCHER, "/usr/local/bin/code"]);

    const { openFile } = await loadModule();
    await openFile("/repo/src/app.ts", 3, undefined, { id: "antigravity-ide" });

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][0]).toBe(ANTIGRAVITY_LAUNCHER);
  });

  it("does not preempt an already-supported editor when nothing is configured", async () => {
    // Antigravity is appended last in KNOWN_EDITORS precisely so adding it cannot
    // change which editor an existing user's unconfigured opens land in.
    setPlatform("darwin");
    process.env.PATH = "/usr/local/bin";
    mockExistingFiles([ANTIGRAVITY_LAUNCHER, "/usr/local/bin/zed"]);

    const { openFile } = await loadModule();
    await openFile("/repo/src/app.ts");

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0][0]).toBe("/usr/local/bin/zed");
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

// The worktree "Open in Editor" action hands EditorService a folder (#12329).
// Everything here is about what changes for a directory target — and, just as
// deliberately, what does not.
describe("EditorService directory targets", () => {
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
    fsMock.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    fsMock.accessSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    shellMock.openPath.mockResolvedValue("");
    mockExecaChildren(execaMock.execa, ["spawned"]);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPATH;
    if (originalVISUAL !== undefined) process.env.VISUAL = originalVISUAL;
    else delete process.env.VISUAL;
    if (originalEDITOR !== undefined) process.env.EDITOR = originalEDITOR;
    else delete process.env.EDITOR;
  });

  const WORKTREE = "/abs/worktrees/feature-x";

  function argsOfFirstLaunch(): string[] {
    expect(execaMock.execa).toHaveBeenCalled();
    return execaMock.execa.mock.calls[0][1] as string[];
  }

  // `--goto` names a file to navigate into; the whole point of the fix.
  const GOTO_EDITORS = [
    ["vscode", "code"],
    ["vscode-insiders", "code-insiders"],
    ["cursor", "cursor"],
    ["windsurf", "windsurf"],
    ["antigravity-ide", "antigravity-ide"],
  ] as const;

  for (const [id, binary] of GOTO_EDITORS) {
    it(`${id} opens a directory as a bare path, without --goto`, async () => {
      mockExistingFiles([`/usr/local/bin/${binary}`]);
      const { openFile } = await loadModule();

      await openFile(WORKTREE, undefined, undefined, { id }, true);

      expect(execaMock.execa).toHaveBeenCalledWith(
        `/usr/local/bin/${binary}`,
        [WORKTREE],
        expect.objectContaining({ detached: true })
      );
      // A launch that succeeded must end the chain — no discovery pass behind
      // it, and above all no reveal, which is the bug this fixes.
      expect(execaMock.execa).toHaveBeenCalledTimes(1);
      expect(shellMock.openPath).not.toHaveBeenCalled();
    });

    it(`${id} still uses --goto for a file target`, async () => {
      mockExistingFiles([`/usr/local/bin/${binary}`]);
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts", 12, 5, { id }, false);

      expect(argsOfFirstLaunch()).toEqual(["--goto", "/abs/file.ts:12:5"]);
    });
  }

  // A caller that passes coordinates alongside a folder must not be able to
  // turn it back into a file target — the folder wins.
  it("drops coordinates supplied with a directory target", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { openFile } = await loadModule();

    await openFile(WORKTREE, 12, 5, { id: "vscode" }, true);

    expect(argsOfFirstLaunch()).toEqual([WORKTREE]);
  });

  it("passes a bare directory path to the editors that already take one", async () => {
    for (const [id, binary] of [
      ["zed", "zed"],
      ["sublime", "subl"],
      ["webstorm", "webstorm"],
      ["neovim", "nvim"],
    ] as const) {
      vi.clearAllMocks();
      mockExecaChildren(execaMock.execa, ["spawned"]);
      mockExistingFiles([`/usr/local/bin/${binary}`]);
      const { openFile } = await loadModule();

      await openFile(WORKTREE, 12, 5, { id }, true);

      expect(argsOfFirstLaunch(), id).toEqual([WORKTREE]);
    }
  });

  it("discovered editors are directory-aware too, not just the configured one", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { openFile } = await loadModule();

    // No config at all: the target reaches `code` through the discovery loop.
    await openFile(WORKTREE, undefined, undefined, null, true);

    expect(argsOfFirstLaunch()).toEqual([WORKTREE]);
  });

  it("renders the default custom template as a bare directory, not 'dir::'", async () => {
    const { openFile } = await loadModule();

    await openFile(
      WORKTREE,
      12,
      5,
      { id: "custom", customCommand: "myeditor", customTemplate: "{file}:{line}:{col}" },
      true
    );

    expect(execaMock.execa).toHaveBeenCalledWith(
      "myeditor",
      [WORKTREE],
      expect.objectContaining({ detached: true })
    );
    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("keeps the surrounding flags of a custom template when coordinates go away", async () => {
    const { openFile } = await loadModule();

    await openFile(
      WORKTREE,
      12,
      5,
      { id: "custom", customCommand: "code", customTemplate: "--reuse-window {file}:{line}:{col}" },
      true
    );

    expect(argsOfFirstLaunch()).toEqual(["--reuse-window", WORKTREE]);
  });

  // A token that interpolates away must still be passed, empty: a positional
  // template would otherwise slide the path into the vacated slot.
  it("keeps a stranded token's argv slot rather than shifting the ones after it", async () => {
    const { openFile } = await loadModule();

    await openFile(
      WORKTREE,
      12,
      undefined,
      { id: "custom", customCommand: "wrapper", customTemplate: '"{line}" "{col}" "{file}"' },
      true
    );

    expect(argsOfFirstLaunch()).toEqual(["", "", WORKTREE]);
  });

  it("keeps the argv slot for a file opened without a column too", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 12, undefined, {
      id: "custom",
      customCommand: "wrapper",
      customTemplate: '"{line}" "{col}" "{file}"',
    });

    expect(argsOfFirstLaunch()).toEqual(["12", "", "/abs/file.ts"]);
  });

  // The same stranded punctuation was already reachable for a file opened with
  // no line — the settings UI defaults every custom editor to this template.
  it("renders a file with no line as a bare path under the default template", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", undefined, undefined, {
      id: "custom",
      customCommand: "myeditor",
      customTemplate: "{file}:{line}:{col}",
    });

    expect(argsOfFirstLaunch()).toEqual(["/abs/file.ts"]);
  });

  it("keeps the line but drops the missing column", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 12, undefined, {
      id: "custom",
      customCommand: "myeditor",
      customTemplate: "{file}:{line}:{col}",
    });

    expect(argsOfFirstLaunch()).toEqual(["/abs/file.ts:12"]);
  });

  it("still renders both coordinates when they are present", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 12, 5, {
      id: "custom",
      customCommand: "myeditor",
      customTemplate: "{file}:{line}:{col}",
    });

    expect(argsOfFirstLaunch()).toEqual(["/abs/file.ts:12:5"]);
  });

  it("skips the macOS plain-text fallback for a directory and reveals it instead", async () => {
    setPlatform("darwin");
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, null, true);

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith(WORKTREE);
  });

  it("still uses the macOS plain-text fallback for a file", async () => {
    setPlatform("darwin");
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", undefined, undefined, null, false);

    expect(execaMock.execa).toHaveBeenCalledWith(
      "open",
      ["-t", "/abs/file.ts"],
      expect.objectContaining({ detached: true })
    );
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("reaches shell.openPath for a directory only after every editor has failed", async () => {
    setPlatform("darwin");
    mockExistingFiles(["/usr/local/bin/code"]);
    mockExecaChildren(execaMock.execa, ["enoent"]);
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, { id: "vscode" }, true);

    // Exactly two attempts — the configured editor, then the discovery loop's
    // — both with folder argv, and no `open -t` between them. Asserting the
    // count is what stops a reveal-without-trying regression passing here.
    expect(execaMock.execa.mock.calls).toEqual([
      ["/usr/local/bin/code", [WORKTREE], expect.objectContaining({ detached: true })],
      ["/usr/local/bin/code", [WORKTREE], expect.objectContaining({ detached: true })],
    ]);
    expect(shellMock.openPath).toHaveBeenCalledWith(WORKTREE);
  });

  it("keeps the directory flag when the configured editor is missing", async () => {
    // Configured Zed, but only `code` is installed: the configured branch finds
    // no executable, so discovery answers — still as a folder.
    mockExistingFiles(["/usr/local/bin/code"]);
    const { openFile } = await loadModule();

    await openFile(WORKTREE, 12, 5, { id: "zed" }, true);

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(argsOfFirstLaunch()).toEqual([WORKTREE]);
  });

  it("keeps the directory flag when the configured editor fails and another answers", async () => {
    mockExistingFiles(["/usr/local/bin/code", "/usr/local/bin/subl"]);
    // The configured launch fails; the discovery loop's first candidate wins.
    mockExecaChildren(execaMock.execa, ["enoent", "spawned"]);
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, { id: "sublime" }, true);

    expect(execaMock.execa.mock.calls[0]![0]).toBe("/usr/local/bin/subl");
    expect(execaMock.execa.mock.calls[1]).toEqual([
      "/usr/local/bin/code",
      [WORKTREE],
      expect.objectContaining({ detached: true }),
    ]);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("appends a directory to $VISUAL without touching its flags", async () => {
    process.env.VISUAL = "code --reuse-window";
    const { openFile } = await loadModule();

    await openFile(WORKTREE, 12, 5, null, true);

    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      ["--reuse-window", WORKTREE],
      expect.objectContaining({ detached: true })
    );
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("falls past a terminal-editor $VISUAL to $EDITOR for a directory", async () => {
    process.env.VISUAL = "vim";
    process.env.EDITOR = "code";
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, null, true);

    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      [WORKTREE],
      expect.objectContaining({ detached: true })
    );
  });
});
