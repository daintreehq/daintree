import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConflictMarkerScanEntry } from "../../../../shared/types/ipc/git.js";

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
let resetProjectIo: () => void;
let CONCURRENCY: number;
let SIZE_CAP: number;
let tmp: string;
let cwd: string;

function scanIn(root: string, filePaths: string[]): Promise<ConflictMarkerScanEntry[]> {
  const call = ipcMainMock.handle.mock.calls.find(
    (c: unknown[]) => c[0] === CHANNELS.GIT_SCAN_CONFLICT_MARKERS
  );
  if (!call) throw new Error("Handler for GIT_SCAN_CONFLICT_MARKERS not registered");
  const handle = call[1] as (_e: unknown, payload: unknown) => Promise<ConflictMarkerScanEntry[]>;
  return handle(null, { cwd: root, filePaths });
}

const scan = (filePaths: string[]) => scanIn(cwd, filePaths);

function write(name: string, content: string | Buffer, root = cwd): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

/** `absolute` relative to the worktree, with `/` separators on every platform. */
function relative(absolute: unknown): string {
  return path.relative(cwd, String(absolute)).split(path.sep).join("/");
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
function trackOpenFiles(): { open: () => number; peak: () => number; statted: string[] } {
  let open = 0;
  let peak = 0;
  const statted: string[] = [];
  const realStat = fs.promises.stat.bind(fs.promises);
  const realReadFile = fs.promises.readFile.bind(fs.promises);
  vi.spyOn(fs.promises, "stat").mockImplementation((async (
    ...args: Parameters<typeof realStat>
  ) => {
    statted.push(relative(args[0]));
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
  return { open: () => open, peak: () => peak, statted };
}

beforeAll(async () => {
  ({ CHANNELS } = await import("../../channels.js"));
  ({ _resetRateLimitQueuesForTest: resetRateLimits } = await import("../../utils.js"));
  ({ __resetProjectIoForTests: resetProjectIo } =
    await import("../../../services/projectIoGate.js"));
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetProjectIo();
});

describe("git-write conflict marker scan", () => {
  it("never has more than the bound of files open at once across a large conflict set", async () => {
    const names = writeConflictSet("src", CONCURRENCY * 5 + 3);
    const files = trackOpenFiles();

    const results = await scan(names);

    expect(files.peak()).toBe(CONCURRENCY);
    expect(files.peak()).toBeGreaterThan(1);
    expect(files.open()).toBe(0);
    expect(results).toEqual(names.map(expectedEntry));
  });

  it("starts a later single-file scan of the same worktree before most of a large one", async () => {
    const large = writeConflictSet("large", CONCURRENCY * 4);
    write("one.ts", conflicted(2, 1));
    const files = trackOpenFiles();

    const largeScan = scan(large);
    const single = await scan(["one.ts"]);
    const largeResults = await largeScan;

    expect(single).toEqual([{ path: "one.ts", hunkCount: 1, firstMarkerLine: 3 }]);
    expect(largeResults).toEqual(large.map(expectedEntry));
    // It queued behind a few of the large scan's files, not its whole list.
    expect(files.statted.indexOf("one.ts")).toBeLessThan(files.statted.indexOf(large.at(-1)!));
  });

  it("answers another worktree while one stalls, then degrades the stalled files instead of hanging", async () => {
    const other = path.join(tmp, "other");
    write("stuck.ts", conflicted(0, 1));
    write("after.ts", conflicted(1, 1));
    write("one.ts", conflicted(2, 1), other);

    // A stat that never returns until released, as on a dead network mount.
    let releaseStuck: () => Promise<void> = async () => {};
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, "stat").mockImplementation(((...args: Parameters<typeof realStat>) => {
      if (relative(args[0]) !== "stuck.ts") return realStat(...args);
      return new Promise((resolve) => {
        releaseStuck = async () => {
          resolve(await realStat(...args));
          await nextMacrotask();
        };
      });
    }) as typeof fs.promises.stat);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let stalledSettled = false;
    const stalled = scan(["stuck.ts", "after.ts"]).then((results) => {
      stalledSettled = true;
      return results;
    });

    expect(await scanIn(other, ["one.ts"])).toEqual([
      { path: "one.ts", hunkCount: 1, firstMarkerLine: 3 },
    ]);
    expect(stalledSettled).toBe(false);

    // The read deadline passes: the stuck file and the one queued behind it
    // come back without counts rather than holding the scan open.
    await vi.runOnlyPendingTimersAsync();
    expect(await stalled).toEqual([
      { path: "stuck.ts", hunkCount: null, firstMarkerLine: null },
      { path: "after.ts", hunkCount: null, firstMarkerLine: null },
    ]);

    // Once the mount answers, the worktree's reads resume.
    await releaseStuck();
    expect(await scan(["after.ts"])).toEqual([
      { path: "after.ts", hunkCount: 1, firstMarkerLine: 2 },
    ]);
  });

  it("answers in request order with each file's own counts and lines", async () => {
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
    write("h/at-cap.ts", "x".repeat(SIZE_CAP));
    fs.writeFileSync(path.join(tmp, "outside.ts"), conflicted(0, 1));

    const read: string[] = [];
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    vi.spyOn(fs.promises, "readFile").mockImplementation(((
      ...args: Parameters<typeof realReadFile>
    ) => {
      read.push(relative(args[0]));
      return realReadFile(...args);
    }) as typeof fs.promises.readFile);

    // The traversal and missing paths settle before the files ahead of them.
    expect(
      await scan([
        "a/early.ts",
        "missing.ts",
        "b/bom.ts",
        "../outside.ts",
        "c/clean.ts",
        "d/big.ts",
        "e/dir",
        "f/crlf.ts",
        "g/late.ts",
        "h/at-cap.ts",
      ])
    ).toEqual([
      { path: "a/early.ts", hunkCount: 2, firstMarkerLine: 5 },
      { path: "missing.ts", hunkCount: null, firstMarkerLine: null },
      { path: "b/bom.ts", hunkCount: 1, firstMarkerLine: 1 },
      { path: "../outside.ts", hunkCount: null, firstMarkerLine: null },
      { path: "c/clean.ts", hunkCount: 0, firstMarkerLine: null },
      { path: "d/big.ts", hunkCount: null, firstMarkerLine: null },
      { path: "e/dir", hunkCount: null, firstMarkerLine: null },
      { path: "f/crlf.ts", hunkCount: 3, firstMarkerLine: 3 },
      { path: "g/late.ts", hunkCount: 1, firstMarkerLine: 10 },
      { path: "h/at-cap.ts", hunkCount: 0, firstMarkerLine: null },
    ]);
    expect(read.sort()).toEqual([
      "a/early.ts",
      "b/bom.ts",
      "c/clean.ts",
      "f/crlf.ts",
      "g/late.ts",
      "h/at-cap.ts",
    ]);
  });

  it("answers an empty request without touching the disk", async () => {
    const stat = vi.spyOn(fs.promises, "stat");
    const readFile = vi.spyOn(fs.promises, "readFile");
    expect(await scan([])).toEqual([]);
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
});
