import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";

const { renameTap, dirSyncTap } = vi.hoisted(() => ({
  renameTap: vi.fn(),
  dirSyncTap: vi.fn(),
}));

// The tap records the call and then defers to the real rename; a tap that
// throws stops the real call, which is how a failing attempt is injected.
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      renameTap(...args);
      return actual.renameSync(...args);
    },
  };
});

// Only the parent-directory fsync opens through fs/promises. Its handle's
// sync() is tapped, which is how the directory sync is observed or failed.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await dirSyncTap(args[0]);
        return sync();
      };
      return handle;
    },
  };
});

import { resilientAtomicWriteFileIf } from "../fs.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

describe("resilientAtomicWriteFileIf", () => {
  let tmpDir: string;
  let target: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "daintree-atomic-if-"));
    target = path.join(tmpDir, "session.restore");
    renameTap.mockReset();
    dirSyncTap.mockReset();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  const stragglers = () => readdirSync(tmpDir).filter((name) => name.endsWith(".tmp"));

  it("commits while the check holds", async () => {
    await expect(resilientAtomicWriteFileIf(target, "payload", () => true)).resolves.toBe(true);

    expect(readFileSync(target, "utf8")).toBe("payload");
    expect(stragglers()).toEqual([]);
  });

  it("leaves the target alone and removes its temp file when the check refuses", async () => {
    await expect(resilientAtomicWriteFileIf(target, "payload", () => false)).resolves.toBe(false);

    expect(existsSync(target)).toBe(false);
    expect(renameTap).not.toHaveBeenCalled();
    expect(stragglers()).toEqual([]);
  });

  it("checks again before each retry of a transient rename failure", async () => {
    let current = true;
    renameTap.mockImplementationOnce(() => {
      // The write is superseded while it waits out the lock.
      current = false;
      throw errno("EBUSY");
    });

    await expect(resilientAtomicWriteFileIf(target, "payload", () => current)).resolves.toBe(false);

    expect(renameTap).toHaveBeenCalledTimes(1);
    expect(existsSync(target)).toBe(false);
    expect(stragglers()).toEqual([]);
  });

  it("commits on a later attempt once a transient rename failure clears", async () => {
    renameTap.mockImplementationOnce(() => {
      throw errno("EBUSY");
    });

    await expect(resilientAtomicWriteFileIf(target, "payload", () => true)).resolves.toBe(true);

    expect(renameTap).toHaveBeenCalledTimes(2);
    expect(readFileSync(target, "utf8")).toBe("payload");
  });

  it("rethrows a permanent rename failure and removes its temp file", async () => {
    renameTap.mockImplementationOnce(() => {
      throw errno("ENOSPC");
    });

    await expect(resilientAtomicWriteFileIf(target, "payload", () => true)).rejects.toMatchObject({
      code: "ENOSPC",
    });

    expect(renameTap).toHaveBeenCalledTimes(1);
    expect(existsSync(target)).toBe(false);
    expect(stragglers()).toEqual([]);
  });

  const posixIt = process.platform === "win32" ? it.skip : it;
  const dirSyncs = () => dirSyncTap.mock.calls.filter(([synced]) => synced === tmpDir);

  posixIt("syncs the parent directory after the rename, and not when refused", async () => {
    await resilientAtomicWriteFileIf(target, "payload", () => false);
    expect(dirSyncs()).toEqual([]);

    await resilientAtomicWriteFileIf(target, "payload", () => true);
    expect(dirSyncs()).toEqual([[tmpDir]]);
  });

  posixIt("surfaces a failed directory sync with the file already in place", async () => {
    dirSyncTap.mockRejectedValueOnce(errno("EIO"));

    await expect(resilientAtomicWriteFileIf(target, "payload", () => true)).rejects.toMatchObject({
      code: "EIO",
    });

    expect(readFileSync(target, "utf8")).toBe("payload");
    expect(stragglers()).toEqual([]);
  });

  posixIt("writes the committed file with the requested mode", async () => {
    await resilientAtomicWriteFileIf(target, "payload", () => true, "utf8", { mode: 0o600 });

    expect(statSync(target).mode & 0o777).toBe(0o600);
  });
});
