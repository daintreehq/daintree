import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What bootstrap.ts did, in order. Module mocks record when they are first
// evaluated, which is the moment bootstrap.ts imports them.
const trace = vi.hoisted(() => [] as string[]);

const userData = vi.hoisted(() => ({ dir: "" }));

const electronMock = vi.hoisted(() => ({
  app: {
    getPath: vi.fn(() => userData.dir),
    exit: vi.fn((code: number) => {
      trace.push(`exit:${code}`);
    }),
  },
}));

vi.mock("electron", () => electronMock);

vi.mock("node:module", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:module")>();
  const enableCompileCache = vi.fn((dir?: string) => {
    trace.push("enableCompileCache");
    expect(fs.existsSync(dir!)).toBe(true);
    return { status: actual.constants.compileCacheStatus.ENABLED, directory: dir };
  });
  const flushCompileCache = vi.fn(() => {
    trace.push("flushCompileCache");
  });
  return { ...actual, default: actual, enableCompileCache, flushCompileCache };
});

vi.mock("../setup/earlyEnvironment.js", () => ({
  installStdioDeadFdGuards: () => trace.push("installStdioDeadFdGuards"),
  applyDevUserDataPath: () => trace.push("applyDevUserDataPath"),
  resetUserDataIfRequested: () => trace.push("resetUserDataIfRequested"),
  applyHeadlessOzoneSwitches: () => trace.push("applyHeadlessOzoneSwitches"),
}));

vi.mock("../remote/buildGate.js", () => ({
  isRemoteHostSupported: () => true,
  isRemoteShellSupported: () => true,
}));

const originalArgv = [...process.argv];
const originalPlatform = process.platform;
const savedDisplay = process.env.DISPLAY;
const savedWayland = process.env.WAYLAND_DISPLAY;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daintree-bootstrap-"));

function restoreEnv(key: "DISPLAY" | "WAYLAND_DISPLAY", value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("bootstrap", () => {
  beforeEach(() => {
    vi.resetModules();
    trace.length = 0;
    electronMock.app.exit.mockClear();
    userData.dir = fs.mkdtempSync(path.join(tempRoot, "userData-"));
    // Registered per test so each import evaluates the factory again: the
    // boot proper (environment setup, migrations, the store and main.js) and
    // the relay record the moment bootstrap.ts imports them.
    vi.doMock("../boot/appBoot.js", () => {
      trace.push("appBoot");
      return {};
    });
    vi.doMock("../remote/client/sshAskpassCli.js", () => {
      trace.push("sshAskpassCli");
      return {
        runSshAskpassCli: async () => {
          trace.push("askpass");
          return 0;
        },
      };
    });
    vi.doMock("../remote/host/attachStdioCli.js", () => {
      trace.push("attachStdioCli");
      return {
        runAttachStdioCli: async () => {
          trace.push("relay");
          return 0;
        },
      };
    });
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
    restoreEnv("DISPLAY", savedDisplay);
    restoreEnv("WAYLAND_DISPLAY", savedWayland);
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("enables the compile cache before importing the boot, and flushes after it", async () => {
    process.argv = ["electron", "bootstrap.js"];

    await import("../bootstrap.js");

    expect(trace).toEqual([
      "installStdioDeadFdGuards",
      "applyDevUserDataPath",
      "resetUserDataIfRequested",
      "enableCompileCache",
      "appBoot",
      "flushCompileCache",
    ]);
    expect(fs.existsSync(path.join(userData.dir, "compile-cache"))).toBe(true);
    expect(electronMock.app.exit).not.toHaveBeenCalled();
  });

  it("enters the --attach-stdio relay with no compile cache, reset or boot", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "bootstrap.js", "--attach-stdio", "--reset-data"];

    // The attach branch never settles: the process exits from inside it.
    void import("../bootstrap.js");
    await vi.waitFor(() => expect(electronMock.app.exit).toHaveBeenCalled());

    expect(trace).toEqual([
      "installStdioDeadFdGuards",
      "applyDevUserDataPath",
      "attachStdioCli",
      "relay",
      "exit:0",
    ]);
    expect(fs.existsSync(path.join(userData.dir, "compile-cache"))).toBe(false);
  });

  it("enters the --ssh-askpass helper with no compile cache, reset or boot", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "bootstrap.js", "--ssh-askpass", "--reset-data"];

    void import("../bootstrap.js");
    await vi.waitFor(() => expect(electronMock.app.exit).toHaveBeenCalled());

    expect(trace).toEqual([
      "installStdioDeadFdGuards",
      "applyDevUserDataPath",
      "sshAskpassCli",
      "askpass",
      "exit:0",
    ]);
    expect(fs.existsSync(path.join(userData.dir, "compile-cache"))).toBe(false);
  });

  it("never answers --ssh-askpass on Windows, which runs no ssh for a host", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    process.argv = ["electron", "bootstrap.js", "--ssh-askpass"];

    await import("../bootstrap.js");

    expect(trace).not.toContain("sshAskpassCli");
    expect(trace).toContain("appBoot");
  });

  it("runs the relay headless on Linux without a display", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    process.argv = ["electron", "bootstrap.js", "--attach-stdio"];

    void import("../bootstrap.js");
    await vi.waitFor(() => expect(electronMock.app.exit).toHaveBeenCalled());

    expect(trace).toEqual([
      "installStdioDeadFdGuards",
      "applyDevUserDataPath",
      "applyHeadlessOzoneSwitches",
      "attachStdioCli",
      "relay",
      "exit:0",
    ]);
  });

  it.each([
    ["the relay's own exit code", async () => 3, 3, ""],
    [
      "1 with the reason when the relay fails",
      async () => {
        throw new Error("no discovery file");
      },
      1,
      "daintree: attach failed: Error: no discovery file\n",
    ],
  ])("exits with %s, still with no boot", async (_label, relay, code, stderr) => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    process.argv = ["electron", "bootstrap.js", "--attach-stdio"];
    vi.doMock("../remote/host/attachStdioCli.js", () => ({ runAttachStdioCli: relay }));
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      void import("../bootstrap.js");
      await vi.waitFor(() => expect(electronMock.app.exit).toHaveBeenCalled());
    } finally {
      write.mockRestore();
    }

    expect(electronMock.app.exit).toHaveBeenCalledWith(code);
    expect(written.filter((chunk) => chunk.startsWith("daintree:")).join("")).toBe(stderr);
    expect(trace).toEqual(["installStdioDeadFdGuards", "applyDevUserDataPath", `exit:${code}`]);
  });
});
