import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import type { FileHandle } from "fs/promises";
import os from "os";
import path from "path";
import { readBoundedFromHandle } from "../boundedRead.js";

let root: string;
let file: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "daintree-bounded-read-"));
  file = path.join(root, "target.txt");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Counts reads, bytes read and the largest buffer read into, on a real descriptor. */
function instrument(handle: FileHandle, onRead?: (call: number) => Promise<void>) {
  const stats = { calls: 0, read: 0, largestBuffer: 0 };
  const realRead = handle.read.bind(handle) as (
    b: Buffer,
    o: number,
    l: number,
    p: null
  ) => Promise<{ bytesRead: number; buffer: Buffer }>;
  const wrapped = {
    read: async (buffer: Buffer, offset: number, length: number, position: null) => {
      await onRead?.(stats.calls);
      stats.calls += 1;
      stats.largestBuffer = Math.max(stats.largestBuffer, buffer.length);
      const result = await realRead(buffer, offset, length, position);
      stats.read += result.bytesRead;
      return result;
    },
  } as unknown as FileHandle;
  return { handle: wrapped, stats };
}

describe("readBoundedFromHandle", () => {
  it("returns a file of exactly the limit", async () => {
    await fs.writeFile(file, "x".repeat(64));
    const handle = await fs.open(file, "r");
    try {
      const bytes = await readBoundedFromHandle(handle, 64, 64);
      expect(bytes?.toString()).toBe("x".repeat(64));
    } finally {
      await handle.close();
    }
  });

  it("rejects one byte over the limit", async () => {
    await fs.writeFile(file, "x".repeat(65));
    const handle = await fs.open(file, "r");
    try {
      expect(await readBoundedFromHandle(handle, 64, 64)).toBeNull();
    } finally {
      await handle.close();
    }
  });

  it("rejects from the size hint without reading", async () => {
    await fs.writeFile(file, "x".repeat(65));
    const handle = await fs.open(file, "r");
    const { handle: counted, stats } = instrument(handle);
    try {
      expect(await readBoundedFromHandle(counted, 65, 64)).toBeNull();
      expect(stats.calls).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("stops at limit + 1 bytes when the file grows after the stat", async () => {
    const limit = 4096;
    await fs.writeFile(file, "a".repeat(100));
    const handle = await fs.open(file, "r");
    const { handle: counted, stats } = instrument(handle, async (call) => {
      // Grow the file far past the budget once the read has started.
      if (call === 1) await fs.appendFile(file, "b".repeat(limit * 16));
    });
    try {
      expect(await readBoundedFromHandle(counted, 100, limit)).toBeNull();
      expect(stats.read).toBe(limit + 1);
      expect(stats.largestBuffer).toBeLessThanOrEqual(limit + 1);
    } finally {
      await handle.close();
    }
  });

  it("returns the grown content when it still fits", async () => {
    await fs.writeFile(file, "a".repeat(10));
    const handle = await fs.open(file, "r");
    const { handle: counted } = instrument(handle, async (call) => {
      if (call === 1) await fs.appendFile(file, "b".repeat(30));
    });
    try {
      const bytes = await readBoundedFromHandle(counted, 10, 64);
      expect(bytes?.toString()).toBe("a".repeat(10) + "b".repeat(30));
    } finally {
      await handle.close();
    }
  });

  it("assembles short reads", async () => {
    const content = Buffer.from("0123456789abcdef");
    let offset = 0;
    const handle = {
      read: async (buffer: Buffer, at: number, length: number) => {
        const n = Math.min(3, length, content.length - offset);
        content.copy(buffer, at, offset, offset + n);
        offset += n;
        return { bytesRead: n, buffer };
      },
    } as unknown as FileHandle;
    const bytes = await readBoundedFromHandle(handle, content.length, 64);
    expect(bytes?.toString()).toBe(content.toString());
  });

  it("returns what is left when the file shrinks after the stat", async () => {
    await fs.writeFile(file, "short");
    const handle = await fs.open(file, "r");
    try {
      const bytes = await readBoundedFromHandle(handle, 1000, 4096);
      expect(bytes?.toString()).toBe("short");
    } finally {
      await handle.close();
    }
  });

  it("stops when the signal aborts", async () => {
    await fs.writeFile(file, "content");
    const handle = await fs.open(file, "r");
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(readBoundedFromHandle(handle, 7, 64, controller.signal)).rejects.toThrow();
    } finally {
      await handle.close();
    }
  });
});
