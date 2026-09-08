import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockExecaChildren, type ChildBehaviour } from "./helpers/editorChild.js";

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { isFile: () => boolean }>(),
  accessSync: vi.fn<(path: string, mode?: number) => void>(),
  constants: { X_OK: 1 },
}));

const execaMock = vi.hoisted(() => {
  const fn = vi.fn();
  return { execa: fn };
});

vi.mock("fs", () => ({
  default: fsMock,
  ...fsMock,
}));

vi.mock("os", () => ({
  default: { homedir: () => "/Users/testuser" },
  homedir: () => "/Users/testuser",
}));

vi.mock("electron", () => ({
  shell: { openPath: vi.fn() },
}));

vi.mock("execa", () => ({
  execa: execaMock.execa,
}));

const originalPlatform = process.platform;
let originalPATH: string | undefined;

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

  function mockExistingFiles(paths: string[]) {
    const pathSet = new Set(paths);
    fsMock.statSync.mockImplementation((filePath: string) => {
      if (pathSet.has(filePath)) {
        return { isFile: () => true };
      }
      throw new Error("ENOENT");
    });
    fsMock.accessSync.mockImplementation((filePath: string) => {
      if (pathSet.has(filePath)) return;
      throw new Error("EACCES");
    });
  }

  async function loadDiscover() {
    const mod = await import("../EditorService.js");
    return mod.discover;
  }

  it("discovers JetBrains IDE via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/WebStorm.app/Contents/MacOS/webstorm");
  });

  it("discovers IntelliJ IDEA via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea");
  });

  it("discovers JetBrains IDE in ~/Applications on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe(
      "/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"
    );
  });

  it("still discovers JetBrains IDE via Toolbox on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const toolboxPath =
      "/Users/testuser/Library/Application Support/JetBrains/Toolbox/scripts/webstorm";
    mockExistingFiles([toolboxPath]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe(toolboxPath);
  });

  it("discovers VS Code via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]);

    const discover = await loadDiscover();
    const results = discover();
    const vscode = results.find((e) => e.id === "vscode");

    expect(vscode).toBeDefined();
    expect(vscode!.available).toBe(true);
    expect(vscode!.executablePath).toBe(
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
    );
  });

  it("discovers Sublime Text via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"]);

    const discover = await loadDiscover();
    const results = discover();
    const sublime = results.find((e) => e.id === "sublime");

    expect(sublime).toBeDefined();
    expect(sublime!.available).toBe(true);
    expect(sublime!.executablePath).toBe(
      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"
    );
  });

  it("does not search .app bundle paths on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistingFiles(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(false);
  });

  it("discovers new JetBrains binaries (clion, datagrip, rubymine)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/CLion.app/Contents/MacOS/clion"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/CLion.app/Contents/MacOS/clion");
  });

  it("discovers editors via PATH when available", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/usr/local/bin";
    mockExistingFiles(["/usr/local/bin/code"]);

    const discover = await loadDiscover();
    const results = discover();
    const vscode = results.find((e) => e.id === "vscode");

    expect(vscode).toBeDefined();
    expect(vscode!.available).toBe(true);
    expect(vscode!.executablePath).toBe("/usr/local/bin/code");
  });

  it("discovers PyCharm via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/PyCharm.app/Contents/MacOS/pycharm"]);

    const discover = await loadDiscover();
    const results = discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/PyCharm.app/Contents/MacOS/pycharm");
  });

  it("returns all editors with available=false and no executablePath when nothing is found", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles([]);

    const discover = await loadDiscover();
    const results = discover();

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
    fsMock.statSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    fsMock.accessSync.mockImplementation(() => {
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
    expect(child.unref).toHaveBeenCalled();
    expect(child.catch).toHaveBeenCalledWith(expect.any(Function));
    // The suppression catch is separate from the verification consumer; both
    // read the same promise.
    expect(child.then).toHaveBeenCalled();
    // 'spawn' won the race and `once` removed itself, so nothing stays attached
    // to a detached child that may outlive the app.
    expect(child.listenerCount("spawn")).toBe(0);

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
    expect(children[0]!.unref).toHaveBeenCalled();

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
