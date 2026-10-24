import { describe, it, expect } from "vitest";
import {
  createMainProgressObserver,
  MAIN_PROGRESS_FILES,
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

  it("never watches the log file the utility hosts also write", () => {
    expect(MAIN_PROGRESS_FILES.some((f) => f.includes("daintree.log"))).toBe(false);
  });
});
