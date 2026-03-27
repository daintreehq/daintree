import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { isFile: () => boolean }>(),
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

  function makeChild(overrides: { throwOnCatch?: boolean } = {}) {
    const child = {
      unref: vi.fn(),
      catch: vi.fn(),
    };
    if (overrides.throwOnCatch) {
      execaMock.execa.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });
    } else {
      execaMock.execa.mockReturnValue(child);
    }
    return child;
  }

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
    const child = makeChild();

    const openFile = await loadOpenFile();
    await openFile("/absolute/path/file.ts");

    expect(execaMock.execa).toHaveBeenCalledWith("open", ["/absolute/path/file.ts"], {
      detached: true,
      stdio: "ignore",
      cleanup: false,
    });
    expect(child.unref).toHaveBeenCalled();
    expect(child.catch).toHaveBeenCalledWith(expect.any(Function));
  });

  it("macOS fallback falls through to shell.openPath when open throws", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    makeChild({ throwOnCatch: true });

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

  it("rejects non-absolute paths before reaching execa or shell", async () => {
    const openFile = await loadOpenFile();
    await expect(openFile("relative/path.ts")).rejects.toThrow("Only absolute paths are allowed");
    expect(execaMock.execa).not.toHaveBeenCalled();
  });
});
