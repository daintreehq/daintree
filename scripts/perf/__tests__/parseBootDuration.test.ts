import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  countCompileCacheFiles,
  parseBootDuration,
  REQUIRED_BOOT_MARKS,
} from "../lib/packagedLaunch";
import { PERF_MARKS } from "../../../shared/perf/marks";

interface MarkLine {
  mark: string;
  timestamp: string;
  elapsedMs: number;
  meta?: Record<string, unknown>;
}

function writeNdjson(lines: MarkLine[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-boot-"));
  const file = path.join(dir, "perf-metrics.ndjson");
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

describe("parseBootDuration", () => {
  const tmpFiles: string[] = [];

  beforeEach(() => {
    tmpFiles.length = 0;
  });

  afterEach(() => {
    for (const file of tmpFiles) {
      try {
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("uses RENDERER_FIRST_INTERACTIVE elapsedMs minus APP_BOOT_START elapsedMs as the headline duration", () => {
    const file = writeNdjson([
      { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
      { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 800 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 1200 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.durationMs).toBe(1200);
    expect(result.metrics.rendererReadyMs).toBe(800);
    expect(result.degraded).toBeUndefined();
  });

  it("falls back to RENDERER_READY with a degraded note when FIRST_INTERACTIVE is missing", () => {
    const file = writeNdjson([
      { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
      { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 800 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.durationMs).toBe(800);
    expect(result.degraded).toContain("FIRST_INTERACTIVE");
    expect(result.metrics.rendererReadyMs).toBe(800);
  });

  it("returns -1 when both RENDERER_READY and RENDERER_FIRST_INTERACTIVE are missing", () => {
    const file = writeNdjson([{ mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 }]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.durationMs).toBe(-1);
  });

  it("returns -1 when APP_BOOT_START is missing", () => {
    const file = writeNdjson([
      { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 800 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 1200 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.durationMs).toBe(-1);
  });

  it("returns -1 when the ndjson file does not exist", () => {
    const result = parseBootDuration(path.join(os.tmpdir(), "definitely-missing-perf.ndjson"));
    expect(result.durationMs).toBe(-1);
  });

  it("uses the first occurrence of a duplicate mark (first-wins), matching aggregate semantics", () => {
    // RENDERER_FIRST_INTERACTIVE has an idempotency guard in the renderer,
    // but if it somehow appeared twice we must take the first value to stay
    // consistent with aggregate()'s firstByMark policy.
    const file = writeNdjson([
      { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 1200 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 9000 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.durationMs).toBe(1200);
  });

  it("populates serviceInitMs and hydrateMs metrics when those phase marks exist", () => {
    const file = writeNdjson([
      { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
      { mark: PERF_MARKS.SERVICE_INIT_START, timestamp: "t", elapsedMs: 100 },
      { mark: PERF_MARKS.SERVICE_INIT_COMPLETE, timestamp: "t", elapsedMs: 400 },
      { mark: PERF_MARKS.HYDRATE_START, timestamp: "t", elapsedMs: 500 },
      { mark: PERF_MARKS.HYDRATE_COMPLETE, timestamp: "t", elapsedMs: 900 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 1200 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.metrics.serviceInitMs).toBe(300);
    expect(result.metrics.hydrateMs).toBe(400);
    expect(result.durationMs).toBe(1200);
  });

  it("reports bootMarkMisses 0 only when every canonical boot mark is present", () => {
    const file = writeNdjson(
      REQUIRED_BOOT_MARKS.map((mark, index) => ({
        mark,
        timestamp: "t",
        elapsedMs: index * 100,
      }))
    );
    tmpFiles.push(file);

    expect(parseBootDuration(file).metrics.bootMarkMisses).toBe(0);
  });

  it("counts the canonical boot marks a launch failed to emit", () => {
    // PERF-004's headline is a mark-to-mark duration, so a boot missing the
    // phase marks reports fewer metrics rather than a worse one. Without this
    // count that reads as a clean run.
    const file = writeNdjson([
      { mark: PERF_MARKS.APP_BOOT_START, timestamp: "t", elapsedMs: 0 },
      { mark: PERF_MARKS.RENDERER_READY, timestamp: "t", elapsedMs: 800 },
      { mark: PERF_MARKS.RENDERER_FIRST_INTERACTIVE, timestamp: "t", elapsedMs: 1200 },
    ]);
    tmpFiles.push(file);

    const result = parseBootDuration(file);

    expect(result.metrics.bootMarkMisses).toBe(REQUIRED_BOOT_MARKS.length - 3);
    expect(result.metrics.serviceInitMs).toBeUndefined();
  });

  it("emits bootMarkMisses even when the ndjson file never appeared", () => {
    const result = parseBootDuration(path.join(os.tmpdir(), "definitely-missing-perf.ndjson"));
    expect(result.metrics.bootMarkMisses).toBe(REQUIRED_BOOT_MARKS.length);
  });
});

describe("countCompileCacheFiles", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    tmpDirs.length = 0;
  });

  function makeUserDataDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-ccfiles-"));
    tmpDirs.push(dir);
    return dir;
  }

  it("returns 0 when the compile-cache dir does not exist", () => {
    expect(countCompileCacheFiles(makeUserDataDir())).toBe(0);
  });

  it("returns 0 for an empty compile-cache dir (cache never written)", () => {
    const userDataDir = makeUserDataDir();
    fs.mkdirSync(path.join(userDataDir, "compile-cache"));
    expect(countCompileCacheFiles(userDataDir)).toBe(0);
  });

  it("sums cache files inside the versioned subdir rather than counting the base dir", () => {
    // Node nests cache files one level down: compile-cache/<version>/<hash files>.
    // Counting the base dir would report 1 (the subdir); we want the file count.
    const userDataDir = makeUserDataDir();
    const versioned = path.join(userDataDir, "compile-cache", "v22.0.0-arm64-abcd1234");
    fs.mkdirSync(versioned, { recursive: true });
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(versioned, `cache-${i}.bin`), "x");
    }
    expect(countCompileCacheFiles(userDataDir)).toBe(5);
  });

  it("sums across multiple versioned subdirs (e.g. after an app upgrade)", () => {
    const userDataDir = makeUserDataDir();
    const base = path.join(userDataDir, "compile-cache");
    const v1 = path.join(base, "v22.0.0-arm64-aaaa");
    const v2 = path.join(base, "v22.1.0-arm64-bbbb");
    fs.mkdirSync(v1, { recursive: true });
    fs.mkdirSync(v2, { recursive: true });
    fs.writeFileSync(path.join(v1, "a.bin"), "x");
    fs.writeFileSync(path.join(v1, "b.bin"), "x");
    fs.writeFileSync(path.join(v2, "c.bin"), "x");
    expect(countCompileCacheFiles(userDataDir)).toBe(3);
  });
});
