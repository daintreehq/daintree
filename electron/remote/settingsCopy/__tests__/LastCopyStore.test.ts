// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAST_COPY_MAX_BYTES, LastCopyStore, type LastCopyRecord } from "../LastCopyStore.js";

let dir: string;
let file: string;

const RECORD: LastCopyRecord = {
  copy: {
    id: "0123456789abcdef0123456789abcdef",
    source: "Laptop",
    at: 1_000,
    sections: [{ section: "globalEnvironment", applied: 1, skipped: 0 }],
    undo: "available",
  },
  leaves: [{ section: "globalEnvironment", key: "SHARED", label: "SHARED", before: "old" }],
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "last-copy-"));
  file = path.join(dir, "settings-copy", "last-copy.json");
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("LastCopyStore", () => {
  it("has nothing before the first copy", async () => {
    expect(await new LastCopyStore(file).read()).toBeNull();
  });

  it("keeps the record, readable by this user alone", async () => {
    const store = new LastCopyStore(file);
    await store.write(RECORD);
    expect(await store.read()).toEqual(RECORD);
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  });

  it("drops the undo rather than keep earlier values past the cap", async () => {
    const store = new LastCopyStore(file);
    const huge: LastCopyRecord = {
      ...RECORD,
      leaves: [{ ...RECORD.leaves![0], before: "x".repeat(LAST_COPY_MAX_BYTES) }],
    };
    const kept = await store.write(huge);
    expect(kept).toEqual({ copy: { ...RECORD.copy, undo: "unavailable" } });
    expect(await store.read()).toEqual(kept);
    expect((await fs.stat(file)).size).toBeLessThan(LAST_COPY_MAX_BYTES);
  });

  it("treats an unreadable record as none, rather than offer an undo it can't trust", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{"version":1,"copy":{"id":"nope"}}');
    expect(await new LastCopyStore(file).read()).toBeNull();
  });
});
