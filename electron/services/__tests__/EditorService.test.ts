import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockExecaChildren, type ChildBehaviour } from "./helpers/editorChild.js";

const fsMock = vi.hoisted(() => ({
  promises: {
    stat: vi.fn<(path: string) => Promise<{ isFile: () => boolean }>>(),
    access: vi.fn<(path: string, mode?: number) => Promise<void>>(),
    readdir: vi.fn<(path: string) => Promise<unknown[]>>(),
    lstat: vi.fn<(path: string) => Promise<{ isSymbolicLink: () => boolean }>>(),
  },
  constants: { X_OK: 1 },
}));

const execaMock = vi.hoisted(() => {
  const fn = vi.fn();
  return { execa: fn };
});
const shellMock = vi.hoisted(() => ({ openPath: vi.fn<(p: string) => Promise<string>>() }));

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("os", () => ({
  default: { homedir: () => "/Users/testuser" },
  homedir: () => "/Users/testuser",
}));

// On Linux the default app opens through xdg-open rather than shell.openPath;
// these tests check what reaches the OS opener, so route it to the shell mock.
vi.mock("../../utils/openPath.js", async () => {
  const { shell } = await import("electron");
  return { openWithDefaultApp: (target: string) => shell.openPath(target) };
});

vi.mock("electron", () => ({ shell: shellMock }));

vi.mock("execa", () => ({
  execa: execaMock.execa,
}));

// The Windows PATH search lists directories (`node:fs` is this same mock), so
// Windows cases describe the disk as directory listings.
function windowsDisk(files: string[]): void {
  fsMock.promises.readdir.mockImplementation(async (directory: string) => {
    const prefix = `${directory.replace(/\\+$/, "").toLowerCase()}\\`;
    const names = files
      .filter((file) => file.toLowerCase().startsWith(prefix))
      .map((file) => file.slice(prefix.length))
      .filter((name) => !name.includes("\\"));
    if (names.length === 0) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return names.map((name) => ({
      name,
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
    }));
  });
}

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
  fsMock.promises.stat.mockImplementation(async (p: string) => {
    if (set.has(p)) return { isFile: () => true };
    throw new Error("ENOENT");
  });
  fsMock.promises.access.mockImplementation(async (p: string) => {
    if (set.has(p) && executable) return;
    throw new Error("EACCES");
  });
}

type EditorModule = typeof import("../EditorService.js");

async function loadModule(): Promise<EditorModule> {
  return (await import("../EditorService.js")) as EditorModule;
}

describe("EditorService.discover", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPATH = process.env.PATH;
    process.env.PATH = "";
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env.PATH = originalPATH;
  });

  async function loadDiscover() {
    const mod = await import("../EditorService.js");
    return mod.discover;
  }

  it("discovers JetBrains IDE via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "jetbrains-webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/WebStorm.app/Contents/MacOS/webstorm");
  });

  it("discovers JetBrains IDE in ~/Applications on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"]);

    const discover = await loadDiscover();
    const results = await discover();
    const idea = results.find((e) => e.id === "jetbrains-idea");

    expect(idea).toBeDefined();
    expect(idea!.available).toBe(true);
    expect(idea!.executablePath).toBe(
      "/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"
    );
  });

  it("takes the first PATH directory holding a launcher even when a later one answers sooner", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/slow/bin:/fast/bin";
    const present = new Set(["/slow/bin/idea", "/fast/bin/idea"]);
    fsMock.promises.stat.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith("/slow/")) await new Promise((r) => setTimeout(r, 20));
      if (present.has(filePath)) return { isFile: () => true };
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async () => {});

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.find((e) => e.id === "jetbrains-idea")!.executablePath).toBe("/slow/bin/idea");

    present.delete("/slow/bin/idea");
    const second = await discover();
    expect(second.find((e) => e.id === "jetbrains-idea")!.executablePath).toBe("/fast/bin/idea");
  });

  it("skips a directory match and a non-executable file for the next candidate", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/a:/b:/c";
    fsMock.promises.stat.mockImplementation(async (filePath: string) => {
      if (filePath === "/a/code") return { isFile: () => false };
      if (filePath === "/b/code" || filePath === "/c/code") return { isFile: () => true };
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async (filePath: string) => {
      if (filePath === "/b/code") throw new Error("EACCES");
    });

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.find((e) => e.id === "vscode")!.executablePath).toBe("/c/code");
    expect(fsMock.promises.access).not.toHaveBeenCalledWith("/a/code", expect.anything());
  });

  it("never has more than two probes in flight, across editors", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = Array.from({ length: 8 }, (_, i) => `/p${i}`).join(":");
    let inFlight = 0;
    let peak = 0;
    fsMock.promises.stat.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      throw new Error("ENOENT");
    });

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.every((e) => !e.available)).toBe(true);
    expect(peak).toBe(2);
  });

  it("stops at the first match without probing the candidates behind it", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = Array.from({ length: 20 }, (_, i) => `/p${i}`).join(":");
    mockExistingFiles(["/p0/code"]);

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.find((e) => e.id === "vscode")!.executablePath).toBe("/p0/code");
    const vscodeProbes = fsMock.promises.stat.mock.calls.filter(([p]) => p.endsWith("/code"));
    expect(vscodeProbes).toEqual([["/p0/code"]]);
  });

  it("keeps directory-then-PATHEXT order on win32 without an X_OK check", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    process.env.PATH = "C:\\one;C:\\two";
    const originalPATHEXT = process.env.PATHEXT;
    process.env.PATHEXT = ".COM;.EXE;.CMD";
    windowsDisk(["C:\\two\\code.com", "C:\\one\\code.cmd"]);

    try {
      const discover = await loadDiscover();
      const results = await discover();

      expect(results.find((e) => e.id === "vscode")!.executablePath).toBe("C:\\one\\code.cmd");
      expect(fsMock.promises.access).not.toHaveBeenCalled();
    } finally {
      if (originalPATHEXT === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPATHEXT;
    }
  });

  it("still discovers JetBrains IDE via Toolbox on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const toolboxPath =
      "/Users/testuser/Library/Application Support/JetBrains/Toolbox/scripts/webstorm";
    mockExistingFiles([toolboxPath]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "jetbrains-webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe(toolboxPath);
  });

  it("discovers VS Code via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]);

    const discover = await loadDiscover();
    const results = await discover();
    const vscode = results.find((e) => e.id === "vscode");

    expect(vscode).toBeDefined();
    expect(vscode!.available).toBe(true);
    expect(vscode!.executablePath).toBe(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    );
  });

  it("does not search .app bundle paths on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistingFiles(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "jetbrains-webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(false);
  });

  it("discovers editors via PATH when available", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/usr/local/bin";
    mockExistingFiles(["/usr/local/bin/code"]);

    const discover = await loadDiscover();
    const results = await discover();
    const vscode = results.find((e) => e.id === "vscode");

    expect(vscode).toBeDefined();
    expect(vscode!.available).toBe(true);
    expect(vscode!.executablePath).toBe("/usr/local/bin/code");
  });

  it("returns all editors with available=false and no executablePath when nothing is found", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles([]);

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.length).toBeGreaterThan(0);
    for (const editor of results) {
      expect(editor.available).toBe(false);
      expect(editor.executablePath).toBeUndefined();
    }
  });
});

describe("EditorService.openFile", () => {
  let originalPATH: string | undefined;
  let originalVISUAL: string | undefined;
  let originalEDITOR: string | undefined;

  function mockLaunches(...behaviours: ChildBehaviour[]) {
    return mockExecaChildren(execaMock.execa, behaviours);
  }

  function mockSyncThrow() {
    execaMock.execa.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
  }

  const CUSTOM_EDITOR = {
    id: "custom",
    customCommand: "/bin/broken-editor",
    customTemplate: "{file}",
  } as const;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPATH = process.env.PATH;
    originalVISUAL = process.env.VISUAL;
    originalEDITOR = process.env.EDITOR;
    process.env.PATH = "";
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    fsMock.promises.stat.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async () => {
      throw new Error("EACCES");
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env.PATH = originalPATH;
    if (originalVISUAL !== undefined) process.env.VISUAL = originalVISUAL;
    else delete process.env.VISUAL;
    if (originalEDITOR !== undefined) process.env.EDITOR = originalEDITOR;
    else delete process.env.EDITOR;
  });

  async function loadOpenFile() {
    const mod = await import("../EditorService.js");
    return mod.openFile;
  }

  it("macOS fallback calls launchEditor with 'open' and suppresses async rejection", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const children = mockLaunches("spawned");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith("open", ["-t", "/absolute/path/file.ts"], {
      detached: true,
      stdio: "ignore",
      cleanup: false,
    });
    const child = children[0]!;
    expect(child.nodeChildProcess.unref).toHaveBeenCalled();
    expect(child.catch).toHaveBeenCalledWith(expect.any(Function));
    // The suppression catch is separate from the verification consumer; both
    // read the same promise.
    expect(child.then).toHaveBeenCalled();
    // 'spawn' won the race and `once` removed itself, so nothing stays attached
    // to a detached child that may outlive the app.
    expect(child.nodeChildProcess.listenerCount("spawn")).toBe(0);

    const { shell } = await import("electron");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("macOS fallback falls through to shell.openPath when open throws", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockSyncThrow();

    const { shell } = await import("electron");
    vi.mocked(shell.openPath).mockResolvedValue("");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts");

    expect(shell.openPath).toHaveBeenCalledWith("/absolute/path/file.ts");
  });

  it("non-darwin skips macOS fallback and uses shell.openPath", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });

    const { shell } = await import("electron");
    vi.mocked(shell.openPath).mockResolvedValue("");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts");

    expect(execaMock.execa).not.toHaveBeenCalledWith("open", expect.anything(), expect.anything());
    expect(shell.openPath).toHaveBeenCalledWith("/absolute/path/file.ts");
  });

  it("treats an emitted 'spawn' as launched without waiting for the process to exit", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockLaunches("spawned");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR);

    // A detached GUI editor's promise settles only when it exits, which may be
    // hours away — this times out if launchEditor ever awaits the child itself.
    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0]?.[0]).toBe("/bin/broken-editor");

    const { shell } = await import("electron");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("advances to the next candidate when the launch rejects without emitting 'spawn'", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const children = mockLaunches("enoent", "spawned");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR);

    expect(execaMock.execa).toHaveBeenCalledTimes(2);
    expect(execaMock.execa.mock.calls[0]?.[0]).toBe("/bin/broken-editor");
    expect(execaMock.execa.mock.calls[1]?.[0]).toBe("open");
    expect(children[0]!.nodeChildProcess.unref).toHaveBeenCalled();

    const { shell } = await import("electron");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("advances when the child emits neither 'spawn' nor 'error' (execa's early-error path)", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockLaunches("early-error");

    const { shell } = await import("electron");
    vi.mocked(shell.openPath).mockResolvedValue("");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR);

    // Promise settlement is the only channel this path uses, so an
    // event-only implementation would hang here rather than fail.
    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa.mock.calls[0]?.[0]).toBe("/bin/broken-editor");
    expect(shell.openPath).toHaveBeenCalledWith("/absolute/path/file.ts");
  });

  it("holds the fallback until the launch verdict arrives, rather than assuming success", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const children = mockLaunches("manual");

    const { shell } = await import("electron");
    vi.mocked(shell.openPath).mockResolvedValue("");

    const openFile = await loadOpenFile();
    const pending = openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR);

    await vi.waitFor(() => expect(children).toHaveLength(1));
    // Nothing has reported either way yet, so nothing downstream may run.
    expect(shell.openPath).not.toHaveBeenCalled();

    children[0]!.rejectLaunch();
    await pending;

    expect(shell.openPath).toHaveBeenCalledWith("/absolute/path/file.ts");
  });

  it("exhausts every candidate when they all fail asynchronously, then surfaces the shell error", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    process.env.VISUAL = "code";
    process.env.EDITOR = "subl --wait";
    mockLaunches("enoent");

    const { shell } = await import("electron");
    vi.mocked(shell.openPath).mockResolvedValue("Access denied");

    const openFile = await loadOpenFile();
    await expect(
      openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR)
    ).rejects.toThrow("Failed to open file: Access denied");

    // Configured editor, then $VISUAL, then $EDITOR, then the macOS handler —
    // an async failure must not stop the chain at any link.
    expect(execaMock.execa.mock.calls.map((call) => call[0])).toEqual([
      "/bin/broken-editor",
      "code",
      "subl",
      "open",
    ]);
  });

  it("counts a spawn that later exits nonzero as launched — exit status is not observed", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockLaunches("spawned-then-exit");

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts", undefined, undefined, CUSTOM_EDITOR);

    // Indistinguishable at spawn time from a CLI shim that hands off to a GUI
    // and exits 0, so it deliberately stops the chain.
    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    const { shell } = await import("electron");
    expect(shell.openPath).not.toHaveBeenCalled();
  });

  it("rejects non-absolute paths before reaching execa or shell", async () => {
    const openFile = await loadOpenFile();
    await expect(openFile("relative/path.ts")).rejects.toThrow("Only absolute paths are allowed");
    expect(execaMock.execa).not.toHaveBeenCalled();

    const { shell } = await import("electron");
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});

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

  it("re-resolves the configured editor at openFile time; stale discovery is not cached", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { discover, openFile } = await loadModule();

    const first = await discover();
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

  it("starts an editor on Linux without Daintree's desktop entry or an AppImage's libraries", async () => {
    process.env.VISUAL = "code";
    process.env.CHROME_DESKTOP = "daintree.desktop";
    process.env.APPIMAGE = "/home/u/Daintree.AppImage";
    process.env.APPDIR = "/tmp/.mount_DaintrABC";
    process.env.LD_LIBRARY_PATH = "/tmp/.mount_DaintrABC/usr/lib:/opt/lib";
    try {
      const { openFile } = await loadModule();
      await openFile("/repo/src/app.ts");

      const [binary, , options] = execaMock.execa.mock.calls[0];
      expect(binary).toBe("code");
      expect(options).toMatchObject({ detached: true, extendEnv: false });
      const env = options.env as Record<string, string | undefined>;
      expect(env.CHROME_DESKTOP).toBeUndefined();
      expect(env.APPIMAGE).toBeUndefined();
      expect(env.LD_LIBRARY_PATH).toBe("/opt/lib");
      expect(env.PATH).toBe("/usr/local/bin");
    } finally {
      for (const name of ["CHROME_DESKTOP", "APPIMAGE", "APPDIR", "LD_LIBRARY_PATH"]) {
        delete process.env[name];
      }
    }
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

  it("VISUAL=code opens the requested line and column", async () => {
    process.env.VISUAL = "code";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 37, 8);

    expect(execaMock.execa).toHaveBeenCalledWith(
      "code",
      ["--goto", "/abs/file.ts:37:8"],
      expect.objectContaining({ detached: true })
    );
  });

  it("a known GUI named by absolute path in EDITOR keeps user flags and the location", async () => {
    process.env.EDITOR = "/usr/local/bin/code --reuse-window";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 37, 8);

    expect(execaMock.execa).toHaveBeenCalledWith(
      "/usr/local/bin/code",
      ["--reuse-window", "--goto", "/abs/file.ts:37:8"],
      expect.objectContaining({ detached: true })
    );
  });

  it("leaves a user-written --goto alone", async () => {
    process.env.VISUAL = "code --goto";
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 37, 8);

    expect(execaMock.execa.mock.calls[0][1]).toEqual(["--goto", "/abs/file.ts"]);
  });

  it.each(["code --goto=false", "code --", "idea --line 12"])(
    "leaves user navigation args in %s untouched",
    async (visual) => {
      process.env.VISUAL = visual;
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts", 37, 8);

      expect(execaMock.execa.mock.calls[0][1]).toEqual([
        ...visual.split(" ").slice(1),
        "/abs/file.ts",
      ]);
    }
  );

  it("opens a directory from VISUAL as a bare path", async () => {
    process.env.VISUAL = "code";
    const { openFile } = await loadModule();

    await openFile("/abs/dir", 37, 8, null, true);

    expect(execaMock.execa.mock.calls[0][1]).toEqual(["/abs/dir"]);
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

  describe("Windows: a configured command is launched from PATH by absolute path", () => {
    let originalPATHEXT: string | undefined;

    beforeEach(() => {
      setPlatform("win32");
      originalPATHEXT = process.env.PATHEXT;
      process.env.PATHEXT = ".EXE;.CMD";
      // `.` and `bin` would be resolved against the working directory.
      process.env.PATH = ".;bin;C:\\tools";
    });

    afterEach(() => {
      if (originalPATHEXT === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPATHEXT;
    });

    it("resolves a bare custom command, never a same-named file outside PATH", async () => {
      windowsDisk(["C:\\tools\\code.cmd"]);
      // Same-named files the working directory would offer, never PATH.
      mockExistingFiles(["code.exe", "bin\\code.exe", ".\\code.exe"]);
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts", undefined, undefined, {
        id: "custom",
        customCommand: "code",
        customTemplate: "{file}",
      });

      expect(execaMock.execa).toHaveBeenCalledTimes(1);
      expect(execaMock.execa.mock.calls[0]?.[0]).toBe("C:\\tools\\code.cmd");
      expect(fsMock.promises.stat).not.toHaveBeenCalled();
    });

    it("tries $EDITOR's own extension first, and skips a command PATH does not hold", async () => {
      process.env.VISUAL = "missing-editor --wait";
      process.env.EDITOR = "notepad++.exe";
      windowsDisk(["C:\\tools\\notepad++.exe"]);
      mockExistingFiles(["missing-editor.exe"]);
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts");

      expect(execaMock.execa.mock.calls.map(([program]) => program)).toEqual([
        "C:\\tools\\notepad++.exe",
      ]);
    });

    it("reaches a wrapper PATHEXT names beyond .exe/.cmd, by bare name or with its extension", async () => {
      process.env.PATHEXT = ".EXE;.CMD;.VBS";
      windowsDisk(["C:\\tools\\editor.vbs"]);
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts", undefined, undefined, {
        id: "custom",
        customCommand: "editor",
        customTemplate: "{file}",
      });
      process.env.EDITOR = "editor.vbs";
      await openFile("/abs/file.ts");

      expect(execaMock.execa.mock.calls.map(([program]) => program)).toEqual([
        "C:\\tools\\editor.vbs",
        "C:\\tools\\editor.vbs",
      ]);
    });

    it("passes a configured path through unchanged", async () => {
      const editor = "D:\\Apps\\Editor\\editor.exe";
      const { openFile } = await loadModule();

      await openFile("/abs/file.ts", undefined, undefined, {
        id: "custom",
        customCommand: editor,
        customTemplate: "{file}",
      });

      expect(execaMock.execa.mock.calls[0]?.[0]).toBe(editor);
    });

    it("searches past a PATH entry on a dropped share instead of waiting on it", async () => {
      process.env.PATH = "\\\\gone\\tools;C:\\tools";
      windowsDisk(["C:\\tools\\code.cmd"]);
      const listDirectory = fsMock.promises.readdir.getMockImplementation()!;
      fsMock.promises.readdir.mockImplementation((directory: string) =>
        directory.startsWith("\\\\gone") ? new Promise(() => {}) : listDirectory(directory)
      );
      const { discover } = await loadModule();

      vi.useFakeTimers();
      try {
        const discovering = discover();
        await vi.advanceTimersByTimeAsync(10_000);
        const results = await discovering;
        expect(results.find((e) => e.id === "vscode")?.executablePath).toBe("C:\\tools\\code.cmd");
      } finally {
        vi.useRealTimers();
      }
    });
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
    fsMock.promises.stat.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async () => {
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
      ["jetbrains-idea", "idea"],
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

  // Only `:` — the form the settings UI documents — is treated as a coordinate
  // separator. Other punctuation in a hand-written template means whatever the
  // user's own command says it means.
  it("leaves a bare vim '+' alone when there is no line to attach to it", async () => {
    const { openFile } = await loadModule();

    await openFile(
      WORKTREE,
      12,
      5,
      { id: "custom", customCommand: "gvim", customTemplate: "+{line} {file}" },
      true
    );

    expect(argsOfFirstLaunch()).toEqual(["+", WORKTREE]);
  });

  it("leaves a comma delimiter's empty field in place", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 12, undefined, {
      id: "custom",
      customCommand: "wrapper",
      customTemplate: "{line},{col},{file}",
    });

    expect(argsOfFirstLaunch()).toEqual(["12,,/abs/file.ts"]);
  });

  // The same stranded punctuation was already reachable for a file opened with
  // no line — the settings UI defaults every custom editor to this template.
  it("keeps the line but drops the missing column", async () => {
    const { openFile } = await loadModule();

    await openFile("/abs/file.ts", 12, undefined, {
      id: "custom",
      customCommand: "myeditor",
      customTemplate: "{file}:{line}:{col}",
    });

    expect(argsOfFirstLaunch()).toEqual(["/abs/file.ts:12"]);
  });

  it("skips the macOS plain-text fallback for a directory and reveals it instead", async () => {
    setPlatform("darwin");
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, null, true);

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith(WORKTREE);
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
});

// Neovim needs a TTY, and every launch here is detached with its streams
// ignored, so a spawned nvim is a live process nobody can see (#17441).
describe("EditorService terminal-only editors", () => {
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

  function launchedBinaries(): string[] {
    return execaMock.execa.mock.calls.map((call) => call[0] as string);
  }

  it("automatic selection passes over nvim to the next GUI editor", async () => {
    // nvim ranks ahead of Sublime in the automatic order.
    mockExistingFiles(["/usr/local/bin/nvim", "/usr/local/bin/subl"]);
    const { openFile } = await loadModule();

    await expect(openFile("/abs/file.ts", 12, 5, null)).resolves.toBeUndefined();

    expect(launchedBinaries()).toEqual(["/usr/local/bin/subl"]);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("automatic selection with only nvim installed reaches the default app", async () => {
    mockExistingFiles(["/usr/local/bin/nvim"]);
    const { openFile } = await loadModule();

    await expect(openFile("/abs/file.ts", 12, 5, null)).resolves.toBeUndefined();

    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).toHaveBeenCalledWith("/abs/file.ts");
  });

  it("automatic selection on macOS with only nvim installed reaches `open -t`", async () => {
    setPlatform("darwin");
    mockExistingFiles(["/usr/local/bin/nvim"]);
    const { openFile } = await loadModule();

    await expect(openFile("/abs/file.ts", 12, 5, null)).resolves.toBeUndefined();

    expect(launchedBinaries()).toEqual(["open"]);
    expect(execaMock.execa.mock.calls[0]![1]).toEqual(["-t", "/abs/file.ts"]);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // Substituting another editor for an explicit choice would hide why the
  // choice never opens; the result lets the window say how to set it up.
  it("an explicit Neovim choice launches nothing and answers that it needs a terminal", async () => {
    mockExistingFiles(["/usr/local/bin/nvim", "/usr/local/bin/code"]);
    process.env.EDITOR = "code";
    const { openFile } = await loadModule();

    const result = await openFile("/abs/file.ts", 12, 5, { id: "neovim" });

    expect(result).toEqual({ outcome: "needs-terminal", editorName: "Neovim", command: "nvim" });
    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("an explicit Neovim choice answers the same for a folder target", async () => {
    mockExistingFiles(["/usr/local/bin/nvim"]);
    const { openFile } = await loadModule();

    const result = await openFile(
      "/abs/worktrees/feature-x",
      undefined,
      undefined,
      { id: "neovim" },
      true
    );

    expect(result).toEqual({ outcome: "needs-terminal", editorName: "Neovim", command: "nvim" });
    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  it("an explicit Neovim choice answers the same when nvim isn't installed", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { openFile } = await loadModule();

    const result = await openFile("/abs/file.ts", 12, 5, { id: "neovim" });

    expect(result).toEqual({ outcome: "needs-terminal", editorName: "Neovim", command: "nvim" });
    expect(execaMock.execa).not.toHaveBeenCalled();
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // `nvim --server <addr> --remote {file}` hands the file to a running Neovim
  // and needs no terminal of its own, so a custom command is never second-guessed.
  it("a custom nvim command still launches as configured", async () => {
    const { openFile } = await loadModule();

    const result = await openFile("/abs/my file.ts", 12, 5, {
      id: "custom",
      customCommand: "nvim",
      customTemplate: "--server /tmp/nvim.sock --remote {file}",
    });

    expect(result).toBeUndefined();
    expect(execaMock.execa).toHaveBeenCalledTimes(1);
    expect(execaMock.execa).toHaveBeenCalledWith(
      "nvim",
      ["--server", "/tmp/nvim.sock", "--remote", "/abs/my file.ts"],
      expect.objectContaining({ detached: true })
    );
  });

  it("a GUI editor's launch answers nothing", async () => {
    mockExistingFiles(["/usr/local/bin/code"]);
    const { openFile } = await loadModule();

    await expect(openFile("/abs/file.ts", 12, 5, { id: "vscode" })).resolves.toBeUndefined();
    expect(launchedBinaries()).toEqual(["/usr/local/bin/code"]);
  });
});

describe("EditorService JetBrains products", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    originalPATH = process.env.PATH;
    originalVISUAL = process.env.VISUAL;
    originalEDITOR = process.env.EDITOR;
    process.env.PATH = "";
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    setPlatform("darwin");
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

  const WEBSTORM = "/Applications/WebStorm.app/Contents/MacOS/webstorm";
  const IDEA = "/Applications/IntelliJ IDEA.app/Contents/MacOS/idea";
  const VSCODE = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
  const WORKTREE = "/abs/worktrees/feature-x";

  function launchedPrograms(): string[] {
    return execaMock.execa.mock.calls.map(([program]) => program as string);
  }

  it("discovers WebStorm and IntelliJ IDEA as separate editors when both are installed", async () => {
    mockExistingFiles([WEBSTORM, IDEA]);
    const { discover } = await loadModule();

    const results = await discover();

    expect(results.find((e) => e.id === "jetbrains-webstorm")?.executablePath).toBe(WEBSTORM);
    expect(results.find((e) => e.id === "jetbrains-idea")?.executablePath).toBe(IDEA);
  });

  it("reports WebStorm as not found when only IntelliJ IDEA is installed", async () => {
    mockExistingFiles([IDEA]);
    const { discover } = await loadModule();

    const results = await discover();

    expect(results.find((e) => e.id === "jetbrains-webstorm")?.available).toBe(false);
    expect(results.find((e) => e.id === "jetbrains-idea")?.executablePath).toBe(IDEA);
  });

  it("finds each product's own Toolbox script and community-edition bundle", async () => {
    const toolbox = "/Users/testuser/Library/Application Support/JetBrains/Toolbox/scripts";
    mockExistingFiles([
      `${toolbox}/goland`,
      "/Users/testuser/Applications/PyCharm CE.app/Contents/MacOS/pycharm",
      "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
    ]);
    const { discover } = await loadModule();

    const found = Object.fromEntries(
      (await discover()).filter((e) => e.available).map((e) => [e.id, e.executablePath])
    );

    expect(found).toEqual({
      "jetbrains-goland": `${toolbox}/goland`,
      "jetbrains-pycharm": "/Users/testuser/Applications/PyCharm CE.app/Contents/MacOS/pycharm",
      "jetbrains-idea": "/Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea",
    });
  });

  // VS Code outranks every JetBrains IDE in the automatic pick, so only the
  // configured step can produce these launches.
  it.each([
    { id: "jetbrains-webstorm", expected: WEBSTORM },
    { id: "jetbrains-idea", expected: IDEA },
  ] as const)("opens a file at its line in the chosen $id", async ({ id, expected }) => {
    mockExistingFiles([VSCODE, WEBSTORM, IDEA]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", 12, 4, { id });

    expect(execaMock.execa.mock.calls).toEqual([
      [
        expected,
        ["--line", "12", "/abs/src/Main.java"],
        expect.objectContaining({ detached: true }),
      ],
    ]);
  });

  it.each([
    { id: "jetbrains-webstorm", expected: WEBSTORM },
    { id: "jetbrains-idea", expected: IDEA },
  ] as const)("opens a worktree folder in the chosen $id", async ({ id, expected }) => {
    mockExistingFiles([VSCODE, WEBSTORM, IDEA]);
    const { openFile } = await loadModule();

    await openFile(WORKTREE, undefined, undefined, { id }, true);

    expect(execaMock.execa.mock.calls).toEqual([
      [expected, [WORKTREE], expect.objectContaining({ detached: true })],
    ]);
    expect(shellMock.openPath).not.toHaveBeenCalled();
  });

  // A saved `webstorm` predates the split, when it meant whichever JetBrains IDE
  // came first; it keeps opening that IDE rather than leaving for VS Code.
  it("keeps a saved webstorm choice opening another JetBrains IDE when WebStorm is absent", async () => {
    mockExistingFiles([IDEA, VSCODE]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", 3, undefined, { id: "webstorm" });

    expect(execaMock.execa.mock.calls).toEqual([
      [IDEA, ["--line", "3", "/abs/src/Main.java"], expect.objectContaining({ detached: true })],
    ]);
  });

  it("searches a saved webstorm choice binary first, then directory, as it always did", async () => {
    setPlatform("linux");
    process.env.PATH = "/early/bin:/late/bin";
    mockExistingFiles(["/early/bin/idea", "/late/bin/webstorm"]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", undefined, undefined, { id: "webstorm" });

    expect(launchedPrograms()).toEqual(["/late/bin/webstorm"]);
  });

  it("reports no separate row for a saved webstorm choice", async () => {
    mockExistingFiles([WEBSTORM, IDEA]);
    const { discover } = await loadModule();

    const ids = (await discover()).map((e) => e.id);

    expect(ids).not.toContain("webstorm");
  });

  // The two ids differ only once WebStorm is gone: the old one meant any
  // JetBrains IDE, a WebStorm chosen since then means WebStorm.
  it.each([
    { id: "webstorm", expected: IDEA },
    { id: "jetbrains-webstorm", expected: "code" },
  ] as const)("with only IDEA installed, $id opens $expected", async ({ id, expected }) => {
    process.env.VISUAL = "code";
    mockExistingFiles([IDEA]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", 3, undefined, { id });

    expect(launchedPrograms()).toEqual([expected]);
  });

  it("finds a Linux Toolbox script with nothing on PATH", async () => {
    setPlatform("linux");
    const script = "/Users/testuser/.local/share/JetBrains/Toolbox/scripts/clion";
    mockExistingFiles([script]);
    const { discover } = await loadModule();

    const found = (await discover()).filter((e) => e.available);

    expect(found.map((e) => [e.id, e.executablePath])).toEqual([["jetbrains-clion", script]]);
  });

  it("finds a Windows Toolbox script under a profile path with spaces", async () => {
    setPlatform("win32");
    const originalLocalAppData = process.env.LOCALAPPDATA;
    const originalPathExt = process.env.PATHEXT;
    process.env.LOCALAPPDATA = "C:\\Users\\Test User\\AppData\\Local";
    process.env.PATHEXT = ".EXE;.CMD";
    const script = "C:\\Users\\Test User\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd";
    windowsDisk([script]);

    try {
      const { discover, openFile } = await loadModule();
      const results = await discover();
      expect(results.find((e) => e.id === "jetbrains-idea")?.executablePath).toBe(script);
      expect(results.find((e) => e.id === "jetbrains-webstorm")?.available).toBe(false);

      await openFile("/repo/Main.java", 7, undefined, { id: "jetbrains-idea" });
      expect(execaMock.execa.mock.calls[0]?.slice(0, 2)).toEqual([
        script,
        ["--line", "7", "/repo/Main.java"],
      ]);
    } finally {
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = originalLocalAppData;
      if (originalPathExt === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = originalPathExt;
    }
  });

  it("sends a missing chosen IDE through the ordinary fallback order", async () => {
    mockExistingFiles([WEBSTORM, VSCODE]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", 3, undefined, { id: "jetbrains-idea" });

    expect(launchedPrograms()).toEqual([VSCODE]);
  });

  it("keeps the automatic pick in the old JetBrains order", async () => {
    const SUBLIME = "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl";
    mockExistingFiles(["/Applications/Rider.app/Contents/MacOS/rider", IDEA, SUBLIME]);
    const { openFile } = await loadModule();

    await openFile("/abs/src/Main.java", undefined, undefined, null);

    expect(launchedPrograms()).toEqual([IDEA]);
  });
});
