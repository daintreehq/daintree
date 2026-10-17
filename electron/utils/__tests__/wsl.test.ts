import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectWslPath } from "../wsl.js";

describe("detectWslPath", () => {
  it("returns null for plain Windows drive paths", () => {
    expect(detectWslPath("C:\\repos\\project")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(detectWslPath(undefined as unknown as string)).toBeNull();
    expect(detectWslPath(null as unknown as string)).toBeNull();
  });

  it("parses \\\\wsl$\\<distro>\\<path>", () => {
    const result = detectWslPath("\\\\wsl$\\Ubuntu\\home\\user\\project");
    expect(result).toEqual({ distro: "Ubuntu", posixPath: "/home/user/project" });
  });

  it("parses \\\\wsl.localhost\\<distro>\\<path>", () => {
    const result = detectWslPath("\\\\wsl.localhost\\Debian\\home\\dev\\app");
    expect(result).toEqual({ distro: "Debian", posixPath: "/home/dev/app" });
  });

  it("matches case-insensitively on the wsl prefix", () => {
    expect(detectWslPath("\\\\WSL$\\Ubuntu\\home")).toEqual({
      distro: "Ubuntu",
      posixPath: "/home",
    });
    expect(detectWslPath("\\\\Wsl.LocalHost\\Ubuntu\\home")).toEqual({
      distro: "Ubuntu",
      posixPath: "/home",
    });
  });

  it("returns / for the distro root", () => {
    expect(detectWslPath("\\\\wsl$\\Ubuntu")).toEqual({
      distro: "Ubuntu",
      posixPath: "/",
    });
    expect(detectWslPath("\\\\wsl$\\Ubuntu\\")).toEqual({
      distro: "Ubuntu",
      posixPath: "/",
    });
  });
});

type ExecFileCallback = (
  err: Error | null,
  stdout: Buffer | string,
  stderr?: Buffer | string
) => void;
const execFileMock = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

/** Build a UTF-16LE buffer with BOM, mirroring real `wsl.exe` output. */
function utf16le(text: string): Buffer {
  const body = Buffer.from(text, "utf16le");
  const bom = Buffer.from([0xff, 0xfe]);
  return Buffer.concat([bom, body]);
}

/** Build a UTF-8 buffer, mirroring `WSL_UTF8=1` output. */
function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

const originalPlatform = process.platform;

describe("getDefaultWslDistro", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns null on non-Windows platforms without spawning wsl.exe", async () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const { getDefaultWslDistro } = await import("../wsl.js");
    const result = await getDefaultWslDistro();
    expect(result).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns the distro marked with * (UTF-16LE) when default is NOT first", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // Real `wsl --list --verbose` output: header + entries, with `*` on the
    // default. Here Ubuntu-22.04 is registered first but Debian is the default.
    const stdout =
      "  NAME            STATE           VERSION\r\n" +
      "  Ubuntu-22.04    Stopped         2\r\n" +
      "* Debian          Running         2\r\n" +
      "  Alpine          Stopped         2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf16le(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Debian");
  });

  it("returns the distro marked with * (UTF-8) on single-distro hosts", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const stdout = "  NAME      STATE           VERSION\r\n" + "* Ubuntu    Running         2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Ubuntu");
  });

  it("handles distro names containing spaces (e.g. 'Ubuntu 22.04 LTS')", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const stdout =
      "  NAME                STATE           VERSION\r\n" +
      "* Ubuntu 22.04 LTS    Running         2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Ubuntu 22.04 LTS");
  });

  it("still finds the default on a localized Windows host (translated header/state)", async () => {
    // German Windows: header "NAME STATUS VERSION", state "Wird ausgeführt"
    // ("Running"). The `*` marker is the only locale-independent signal.
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const stdout =
      "  NAME            STATUS               VERSION\r\n" +
      "* Ubuntu          Wird ausgeführt      2\r\n" +
      "  Debian          Beendet              2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf16le(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Ubuntu");
  });

  it("returns null when no line is marked with *", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const stdout =
      "  NAME            STATE           VERSION\r\n" + "  Ubuntu          Stopped         2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBeNull();
  });

  it("returns null when wsl.exe fails to spawn", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(new Error("ENOENT: wsl.exe not found"), Buffer.alloc(0))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBeNull();
  });

  it("invokes wsl.exe with --list --verbose and the decode-critical options", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8("  NAME  STATE  VERSION\r\n* Ubuntu  Running  2\r\n"))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    await getDefaultWslDistro();

    expect(execFileMock).toHaveBeenCalledOnce();
    const [file, args, opts] = execFileMock.mock.calls[0];
    expect(file).toMatch(/^[A-Za-z]:\\.*\\System32\\wsl\.exe$/i);
    expect(args).toEqual(["--list", "--verbose"]);
    // These options are load-bearing: `encoding: "buffer"` is what lets the
    // UTF-16LE heuristic run; without it Node decodes stdout as UTF-8 and the
    // pre-WSL_UTF8 path silently mangles distro names.
    expect(opts).toMatchObject({
      encoding: "buffer",
      windowsHide: true,
      timeout: 5_000,
    });
    expect(opts.env.WSL_UTF8).toBe("1");
  });

  it("decodes UTF-16LE without BOM via the null-byte heuristic", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // No BOM; rely on the >1/3-null-bytes heuristic to pick UTF-16LE.
    const stdout =
      "  NAME            STATE           VERSION\r\n" + "* Fedora          Running         2\r\n";
    const buf = Buffer.from(stdout, "utf16le");
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) => cb(null, buf));

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Fedora");
  });

  it("ignores a `*`-prefixed banner line and still finds the real default", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // Some WSL builds emit advisory/banner text before the table — guard
    // against a `*`-prefixed banner being mistaken for the default-marker row.
    // A banner line lacks the 2+ space column gap that signals a real entry.
    const stdout =
      "*ImportantNotice: update WSL via Windows Update*\r\n" +
      "  NAME            STATE           VERSION\r\n" +
      "  Ubuntu          Stopped         2\r\n" +
      "* Debian          Running         2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8(stdout))
    );

    const { getDefaultWslDistro } = await import("../wsl.js");
    expect(await getDefaultWslDistro()).toBe("Debian");
  });
});

describe("listWslDistros", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileMock.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("returns null on non-Windows platforms without spawning wsl.exe", async () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const { listWslDistros } = await import("../wsl.js");
    expect(await listWslDistros()).toBeNull();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("lists every distro with its version and the default marked, header skipped", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    // As WSL 3.0.3 prints it on the Windows test laptop.
    const stdout =
      "  NAME              STATE           VERSION\r\n" +
      "* Ubuntu-24.04      Stopped         2\r\n" +
      "  FedoraLinux-44    Running         2\r\n" +
      "  Legacy            Stopped         1\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf16le(stdout))
    );
    const { listWslDistros } = await import("../wsl.js");
    expect(await listWslDistros()).toEqual([
      { name: "Ubuntu-24.04", isDefault: true, version: 2, state: "Stopped" },
      { name: "FedoraLinux-44", isDefault: false, version: 2, state: "Running" },
      { name: "Legacy", isDefault: false, version: 1, state: "Stopped" },
    ]);
  });

  it("reads a translated header and state without matching on either", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const stdout =
      "  NAME            STATUS               VERSION\r\n" +
      "  Ubuntu          Wird ausgeführt      2\r\n";
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(null, utf8(stdout))
    );
    const { listWslDistros } = await import("../wsl.js");
    expect(await listWslDistros()).toEqual([
      { name: "Ubuntu", isDefault: false, version: 2, state: "Wird ausgeführt" },
    ]);
  });

  it("is an empty list when WSL is installed with no distro (non-zero exit, a hint on stdout)", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const exit = Object.assign(new Error("Command failed"), { code: 4294967295 });
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(exit, utf8("Windows Subsystem for Linux has no installed distributions.\r\n"))
    );
    const { listWslDistros } = await import("../wsl.js");
    expect(await listWslDistros()).toEqual([]);
  });

  it("is null when wsl.exe can't be started", async () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const missing = Object.assign(new Error("spawn wsl.exe ENOENT"), { code: "ENOENT" });
    execFileMock.mockImplementation((_file, _args, _opts, cb: ExecFileCallback) =>
      cb(missing, Buffer.alloc(0))
    );
    const { listWslDistros } = await import("../wsl.js");
    expect(await listWslDistros()).toBeNull();
  });
});
