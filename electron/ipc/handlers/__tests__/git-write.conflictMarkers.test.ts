import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConflictMarkerScanEntry } from "../../../../shared/types/git.js";

const ipcMainMock = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: ipcMainMock,
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
    getAllWindows: vi.fn(() => []),
  },
  webContents: { fromId: vi.fn(() => null) },
}));

vi.mock("../../../store.js", () => ({
  store: { get: vi.fn().mockReturnValue({ uiFeedbackSoundEnabled: false }) },
}));

vi.mock("../../../services/SoundService.js", () => ({
  soundService: { play: vi.fn() },
}));

vi.mock("../../../services/getSoundService.js", () => ({
  getSoundService: vi.fn().mockResolvedValue({ play: vi.fn() }),
}));

let CHANNELS: typeof import("../../channels.js").CHANNELS;
let resetRateLimits: () => void;
let CONCURRENCY: number;
let SIZE_CAP: number;
let tmp: string;
let cwd: string;

function scan(filePaths: string[]): Promise<ConflictMarkerScanEntry[]> {
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === CHANNELS.GIT_SCAN_CONFLICT_MARKERS
  );
  if (!call) throw new Error("Handler for GIT_SCAN_CONFLICT_MARKERS not registered");
  const handle = call[1] as (_e: unknown, payload: unknown) => Promise<ConflictMarkerScanEntry[]>;
  return handle(null, { cwd, filePaths });
}

function write(name: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true });
  fs.writeFileSync(path.join(cwd, name), content);
}

function conflicted(before: number, hunks: number): string {
  const lines = Array.from({ length: before }, (_, i) => `line ${i + 1}`);
  for (let h = 0; h < hunks; h++) {
    lines.push("<<<<<<< HEAD", "ours", "=======", "theirs", ">>>>>>> side", "between");
  }
  return lines.join("\n") + "\n";
}

const nextMacrotask = () => new Promise<void>((resolve) => setImmediate(resolve));

/** `count` files under `dir`, the i-th with (i % 3) + 1 hunks opening on line i + 1. */
function writeConflictSet(dir: string, count: number): string[] {
  const names = Array.from({ length: count }, (_, i) => `${dir}/file-${i}.ts`);
  names.forEach((name, i) => write(name, conflicted(i, (i % 3) + 1)));
  return names;
}

function expectedEntry(name: string): ConflictMarkerScanEntry {
  const i = Number(/file-(\d+)\.ts$/.exec(name)![1]);
  return { path: name, hunkCount: (i % 3) + 1, firstMarkerLine: i + 1 };
}

/**
 * A file is open from its stat until its read settles. Both calls yield a
 * macrotask first, so every file the handler starts at once overlaps the rest.
 */
function trackOpenFiles(): { open: () => number; peak: () => number } {
  let open = 0;
  let peak = 0;
  const realStat = fs.promises.stat.bind(fs.promises);
  const realReadFile = fs.promises.readFile.bind(fs.promises);
  vi.spyOn(fs.promises, "stat").mockImplementation((async (
    ...args: Parameters<typeof realStat>
  ) => {
    open++;
    peak = Math.max(peak, open);
    await nextMacrotask();
    return realStat(...args);
  }) as typeof fs.promises.stat);
  vi.spyOn(fs.promises, "readFile").mockImplementation((async (
    ...args: Parameters<typeof realReadFile>
  ) => {
    try {
      await nextMacrotask();
      return await realReadFile(...args);
    } finally {
      open--;
    }
  }) as typeof fs.promises.readFile);
  return { open: () => open, peak: () => peak };
}

beforeAll(async () => {
  ({ CHANNELS } = await import("../../channels.js"));
  ({ _resetRateLimitQueuesForTest: resetRateLimits } = await import("../../utils.js"));
  ({ CONFLICT_MARKER_SCAN_CONCURRENCY: CONCURRENCY, STAGED_FILE_SIZE_CAP: SIZE_CAP } =
    await import("../../../services/git/conflictMarkerScan.js"));
  const { registerGitWriteHandlers } = await import("../git-write.js");
  registerGitWriteHandlers({} as never);
});

beforeEach(() => {
  resetRateLimits();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-write-conflict-markers-")));
  cwd = path.join(tmp, "worktree");
  fs.mkdirSync(cwd);
  return () => fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("git-write conflict marker scan", () => {
  it("never has more than the bound of files open at once across a large conflict set", async () => {
    const names = writeConflictSet("src", CONCURRENCY * 5 + 3);
    const files = trackOpenFiles();

    const results = await scan(names);

    expect(files.peak()).toBe(CONCURRENCY);
    expect(files.open()).toBe(0);
    expect(results).toEqual(names.map(expectedEntry));
  });

  it("shares the bound across overlapping scans and answers a later single-file scan first", async () => {
    const first = writeConflictSet("first", CONCURRENCY * 4);
    const second = writeConflictSet("second", CONCURRENCY * 4);
    write("one.ts", conflicted(2, 1));
    const files = trackOpenFiles();

    let firstSettled = false;
    const firstScan = scan(first).then((results) => {
      firstSettled = true;
      return results;
    });
    const secondScan = scan(second);
    // A rescan the renderer has already superseded keeps reading; the newer
    // single-file scan still lands without waiting for its whole list.
    expect(await scan(["one.ts"])).toEqual([{ path: "one.ts", hunkCount: 1, firstMarkerLine: 3 }]);
    expect(firstSettled).toBe(false);

    expect(await firstScan).toEqual(first.map(expectedEntry));
    expect(await secondScan).toEqual(second.map(expectedEntry));
    expect(files.peak()).toBe(CONCURRENCY);
    expect(files.open()).toBe(0);
  });

  it("answers in request order with each file's own counts when reads finish out of order", async () => {
    write("a/early.ts", conflicted(4, 2));
    write(
      "b/bom.ts",
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(conflicted(0, 1))])
    );
    write("c/clean.ts", "no markers here\n");
    write("d/big.ts", "x".repeat(SIZE_CAP + 1));
    fs.mkdirSync(path.join(cwd, "e/dir"), { recursive: true });
    write("f/crlf.ts", conflicted(2, 3).replace(/\n/g, "\r\n"));
    write("g/late.ts", conflicted(9, 1));
    fs.writeFileSync(path.join(tmp, "outside.ts"), conflicted(0, 1));
    const request = [
      "a/early.ts",
      "missing.ts",
      "b/bom.ts",
      "../outside.ts",
      "c/clean.ts",
      "d/big.ts",
      "e/dir",
      "f/crlf.ts",
      "g/late.ts",
    ];

    // Earlier paths read slowest, so they settle last.
    const read: string[] = [];
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation((async (
      ...args: Parameters<typeof realReadFile>
    ) => {
      const rel = path.relative(cwd, String(args[0]));
      read.push(rel);
      const delay = request.length - request.indexOf(rel);
      for (let i = 0; i < delay; i++) await nextMacrotask();
      return realReadFile(...args);
    }) as typeof fs.promises.readFile);

    expect(await scan(request)).toEqual([
      { path: "a/early.ts", hunkCount: 2, firstMarkerLine: 5 },
      { path: "missing.ts", hunkCount: null, firstMarkerLine: null },
      { path: "b/bom.ts", hunkCount: 1, firstMarkerLine: 1 },
      { path: "../outside.ts", hunkCount: null, firstMarkerLine: null },
      { path: "c/clean.ts", hunkCount: 0, firstMarkerLine: null },
      { path: "d/big.ts", hunkCount: null, firstMarkerLine: null },
      { path: "e/dir", hunkCount: null, firstMarkerLine: null },
      { path: "f/crlf.ts", hunkCount: 3, firstMarkerLine: 3 },
      { path: "g/late.ts", hunkCount: 1, firstMarkerLine: 10 },
    ]);
    expect(read.sort()).toEqual(["a/early.ts", "b/bom.ts", "c/clean.ts", "f/crlf.ts", "g/late.ts"]);
  });

  it("answers an empty request without touching the disk", async () => {
    const stat = vi.spyOn(fs.promises, "stat");
    expect(await scan([])).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
  });
});
