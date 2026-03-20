import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  statSync: vi.fn<(path: string) => { isFile: () => boolean }>(),
}));

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
    const pathSet = new Set(paths.map((p) => path.normalize(p)));
    fsMock.statSync.mockImplementation((filePath: string) => {
      if (pathSet.has(path.normalize(filePath))) {
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
    mockExistingFiles([
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
    ]);

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
