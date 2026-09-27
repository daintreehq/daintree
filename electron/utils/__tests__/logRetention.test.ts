import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOldestRetainedLogMs } from "../logRetention.js";

describe("readOldestRetainedLogMs", () => {
  let dir: string;
  const active = () => path.join(dir, "daintree.log");
  const write = (name: string, content: string) =>
    fs.writeFileSync(path.join(dir, name), content, "utf8");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-retention-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no log exists", async () => {
    expect(await readOldestRetainedLogMs(dir, active())).toBe(null);
  });

  it("reads the first line of the active log when nothing has rotated", async () => {
    write("daintree.log", "[2026-09-01T10:00:00.000Z] [INFO] boot\n[2026-09-02T10:00:00.000Z] x\n");
    expect(await readOldestRetainedLogMs(dir, active())).toBe(
      Date.parse("2026-09-01T10:00:00.000Z")
    );
  });

  it("reads the highest-numbered rotated file, not the newest", async () => {
    write("daintree.log", "[2026-09-05T00:00:00.000Z] [INFO] now\n");
    write("daintree.log.1", "[2026-09-04T00:00:00.000Z] [INFO] a\n");
    write("daintree.log.3", "[2026-09-02T00:00:00.000Z] [INFO] b\n");
    expect(await readOldestRetainedLogMs(dir, active())).toBe(
      Date.parse("2026-09-02T00:00:00.000Z")
    );
  });

  it("returns null when the oldest file doesn't start with a timestamp", async () => {
    write("daintree.log", "[2026-09-05T00:00:00.000Z] [INFO] now\n");
    write("daintree.log.2", "partial line from a torn write\n");
    expect(await readOldestRetainedLogMs(dir, active())).toBe(null);
  });

  it("returns null for an empty active log", async () => {
    write("daintree.log", "");
    expect(await readOldestRetainedLogMs(dir, active())).toBe(null);
  });
});
