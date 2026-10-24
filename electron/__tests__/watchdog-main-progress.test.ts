import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  createMainProgressObserver,
  createMainProgressObserverForUserData,
  type FileFingerprint,
} from "../watchdog-main-progress.js";

describe("createMainProgressObserver", () => {
  function makeObserver() {
    const files = new Map<string, FileFingerprint | null>([
      ["a", { ino: 1, size: 10, mtimeMs: 100, ctimeMs: 100 }],
      ["b", { ino: 2, size: 20, mtimeMs: 100, ctimeMs: 100 }],
    ]);
    const observer = createMainProgressObserver({
      paths: ["a", "b"],
      stat: (p) => files.get(p) ?? null,
    });
    const touch = (p: string, change: Partial<FileFingerprint>) => {
      const fp = files.get(p);
      files.set(p, fp ? { ...fp, ...change } : null);
    };
    return { observer, files, touch };
  }

  it("takes a baseline first, then credits a write to any watched file once", () => {
    const { observer, touch } = makeObserver();
    expect(observer.observe()).toBe(false);
    expect(observer.observe()).toBe(false);

    touch("b", { mtimeMs: 200 });
    expect(observer.observe()).toBe(true);
    expect(observer.observe()).toBe(false);
  });

  it("credits an atomic replace (new inode) and a size change at the same mtime", () => {
    const { observer, touch } = makeObserver();
    observer.observe();
    touch("a", { ino: 9 });
    expect(observer.observe()).toBe(true);
    touch("a", { size: 11 });
    expect(observer.observe()).toBe(true);
    touch("a", { ctimeMs: 400 });
    expect(observer.observe()).toBe(true);
  });

  it("credits nothing for a file that appears, disappears, or whose clock steps back", () => {
    const { observer, files, touch } = makeObserver();
    files.set("a", null);
    observer.observe();
    files.set("a", { ino: 1, size: 10, mtimeMs: 500, ctimeMs: 500 });
    expect(observer.observe()).toBe(false);
    files.set("a", null);
    expect(observer.observe()).toBe(false);

    touch("b", { mtimeMs: 50, ctimeMs: 50 });
    expect(observer.observe()).toBe(false);
  });

  it("forgets the baseline on reset, so writes made before it are not progress", () => {
    const { observer, touch } = makeObserver();
    observer.observe();
    touch("a", { mtimeMs: 300 });
    observer.reset();
    expect(observer.observe()).toBe(false);
  });
});

describe("createMainProgressObserverForUserData", () => {
  let userData: string | null = null;
  afterEach(() => {
    if (userData) fs.rmSync(userData, { recursive: true, force: true });
    userData = null;
  });

  it("credits main's crash marker and session backup, never the shared log", () => {
    userData = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-progress-"));
    fs.mkdirSync(path.join(userData, "backups"));
    fs.mkdirSync(path.join(userData, "logs"));
    const marker = path.join(userData, "running.lock");
    const backup = path.join(userData, "backups", "session-state.json");
    const log = path.join(userData, "logs", "daintree.log");
    for (const file of [marker, backup, log]) fs.writeFileSync(file, "{}");
    const observer = createMainProgressObserverForUserData(userData);
    expect(observer.observe()).toBe(false);

    fs.appendFileSync(log, "a line from the pty host\n");
    expect(observer.observe()).toBe(false);

    fs.writeFileSync(marker, JSON.stringify({ lastHeartbeatMs: 1 }));
    expect(observer.observe()).toBe(true);

    // The backup is replaced atomically: a new file renamed over the old one.
    fs.writeFileSync(`${backup}.tmp`, JSON.stringify({ panels: [] }));
    fs.renameSync(`${backup}.tmp`, backup);
    expect(observer.observe()).toBe(true);
  });
});
