import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HostSocketLockTimeoutError,
  hostSocketLockPath,
  processStartTime,
  withHostSocketLock,
} from "../hostSocketLock.js";
import {
  readDiscoveryFile,
  removeDiscoveryFile,
  writeDiscoveryFile,
  type HostDiscoveryInfo,
} from "../discoveryFile.js";
import { makeTempDir, removeTempDir } from "../../link/__tests__/linkTestUtils.js";

let root: string;
let socketPath: string;

beforeEach(async () => {
  root = await makeTempDir();
  socketPath = path.join(root, "host.sock");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await removeTempDir(root);
});

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => child.once("exit", r));
  return child.pid!;
}

describe("withHostSocketLock", () => {
  it("runs holders for one socket path one at a time and removes the lock after", async () => {
    const order: string[] = [];
    let inside = 0;
    const holder = (name: string) =>
      withHostSocketLock(socketPath, async () => {
        inside++;
        expect(inside).toBe(1);
        order.push(`${name}:in`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`${name}:out`);
        inside--;
      });
    await Promise.all([holder("a"), holder("b"), holder("c")]);
    expect(order).toEqual(["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
    expect(existsSync(hostSocketLockPath(socketPath))).toBe(false);
  });

  it("releases the lock when the holder throws", async () => {
    await expect(
      withHostSocketLock(socketPath, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    await expect(withHostSocketLock(socketPath, async () => "next")).resolves.toBe("next");
  });

  it("breaks a lock left by a process that is gone", async () => {
    await fs.writeFile(hostSocketLockPath(socketPath), JSON.stringify({ pid: await deadPid() }));
    await expect(withHostSocketLock(socketPath, async () => "ran")).resolves.toBe("ran");
    expect(existsSync(hostSocketLockPath(socketPath))).toBe(false);
  });

  it("leaves a stale lock to the waiter already breaking it, and recovers from a dead breaker", async () => {
    const lockPath = hostSocketLockPath(socketPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: await deadPid() }));
    const breakerPath = `${lockPath}.break`;
    await fs.writeFile(breakerPath, "");
    await expect(
      withHostSocketLock(socketPath, async () => {}, { timeoutMs: 100, retryMs: 10 })
    ).rejects.toBeInstanceOf(HostSocketLockTimeoutError);
    expect(existsSync(lockPath)).toBe(true);

    const past = new Date(Date.now() - 60_000);
    await fs.utimes(breakerPath, past, past);
    await expect(withHostSocketLock(socketPath, async () => "ran", { retryMs: 10 })).resolves.toBe(
      "ran"
    );
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(breakerPath)).toBe(false);
  });

  it("waits for a lock another live process holds, then gives up", async () => {
    const lockPath = hostSocketLockPath(socketPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid }));
    const fn = vi.fn(async () => {});
    await expect(
      withHostSocketLock(socketPath, fn, { timeoutMs: 150, retryMs: 10 })
    ).rejects.toBeInstanceOf(HostSocketLockTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("never breaks a live owner's lock however old it is", async () => {
    const lockPath = hostSocketLockPath(socketPath);
    await fs.writeFile(lockPath, JSON.stringify({ pid: process.ppid }));
    const past = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(lockPath, past, past);
    const fn = vi.fn(async () => "ran");
    await expect(
      withHostSocketLock(socketPath, fn, { staleMs: 30_000, timeoutMs: 150, retryMs: 10 })
    ).rejects.toBeInstanceOf(HostSocketLockTimeoutError);
    expect(fn).not.toHaveBeenCalled();
    expect(existsSync(lockPath)).toBe(true);
  });

  it("takes over an old lock that names no readable owner", async () => {
    const lockPath = hostSocketLockPath(socketPath);
    await fs.writeFile(lockPath, "");
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(lockPath, past, past);
    await expect(
      withHostSocketLock(socketPath, async () => "ran", { staleMs: 30_000, retryMs: 10 })
    ).resolves.toBe("ran");
  });

  it("waits out a fresh lock that names no readable owner", async () => {
    await fs.writeFile(hostSocketLockPath(socketPath), "");
    await expect(
      withHostSocketLock(socketPath, async () => "ran", { timeoutMs: 100, retryMs: 10 })
    ).rejects.toBeInstanceOf(HostSocketLockTimeoutError);
  });

  it.runIf(process.platform === "linux")(
    "breaks a lock whose pid now belongs to a later process",
    async () => {
      await fs.writeFile(
        hostSocketLockPath(socketPath),
        JSON.stringify({ pid: process.ppid, start: "0" })
      );
      await expect(withHostSocketLock(socketPath, async () => "ran")).resolves.toBe("ran");
    }
  );

  it("records its own pid and start time in the lock it holds", async () => {
    const seen = await withHostSocketLock(socketPath, async () =>
      JSON.parse(await fs.readFile(hostSocketLockPath(socketPath), "utf8"))
    );
    expect(seen.pid).toBe(process.pid);
    expect(seen.start).toBe(processStartTime(process.pid));
  });
});

describe("removeDiscoveryFile", () => {
  const info = (token: string): HostDiscoveryInfo => ({
    version: 1,
    socketPath: "/x.sock",
    token,
    pid: 1,
  });

  it("never deletes a replacement published between the token check and the removal", async () => {
    const filePath = path.join(root, "host.json");
    const mine = info("a".repeat(64));
    const theirs = info("b".repeat(64));
    await writeDiscoveryFile(filePath, mine);

    const realRename = fs.rename.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      // The next launch publishes its file right after our token check.
      if (!replaced && String(from) === filePath) {
        replaced = true;
        await writeDiscoveryFile(filePath, theirs);
      }
      return realRename(from, to);
    });

    expect(await removeDiscoveryFile(filePath, mine.token)).toBe(false);
    expect(replaced).toBe(true);
    expect(await readDiscoveryFile(filePath)).toEqual(theirs);
    const leftovers = (await fs.readdir(root)).filter((name) => name !== "host.json");
    expect(leftovers).toEqual([]);
  });

  it("removes the file while it still carries this launch's token", async () => {
    const filePath = path.join(root, "host.json");
    await writeDiscoveryFile(filePath, info("a".repeat(64)));
    expect(await removeDiscoveryFile(filePath, "a".repeat(64))).toBe(true);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
