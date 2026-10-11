import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOrCreateDeviceId } from "../deviceId.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rh-device-"));
  dirs.push(dir);
  return path.join(dir, "rh");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readOrCreateDeviceId", () => {
  it("mints an id once and reads the same one back on the next launch", () => {
    const dir = tempDir();
    const first = readOrCreateDeviceId(dir);
    expect(readOrCreateDeviceId(dir)).toBe(first);
    expect(fs.statSync(path.join(dir, "device-id")).mode & 0o777).toBe(0o600);
  });

  it("gives another install its own id", () => {
    expect(readOrCreateDeviceId(tempDir())).not.toBe(readOrCreateDeviceId(tempDir()));
  });

  it("replaces a file that doesn't hold an id", () => {
    const dir = tempDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "device-id"), "not an id");
    const id = readOrCreateDeviceId(dir);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readOrCreateDeviceId(dir)).toBe(id);
  });
});
