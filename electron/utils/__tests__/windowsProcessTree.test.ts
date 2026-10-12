import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  creationTimeMicros,
  terminateWindowsProcesses,
  walkVerifiedTree,
  type WindowsProcessRow,
} from "../windowsProcessTree.js";

// Far above any real PID on the test host, so nothing here can name a live process.
const ROOT = 7_100_000;
const CHILD = 7_100_001;
const GRANDCHILD = 7_100_002;
const SIBLING = 7_100_003;
const EDITOR = 7_100_100;
const EDITOR_CHILD = 7_100_101;

function at(time: string): string {
  return `2026-10-12T${time}+02:00`;
}

describe("creationTimeMicros", () => {
  it("keeps the microseconds Date.parse drops", () => {
    const a = creationTimeMicros(at("10:00:00.1234560"));
    const b = creationTimeMicros(at("10:00:00.1239990"));
    expect(a).toBeDefined();
    expect(b! - a!).toBe(543);
  });

  it("compares across offsets", () => {
    expect(creationTimeMicros("2026-10-12T08:00:00.0000000Z")).toBe(
      creationTimeMicros(at("10:00:00.0000000"))
    );
  });

  it("is undefined for a missing or unparseable value", () => {
    expect(creationTimeMicros(undefined)).toBeUndefined();
    expect(creationTimeMicros("")).toBeUndefined();
    expect(creationTimeMicros("not a date")).toBeUndefined();
  });
});

describe("walkVerifiedTree", () => {
  it("includes legitimate grandchildren, each after its parent", () => {
    const rows: WindowsProcessRow[] = [
      { pid: GRANDCHILD, ppid: CHILD, startTime: at("10:00:02.0000000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.0000000") },
      { pid: SIBLING, ppid: ROOT, startTime: at("10:00:03.0000000") },
    ];

    const tree = walkVerifiedTree(rows, ROOT);

    expect(tree.pids[0]).toBe(ROOT);
    expect(new Set(tree.pids)).toEqual(new Set([ROOT, CHILD, GRANDCHILD, SIBLING]));
    expect(tree.pids.indexOf(CHILD)).toBeLessThan(tree.pids.indexOf(GRANDCHILD));
    expect(tree.stale).toEqual([]);
  });

  it("excludes an older process that names the root as parent, and everything under it", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.0000000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
      // An editor launched at 9:00 by a launcher that held ROOT's PID back then.
      { pid: EDITOR, ppid: ROOT, startTime: at("09:00:00.0000000") },
      // Started after ROOT, but its parent is the editor — not ours either.
      { pid: EDITOR_CHILD, ppid: EDITOR, startTime: at("10:30:00.0000000") },
    ];

    const tree = walkVerifiedTree(rows, ROOT);

    expect(tree.pids).toEqual([ROOT, CHILD]);
    expect(tree.stale).toEqual([EDITOR]);
  });

  it("excludes a stale link below a legitimate child", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.0000000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
      { pid: EDITOR, ppid: CHILD, startTime: at("10:00:00.5000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [ROOT, CHILD], stale: [EDITOR] });
  });

  it("counts a child created at the same instant as its parent", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.1234567") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:00.1234567") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [ROOT, CHILD], stale: [] });
  });

  it("rejects a child older than its parent by less than a millisecond", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.1238000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:00.1234000") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [ROOT], stale: [CHILD] });
  });

  // A missing CreationDate proves nothing, so the link is treated as stale:
  // never followed, always reported. Only Idle and System lack one in practice.
  it("does not follow a link when the child has no creation time", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.0000000") },
      { pid: CHILD, ppid: ROOT },
      { pid: GRANDCHILD, ppid: CHILD, startTime: at("10:00:02.0000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [ROOT], stale: [CHILD] });
  });

  it("follows no link from a root without a creation time", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1 },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [ROOT], stale: [CHILD] });
  });

  it("reports everything claiming an unlisted root as stale and walks nothing", () => {
    const rows: WindowsProcessRow[] = [
      { pid: EDITOR, ppid: ROOT, startTime: at("09:00:00.0000000") },
      { pid: EDITOR_CHILD, ppid: EDITOR, startTime: at("09:00:01.0000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT)).toEqual({ pids: [], stale: [EDITOR] });
  });

  it("never admits this process or its parent, and terminates on Idle's self-parenting row", () => {
    const rows: WindowsProcessRow[] = [
      { pid: 0, ppid: 0 },
      { pid: ROOT, ppid: 0, startTime: at("10:00:00.0000000") },
      { pid: process.pid, ppid: ROOT, startTime: at("10:00:01.0000000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT).pids).toEqual([ROOT, CHILD]);
    expect(walkVerifiedTree(rows, 0).pids).toEqual([0]);
  });

  it("keeps the first row when a PID is listed twice", () => {
    const rows: WindowsProcessRow[] = [
      { pid: ROOT, ppid: 1, startTime: at("10:00:00.0000000") },
      { pid: CHILD, ppid: ROOT, startTime: at("10:00:01.0000000") },
      { pid: CHILD, ppid: EDITOR, startTime: at("08:00:00.0000000") },
    ];

    expect(walkVerifiedTree(rows, ROOT).pids).toEqual([ROOT, CHILD]);
  });
});

describe("terminateWindowsProcesses", () => {
  let killSpy: MockInstance<typeof process.kill>;

  beforeEach(() => {
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  function errno(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(code), { code });
  }

  it("terminates each PID in order and treats an exited one as done", () => {
    killSpy.mockImplementation(((pid: number) => {
      if (pid === CHILD) throw errno("ESRCH");
      return true;
    }) as typeof process.kill);

    expect(terminateWindowsProcesses([ROOT, CHILD, GRANDCHILD])).toEqual([]);
    expect(killSpy.mock.calls).toEqual([
      [ROOT, "SIGKILL"],
      [CHILD, "SIGKILL"],
      [GRANDCHILD, "SIGKILL"],
    ]);
  });

  it("reports a PID it could not end", () => {
    killSpy.mockImplementation(((pid: number) => {
      if (pid === CHILD) throw errno("EPERM");
      return true;
    }) as typeof process.kill);

    expect(terminateWindowsProcesses([ROOT, CHILD])).toEqual([{ pid: CHILD, code: "EPERM" }]);
  });

  it("never signals a system PID, this process, its parent, or one already ended", () => {
    const ended = new Set([CHILD]);

    terminateWindowsProcesses([0, 4, process.pid, process.ppid, CHILD, ROOT], ended);

    expect(killSpy.mock.calls).toEqual([[ROOT, "SIGKILL"]]);
    expect(ended.has(ROOT)).toBe(true);
  });
});
