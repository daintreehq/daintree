import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { findAllOnPath, findOnPath } from "../findOnPath.js";

// The lookup is POSIX-only by contract; Windows callers keep `where.exe`.
describe.skipIf(process.platform === "win32")("findOnPath", () => {
  let root: string;

  function dir(name: string): string {
    const full = path.join(root, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  }

  function file(dirPath: string, name: string, mode: number): string {
    const full = path.join(dirPath, name);
    fs.writeFileSync(full, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(full, mode);
    return full;
  }

  function env(...dirs: string[]): NodeJS.ProcessEnv {
    return { PATH: dirs.join(":") };
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "daintree-findonpath-")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns the first executable in PATH order", async () => {
    const a = dir("a");
    const b = dir("b");
    file(b, "tool", 0o755);
    const first = file(a, "tool", 0o755);

    expect(await findOnPath("tool", { env: env(a, b) })).toBe(first);
  });

  it("skips a file without an execute bit for a later executable one", async () => {
    const a = dir("a");
    const b = dir("b");
    file(a, "tool", 0o644);
    const runnable = file(b, "tool", 0o755);

    expect(await findOnPath("tool", { env: env(a, b) })).toBe(runnable);
    expect(await findOnPath("tool", { env: env(a) })).toBeNull();
  });

  it("skips a directory that carries the command's name", async () => {
    const a = dir("a");
    const b = dir("b");
    fs.mkdirSync(path.join(a, "tool"), { mode: 0o755 });
    const runnable = file(b, "tool", 0o755);

    expect(await findOnPath("tool", { env: env(a, b) })).toBe(runnable);
  });

  it("follows a symlink to an executable and reports the link as found", async () => {
    const store = dir("store");
    const bin = dir("bin");
    const target = file(store, "tool-1.2.3", 0o755);
    const link = path.join(bin, "tool");
    fs.symlinkSync(target, link);

    expect(await findOnPath("tool", { env: env(bin) })).toBe(link);
  });

  it("skips a dangling symlink", async () => {
    const bin = dir("bin");
    const later = dir("later");
    fs.symlinkSync(path.join(root, "gone"), path.join(bin, "tool"));
    const runnable = file(later, "tool", 0o755);

    expect(await findOnPath("tool", { env: env(bin, later) })).toBe(runnable);
  });

  it("never probes an empty or relative PATH entry", async () => {
    const a = dir("a");
    const runnable = file(a, "tool", 0o755);
    const access = vi.spyOn(fs.promises, "access");

    const found = await findOnPath("tool", { env: { PATH: `:relative/bin::${a}:` } });

    expect(found).toBe(runnable);
    expect(access).toHaveBeenCalled();
    for (const [probed] of access.mock.calls) {
      expect(path.isAbsolute(String(probed))).toBe(true);
    }
  });

  it("reports nothing for an empty or missing PATH, or an empty command", async () => {
    const a = dir("a");
    file(a, "tool", 0o755);

    expect(await findOnPath("tool", { env: { PATH: "" } })).toBeNull();
    expect(await findOnPath("tool", { env: {} })).toBeNull();
    expect(await findOnPath("", { env: env(a) })).toBeNull();
  });

  it("checks a command containing a slash as written instead of searching", async () => {
    const a = dir("a");
    const runnable = file(a, "tool", 0o755);
    const inert = file(a, "data", 0o644);
    const elsewhere = dir("elsewhere");
    file(elsewhere, "tool", 0o755);

    expect(await findOnPath(runnable, { env: env(elsewhere) })).toBe(runnable);
    expect(await findOnPath(inert, { env: env(a) })).toBeNull();
  });

  it("searches the PATH it is handed, not the process's", async () => {
    const a = dir("a");
    const runnable = file(a, "daintree-findonpath-only-here", 0o755);

    expect(await findOnPath("daintree-findonpath-only-here")).toBeNull();
    expect(await findOnPath("daintree-findonpath-only-here", { env: env(a) })).toBe(runnable);
  });

  describe("findAllOnPath", () => {
    it("lists every executable match in PATH order", async () => {
      const a = dir("a");
      const b = dir("b");
      const c = dir("c");
      const first = file(a, "tool", 0o755);
      file(b, "tool", 0o644);
      const third = file(c, "tool", 0o755);

      expect(await findAllOnPath("tool", { env: env(a, b, c) })).toEqual([first, third]);
    });

    it("counts a directory listed twice once", async () => {
      const a = dir("a");
      const only = file(a, "tool", 0o755);

      expect(await findAllOnPath("tool", { env: env(a, a) })).toEqual([only]);
    });

    it("counts a symlinked directory alias of the same install once", async () => {
      // The merged-/usr shape: `/bin` is a link to `/usr/bin`, and PATH has both.
      const usrBin = dir("usr-bin");
      const only = file(usrBin, "tool", 0o755);
      const binAlias = path.join(root, "bin");
      fs.symlinkSync(usrBin, binAlias);

      expect(await findAllOnPath("tool", { env: env(usrBin, binAlias) })).toEqual([only]);
    });

    it("keeps two links into the same file as one install, in first-found spelling", async () => {
      const store = dir("store");
      const a = dir("a");
      const b = dir("b");
      const target = file(store, "tool-real", 0o755);
      fs.symlinkSync(target, path.join(a, "tool"));
      fs.symlinkSync(target, path.join(b, "tool"));

      expect(await findAllOnPath("tool", { env: env(a, b) })).toEqual([path.join(a, "tool")]);
    });

    it("returns an empty list when nothing matches", async () => {
      expect(await findAllOnPath("tool", { env: env(dir("a")) })).toEqual([]);
    });
  });

  describe("bounded probing", () => {
    it("gives up after the timeout and reports nothing found", async () => {
      vi.resetModules();
      const fresh = await import("../findOnPath.js");
      const a = dir("a");
      file(a, "tool", 0o755);
      vi.spyOn(fs.promises, "access").mockImplementation(() => new Promise<void>(() => {}));

      const started = Date.now();
      expect(await fresh.findOnPath("tool", { env: env(a), timeoutMs: 30 })).toBeNull();
      expect(await fresh.findAllOnPath("tool", { env: env(a), timeoutMs: 30 })).toEqual([]);
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("never has more than two probes in flight across concurrent lookups", async () => {
      vi.resetModules();
      const fresh = await import("../findOnPath.js");
      const dirs = Array.from({ length: 6 }, (_, i) => dir(`p${i}`));
      let inFlight = 0;
      let peak = 0;
      vi.spyOn(fs.promises, "access").mockImplementation(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const results = await Promise.all(
        ["one", "two", "three", "four"].map((command) =>
          fresh.findAllOnPath(command, { env: env(...dirs) })
        )
      );

      expect(results.every((matches) => matches.length === 0)).toBe(true);
      expect(peak).toBe(2);
    });
  });
});
