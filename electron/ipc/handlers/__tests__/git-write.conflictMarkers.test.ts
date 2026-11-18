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
  return { path: name, hunkCount: (i % 3) + 1, hasMarkers: true, firstMarkerLine: i + 1 };
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
  ({ STAGED_FILE_SIZE_CAP: SIZE_CAP } =
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
  it("reads one file at a time across a large conflict set", async () => {
    const names = writeConflictSet("src", 40);
    const files = trackOpenFiles();

    const results = await scan(names);

    expect(files.peak()).toBe(1);
    expect(files.open()).toBe(0);
    expect(results).toEqual(names.map(expectedEntry));
  });

  it("starts a later single-file scan of the same worktree before most of a large one", async () => {
    const large = writeConflictSet("large", 32);
    write("one.ts", conflicted(2, 1));
    const files = trackOpenFiles();

    const [largeResults, single] = await Promise.all([scan(large), scan(["one.ts"])]);

    expect(single).toEqual([
      { path: "one.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 3 },
    ]);
    expect(largeResults).toEqual(large.map(expectedEntry));
    // It queued behind the large scan's current file, not its whole list.
    expect(files.statted.indexOf("one.ts")).toBe(1);
  });

  it.each(["stat", "readFile"] as const)(
    "answers another worktree while a %s stalls, and fails the stalled worktree's scans instead of hanging",
    async (call) => {
      const other = path.join(tmp, "other");
      write("stuck.ts", conflicted(0, 1));
      write("after.ts", conflicted(1, 1));
      write("one.ts", conflicted(2, 1), other);

      // A call that never returns until released, as on a dead network mount.
      let releaseStuck: () => Promise<void> = async () => {};
      let enterStuck: () => void = () => {};
      const stuckEntered = new Promise<void>((resolve) => (enterStuck = resolve));
      const real = fs.promises[call].bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
      vi.spyOn(fs.promises, call).mockImplementation(((...args: unknown[]) => {
        if (relative(args[0]) !== "stuck.ts") return real(...args);
        enterStuck();
        return new Promise((resolve) => {
          releaseStuck = async () => {
            resolve(await real(...args));
            await nextMacrotask();
          };
        });
      }) as never);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      let stalledSettled = false;
      const stalled = scan(["stuck.ts", "after.ts"]);
      stalled.then(
        () => (stalledSettled = true),
        () => (stalledSettled = true)
      );

      expect(await scanIn(other, ["one.ts"])).toEqual([
        { path: "one.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 3 },
      ]);
      expect(stalledSettled).toBe(false);
      await stuckEntered;

      // Past the read deadline the scan fails rather than answering with
      // skipped entries the renderer could take for a deletion's missing file.
      await vi.runOnlyPendingTimersAsync();
      await expect(stalled).rejects.toMatchObject({ code: "PROJECT_IO_STALLED" });
      // A later scan of that worktree fails at once while the read is still out.
      await expect(scan(["after.ts"])).rejects.toMatchObject({ code: "PROJECT_IO_STALLED" });

      // Once the mount answers, the worktree's reads resume.
      await releaseStuck();
      expect(await scan(["after.ts"])).toEqual([
        { path: "after.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 2 },
      ]);
    }
  );

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
      { path: "a/early.ts", hunkCount: 2, hasMarkers: true, firstMarkerLine: 5 },
      { path: "missing.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "b/bom.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 1 },
      { path: "../outside.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "c/clean.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
      { path: "d/big.ts", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "e/dir", hunkCount: null, hasMarkers: null, firstMarkerLine: null },
      { path: "f/crlf.ts", hunkCount: 3, hasMarkers: true, firstMarkerLine: 3 },
      { path: "g/late.ts", hunkCount: 1, hasMarkers: true, firstMarkerLine: 10 },
      { path: "h/at-cap.ts", hunkCount: 0, hasMarkers: false, firstMarkerLine: null },
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
