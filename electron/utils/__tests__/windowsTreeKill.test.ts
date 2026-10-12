import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { spawnSyncMock, execFileMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
  execFile: execFileMock,
}));

import {
  describeWindowsTreeKillProblem,
  killWindowsProcessTree,
  killWindowsProcessTreeSync,
  killWindowsProcessTreesSync,
  parseWindowsProcessRows,
} from "../windowsTreeKill.js";

// Far above any real PID on the test host, so nothing here can name a live process.
const ROOT = 7_200_000;
const CHILD = 7_200_001;
const GRANDCHILD = 7_200_002;
const OTHER_ROOT = 7_200_010;
const EDITOR = 7_200_100;
const EDITOR_CHILD = 7_200_101;

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function at(time: string): string {
  return `2026-10-12T${time}.0000000+02:00`;
}

/** Census output: one `pid ppid created` line per row, this process included. */
function census(rows: Array<[number, number, string]>): string {
  return [[process.pid, 1, at("08:00:00")] as [number, number, string], ...rows]
    .map(([pid, ppid, created]) => `${pid} ${ppid} ${created}`)
    .join("\r\n");
}

const TREE_WITH_STALE_EDITOR = census([
  [ROOT, 1, at("10:00:00")],
  [CHILD, ROOT, at("10:00:01")],
  [GRANDCHILD, CHILD, at("10:00:02")],
  [EDITOR, ROOT, at("09:00:00")],
  [EDITOR_CHILD, EDITOR, at("09:00:01")],
]);

describe("parseWindowsProcessRows", () => {
  it("reads rows, a missing creation time, CRLF and a BOM", () => {
    const rows = parseWindowsProcessRows(
      `\uFEFF${process.pid} 1 ${at("08:00:00")}\r\n${ROOT} 0 -\r\n\r\ngarbage line\r\n`
    );

    expect(rows).toEqual([
      { pid: process.pid, ppid: 1, startTime: at("08:00:00") },
      { pid: ROOT, ppid: 0 },
    ]);
  });

  it("rejects a table without this process's own row as cut short", () => {
    expect(parseWindowsProcessRows(`${ROOT} 1 ${at("10:00:00")}`)).toBeNull();
    expect(parseWindowsProcessRows("")).toBeNull();
  });
});

describe("Windows tree kill", () => {
  let killSpy: MockInstance<typeof process.kill>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setPlatform("win32");
    spawnSyncMock.mockReset();
    execFileMock.mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", originalPlatform);
    killSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function censusReturns(stdout: string, status: number | null = 0): void {
    spawnSyncMock.mockReturnValue({ stdout, status, error: undefined });
  }

  function killedPids(): unknown[] {
    return killSpy.mock.calls.map(([pid]) => pid);
  }

  describe("killWindowsProcessTreeSync", () => {
    it("ends the verified tree root first and leaves the older program alone", () => {
      censusReturns(TREE_WITH_STALE_EDITOR);

      const result = killWindowsProcessTreeSync(ROOT, { timeoutMs: 3000 });

      expect(killedPids()).toEqual([ROOT, CHILD, GRANDCHILD]);
      expect(result).toEqual({
        mode: "tree",
        targeted: [ROOT, CHILD, GRANDCHILD],
        failed: [],
        stale: [EDITOR],
        rootEnded: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(String(EDITOR)));
    });

    it("runs one constant PowerShell census and never taskkill", () => {
      censusReturns(TREE_WITH_STALE_EDITOR);

      killWindowsProcessTreeSync(ROOT, { timeoutMs: 3000 });

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawnSyncMock.mock.calls[0];
      expect(file).toBe("powershell.exe");
      expect(args).toEqual(expect.arrayContaining(["-NoProfile", "-NonInteractive"]));
      // The PID being killed never enters the script.
      expect(String(args)).not.toContain(String(ROOT));
      expect(options).toEqual(expect.objectContaining({ windowsHide: true, timeout: 3000 }));
    });

    it("kills nothing when the census no longer lists the root", () => {
      censusReturns(census([[EDITOR, ROOT, at("09:00:00")]]));

      const result = killWindowsProcessTreeSync(ROOT);

      expect(killSpy).not.toHaveBeenCalled();
      expect(result.mode).toBe("gone");
      expect(result.rootEnded).toBe(true);
    });

    it.each([
      ["a non-zero exit", { stdout: TREE_WITH_STALE_EDITOR, status: 1 }],
      ["a timeout", { stdout: "", status: null, error: new Error("spawnSync ETIMEDOUT") }],
      ["a table cut short", { stdout: `${ROOT} 1 ${at("10:00:00")}`, status: 0 }],
    ])("ends the root alone, never via /T, after %s", (_label, spawned) => {
      spawnSyncMock.mockReturnValue(spawned);

      const result = killWindowsProcessTreeSync(ROOT);

      expect(killedPids()).toEqual([ROOT]);
      expect(result.mode).toBe("root-only");
      expect(result.censusError).toBeDefined();
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });

    it("ends the root alone when PowerShell cannot even start", () => {
      spawnSyncMock.mockImplementation(() => {
        throw new Error("EMFILE");
      });

      expect(killWindowsProcessTreeSync(ROOT).mode).toBe("root-only");
      expect(killedPids()).toEqual([ROOT]);
    });

    it("reports a process it could not end", () => {
      censusReturns(TREE_WITH_STALE_EDITOR);
      killSpy.mockImplementation(((pid: number) => {
        if (pid === ROOT) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return true;
      }) as typeof process.kill);

      const result = killWindowsProcessTreeSync(ROOT);

      expect(result.rootEnded).toBe(false);
      expect(result.failed).toEqual([{ pid: ROOT, code: "EPERM" }]);
      expect(describeWindowsTreeKillProblem(result)).toContain(`${ROOT} (EPERM)`);
    });

    it.each([0, -1, 4, 1.5, Number.NaN])("refuses PID %s without a census", (pid) => {
      expect(killWindowsProcessTreeSync(pid).mode).toBe("skipped");
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("refuses this process and its parent", () => {
      expect(killWindowsProcessTreeSync(process.pid).mode).toBe("skipped");
      expect(killWindowsProcessTreeSync(process.ppid).mode).toBe("skipped");
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it("does nothing off Windows", () => {
      setPlatform("linux");

      expect(killWindowsProcessTreeSync(ROOT).mode).toBe("skipped");
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });
  });

  describe("killWindowsProcessTreesSync", () => {
    it("kills several trees from one census without ending a shared process twice", () => {
      censusReturns(
        census([
          [ROOT, 1, at("10:00:00")],
          [CHILD, ROOT, at("10:00:01")],
          [OTHER_ROOT, 1, at("10:00:05")],
        ])
      );

      const results = killWindowsProcessTreesSync([ROOT, CHILD, OTHER_ROOT], { timeoutMs: 3000 });

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(killedPids()).toEqual([ROOT, CHILD, OTHER_ROOT]);
      expect(results.get(ROOT)?.mode).toBe("tree");
      expect(results.get(CHILD)?.rootEnded).toBe(true);
      expect(results.get(OTHER_ROOT)?.targeted).toEqual([OTHER_ROOT]);
    });
  });

  describe("killWindowsProcessTree", () => {
    function execFileYields(error: Error | null, stdout: string): void {
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string) => void
        ) => {
          queueMicrotask(() => callback(error, stdout));
          return {};
        }
      );
    }

    it("walks the census asynchronously and ends the verified tree", async () => {
      execFileYields(null, TREE_WITH_STALE_EDITOR);

      const result = await killWindowsProcessTree(ROOT, { timeoutMs: 3000 });

      expect(execFileMock).toHaveBeenCalledWith(
        "powershell.exe",
        expect.any(Array),
        expect.objectContaining({ windowsHide: true, timeout: 3000 }),
        expect.any(Function)
      );
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(killedPids()).toEqual([ROOT, CHILD, GRANDCHILD]);
      expect(result.stale).toEqual([EDITOR]);
    });

    it("ends the root alone when the census fails", async () => {
      execFileYields(new Error("Command failed"), "");

      const result = await killWindowsProcessTree(ROOT);

      expect(result.mode).toBe("root-only");
      expect(killedPids()).toEqual([ROOT]);
      expect(describeWindowsTreeKillProblem(result)).toContain("census failed");
    });
  });
});
