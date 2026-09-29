import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockExecaChildren, type ChildBehaviour } from "./helpers/editorChild.js";

const fsMock = vi.hoisted(() => ({
  promises: {
    stat: vi.fn<(path: string) => Promise<{ isFile: () => boolean }>>(),
    access: vi.fn<(path: string, mode?: number) => Promise<void>>(),
  },
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
    fsMock.promises.stat.mockImplementation(async (filePath: string) => {
      if (pathSet.has(filePath)) {
        return { isFile: () => true };
      }
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async (filePath: string) => {
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
    const results = await discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/WebStorm.app/Contents/MacOS/webstorm");
  });

  it("discovers IntelliJ IDEA via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/IntelliJ IDEA.app/Contents/MacOS/idea");
  });

  it("discovers JetBrains IDE in ~/Applications on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe(
      "/Users/testuser/Applications/IntelliJ IDEA.app/Contents/MacOS/idea"
    );
  });

  // Probes run concurrently, so completion order is arbitrary; the pick must
  // still be the one a sequential walk makes.
  it("keeps binary-then-directory precedence when a lower-priority probe settles first", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/slow/bin:/fast/bin";
    const present = new Set(["/slow/bin/idea", "/fast/bin/idea", "/fast/bin/webstorm"]);
    fsMock.promises.stat.mockImplementation(async (filePath: string) => {
      if (filePath.startsWith("/slow/")) await new Promise((r) => setTimeout(r, 20));
      if (present.has(filePath)) return { isFile: () => true };
      throw new Error("ENOENT");
    });
    fsMock.promises.access.mockImplementation(async () => {});

    const discover = await loadDiscover();
    const results = await discover();

    expect(results.find((e) => e.id === "webstorm")!.executablePath).toBe("/fast/bin/webstorm");

    present.delete("/fast/bin/webstorm");
    const second = await discover();
    expect(second.find((e) => e.id === "webstorm")!.executablePath).toBe("/slow/bin/idea");
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
    mockExistingFiles(["C:\\two\\code.com", "C:\\one\\code.cmd"]);

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
    const webstorm = results.find((e) => e.id === "webstorm");

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

  it("discovers Sublime Text via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"]);

    const discover = await loadDiscover();
    const results = await discover();
    const sublime = results.find((e) => e.id === "sublime");

    expect(sublime).toBeDefined();
    expect(sublime!.available).toBe(true);
    expect(sublime!.executablePath).toBe(
      "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"
    );
  });

  it("discovers Antigravity IDE via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles([
      "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
    ]);

    const discover = await loadDiscover();
    const results = await discover();
    const antigravity = results.find((e) => e.id === "antigravity-ide");

    expect(antigravity).toBeDefined();
    expect(antigravity!.available).toBe(true);
    expect(antigravity!.executablePath).toBe(
      "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
    );
  });

  it("discovers Antigravity IDE in ~/Applications on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles([
      "/Users/testuser/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide",
    ]);

    const discover = await loadDiscover();
    const results = await discover();
    const antigravity = results.find((e) => e.id === "antigravity-ide");

    expect(antigravity).toBeDefined();
    expect(antigravity!.available).toBe(true);
    expect(antigravity!.executablePath).toBe(
      "/Users/testuser/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide"
    );
  });

  it("discovers Antigravity IDE via PATH when the launcher is installed there", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.PATH = "/usr/local/bin";
    mockExistingFiles(["/usr/local/bin/antigravity-ide"]);

    const discover = await loadDiscover();
    const results = await discover();
    const antigravity = results.find((e) => e.id === "antigravity-ide");

    expect(antigravity).toBeDefined();
    expect(antigravity!.available).toBe(true);
    expect(antigravity!.executablePath).toBe("/usr/local/bin/antigravity-ide");
  });

  it("does not search .app bundle paths on Linux", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    mockExistingFiles(["/Applications/WebStorm.app/Contents/MacOS/webstorm"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(false);
  });

  it("discovers new JetBrains binaries (clion, datagrip, rubymine)", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/CLion.app/Contents/MacOS/clion"]);

    const discover = await loadDiscover();
    const results = await discover();
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
    const results = await discover();
    const vscode = results.find((e) => e.id === "vscode");

    expect(vscode).toBeDefined();
    expect(vscode!.available).toBe(true);
    expect(vscode!.executablePath).toBe("/usr/local/bin/code");
  });

  it("discovers PyCharm via .app bundle on macOS", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    mockExistingFiles(["/Applications/PyCharm.app/Contents/MacOS/pycharm"]);

    const discover = await loadDiscover();
    const results = await discover();
    const webstorm = results.find((e) => e.id === "webstorm");

    expect(webstorm).toBeDefined();
    expect(webstorm!.available).toBe(true);
    expect(webstorm!.executablePath).toBe("/Applications/PyCharm.app/Contents/MacOS/pycharm");
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
