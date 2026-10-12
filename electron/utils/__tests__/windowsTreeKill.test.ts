import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const { spawnSyncMock, execFileMock, spawnMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(),
  execFileMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  spawnSync: spawnSyncMock,
  execFile: execFileMock,
  spawn: spawnMock,
}));

import {
  classifyTreeKillOutput,
  describeWindowsTreeKillProblem,
  disposeWindowsTreeKillService,
  encodeTreeKillInput,
  isWindowsTreeKillHelperRunning,
  keepWindowsTreeKillHelperWarm,
  killWindowsProcessTree,
  killWindowsProcessTreeInBackground,
  killWindowsProcessTrees,
  killWindowsProcessTreeSync,
  killWindowsProcessTreesSync,
  liveChildTreeTarget,
  normalizeTreeKillTarget,
  parseTreeKillOutput,
  parseTreeKillPlan,
  planTreeKillRecovery,
  TREE_KILL_SCRIPT,
  TREE_KILL_SERVER_SCRIPT,
  treeKillInputEnv,
  type NormalizedTreeKillTarget,
} from "../windowsTreeKill.js";
import { creationTimeMicros, IDENTITY_TOLERANCE_MICROS } from "../windowsProcessTree.js";
import { createFakeTreeKillHelper, settleIo } from "./helpers/fakeTreeKillHelper.js";

// Far above any real PID on the test host, so nothing here can name a live process.
const ROOT = 7_200_000;
const CHILD = 7_200_001;
const GRANDCHILD = 7_200_002;
const OTHER_ROOT = 7_200_010;
const EDITOR = 7_200_100;

const ROOT_START = "2026-10-12T10:00:00.1234560+02:00";
const ROOT_MICROS = creationTimeMicros(ROOT_START)!;

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function target(pid: number, extra: Partial<NormalizedTreeKillTarget> = {}) {
  return { pid, tree: true, own: false, ...extra };
}

/** A complete report: `R`, `P` and `S` lines, then `END`. */
function report(...lines: string[]): string {
  return [...lines, "END", ""].join("\r\n");
}

const TREE_REPORT = report(
  `R 0 tree ${ROOT_MICROS}`,
  `P 0 ${ROOT} killed`,
  `P 0 ${CHILD} killed`,
  `P 0 ${GRANDCHILD} gone`,
  `S 0 ${EDITOR}`
);

/** The helper's input, joined back the way the script joins it. */
function decodeInput(options: { env?: Record<string, string> }) {
  const env = options.env ?? {};
  const parts = Number(env.DAINTREE_TREE_KILL_PARTS);
  const json = Array.from({ length: parts }, (_v, i) => env[`DAINTREE_TREE_KILL_INPUT_${i}`]).join(
    ""
  );
  return JSON.parse(json || "null") as {
    self: number;
    parent: number;
    waitMs: number;
    roots: Array<{ pid: number; start: string | null; tree: boolean; own: boolean }>;
  };
}

describe("the helper script", () => {
  it("is the text run, verbatim, through -EncodedCommand", () => {
    setPlatform("win32");
    spawnSyncMock.mockReturnValue({ stdout: report(`R 0 gone -`), status: 0 });
    killWindowsProcessTreeSync(ROOT);
    const args = spawnSyncMock.mock.calls[0][1] as string[];
    Object.defineProperty(process, "platform", originalPlatform);

    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(TREE_KILL_SCRIPT);
  });

  it("ends processes only through handles and never calls taskkill", () => {
    expect(TREE_KILL_SCRIPT).not.toMatch(/taskkill|Stop-Process/i);
    expect(TREE_KILL_SCRIPT).toContain("GetProcessById");
    expect(TREE_KILL_SCRIPT).toContain(".Kill()");
    expect(TREE_KILL_SCRIPT).toContain(".WaitForExit(");
  });

  it("waits for every descendant to exit before it ends a root", () => {
    // Roots nested inside another requested tree count as descendants there.
    const descendants = TREE_KILL_SCRIPT.indexOf("-or -not (IsTop $plan)) { KillOne");
    const firstWait = TREE_KILL_SCRIPT.indexOf("\nWaitAll\n");
    const roots = TREE_KILL_SCRIPT.indexOf("if (IsTop $plan) { KillOne $plan[5] }");
    expect(descendants).toBeGreaterThan(0);
    expect(firstWait).toBeGreaterThan(descendants);
    expect(roots).toBeGreaterThan(firstWait);
  });

  it("allows the same identity slack as sameProcessIdentity", () => {
    const slack = /-le (\d+)\)/.exec(TREE_KILL_SCRIPT)?.[1];
    expect(Number(slack)).toBe(IDENTITY_TOLERANCE_MICROS);
  });

  it("never names a variable after PowerShell's read-only $PID", () => {
    // PowerShell variables are case-insensitive: `$pid` IS `$PID`.
    for (const script of [TREE_KILL_SCRIPT, TREE_KILL_SERVER_SCRIPT]) {
      expect(script.replace(/\[long\]\$PID/g, "")).not.toMatch(/\$pid\b/i);
    }
  });

  it("announces every root's plan before it terminates anything", () => {
    for (const script of [TREE_KILL_SCRIPT, TREE_KILL_SERVER_SCRIPT]) {
      const plan = script.indexOf("Emit ('R ' + $plan[0]");
      const announced = script.indexOf("Emit 'K'\nPublish\n");
      const firstKill = script.indexOf("KillOne $mine[$k]");
      expect(plan).toBeGreaterThan(0);
      expect(announced).toBeGreaterThan(plan);
      expect(firstKill).toBeGreaterThan(announced);
    }
  });
});

describe("the persistent helper script", () => {
  it("runs the same kill as the one-shot, one stdin line at a time", () => {
    const body = TREE_KILL_SCRIPT.slice(TREE_KILL_SCRIPT.indexOf("$self = [long]$req.self"));
    const killRun = body.slice(0, body.indexOf("Emit 'END'"));
    expect(TREE_KILL_SERVER_SCRIPT).toContain(killRun);
    expect(TREE_KILL_SERVER_SCRIPT).toContain("[Console]::In.ReadLine()");
    expect(TREE_KILL_SERVER_SCRIPT).toContain("if ($null -eq $reqLine) { break }");
    // The request is parsed as data; nothing from it is evaluated.
    expect(TREE_KILL_SERVER_SCRIPT).toContain("ConvertFrom-Json $reqLine.Substring($sp + 1)");
    expect(TREE_KILL_SERVER_SCRIPT).not.toMatch(/Invoke-Expression|iex |\[ScriptBlock\]/i);
    expect(TREE_KILL_SERVER_SCRIPT).not.toMatch(/taskkill|Stop-Process/i);
  });

  it("disposes every handle a run opened, however the run ends", () => {
    const finallyAt = TREE_KILL_SERVER_SCRIPT.indexOf("} finally {");
    expect(finallyAt).toBeGreaterThan(TREE_KILL_SERVER_SCRIPT.indexOf("Emit 'END'"));
    expect(TREE_KILL_SERVER_SCRIPT.slice(finallyAt)).toMatch(
      /foreach \(\$h in @\(\$handles\.Values\)\) \{ try \{ \$h\.Dispose\(\) \}/
    );
  });

  it("ends each report with a sentinel line carrying the request's id", () => {
    expect(TREE_KILL_SERVER_SCRIPT).toContain(
      "Send ($out.ToString() + '__DAINTREE_TREE_KILL_END__:' + $rid + [Environment]::NewLine)"
    );
    expect(TREE_KILL_SERVER_SCRIPT).toContain("if ($rid -notmatch '^[0-9]+$') { continue }");
  });

  it("finishes a run whose host has gone instead of failing on the broken pipe", () => {
    // Every write goes through Send, which swallows the failure.
    expect(TREE_KILL_SERVER_SCRIPT).toContain(
      "function Send([string]$text) { try { [Console]::Out.Write($text); [Console]::Out.Flush() } catch { } }"
    );
    const writes = TREE_KILL_SERVER_SCRIPT.match(/\[Console\]::Out\.Write/g) ?? [];
    expect(writes).toHaveLength(1);
  });

  it("fits a Windows command line as -EncodedCommand", () => {
    const encoded = Buffer.from(TREE_KILL_SERVER_SCRIPT, "utf16le").toString("base64");
    expect(encoded.length).toBeLessThan(30_000);
  });
});

describe("encodeTreeKillInput", () => {
  it("carries every root, its identity as a decimal string, and the exclusions", () => {
    const input = JSON.parse(
      encodeTreeKillInput(
        [
          normalizeTreeKillTarget({ pid: ROOT, startTime: ROOT_START }),
          normalizeTreeKillTarget({ pid: CHILD, tree: false, ownChild: true }),
          normalizeTreeKillTarget(OTHER_ROOT),
        ],
        1234.7
      )
    );

    expect(input).toEqual({
      self: process.pid,
      parent: process.ppid,
      waitMs: 1234,
      roots: [
        { pid: ROOT, start: String(ROOT_MICROS), tree: true, own: false },
        { pid: CHILD, start: null, tree: false, own: true },
        { pid: OTHER_ROOT, start: null, tree: true, own: false },
      ],
    });
  });

  it("passes a previous kill's microseconds through unchanged", () => {
    expect(normalizeTreeKillTarget({ pid: ROOT, startTime: ROOT_MICROS }).start).toBe(ROOT_MICROS);
  });
});

describe("treeKillInputEnv", () => {
  it("cuts the input into variables Windows accepts and counts them", () => {
    const json = "x".repeat(65_000);
    const env = treeKillInputEnv(json);
    const parts = Number(env.DAINTREE_TREE_KILL_PARTS);

    expect(parts).toBe(3);
    const joined = Array.from({ length: parts }, (_v, i) => env[`DAINTREE_TREE_KILL_INPUT_${i}`]);
    expect(joined.join("")).toBe(json);
    expect(joined.every((part) => part.length < 32_767)).toBe(true);
  });

  it("always sends at least one part", () => {
    expect(treeKillInputEnv("")).toEqual({
      DAINTREE_TREE_KILL_INPUT_0: "",
      DAINTREE_TREE_KILL_PARTS: "1",
    });
  });

  it("is what the script reads back", () => {
    expect(TREE_KILL_SCRIPT).toContain("$env:DAINTREE_TREE_KILL_PARTS");
    expect(TREE_KILL_SCRIPT).toContain("'DAINTREE_TREE_KILL_INPUT_' + $_");
  });
});

describe("liveChildTreeTarget", () => {
  it("lets a running child fall back to its handle-pinned PID", () => {
    expect(liveChildTreeTarget({ pid: ROOT, exitCode: null, signalCode: null })).toEqual({
      pid: ROOT,
      ownChild: true,
    });
  });

  it.each([
    ["exited", { pid: ROOT, exitCode: 0, signalCode: null }],
    ["signalled", { pid: ROOT, exitCode: null, signalCode: "SIGTERM" as const }],
    ["never started", { pid: undefined, exitCode: null, signalCode: null }],
  ])("refuses a child that %s: its PID is free for reuse", (_label, child) => {
    expect(liveChildTreeTarget(child)).toBeNull();
  });
});

describe("parseTreeKillOutput", () => {
  it("reads roots, outcomes, stale links and a census error through a BOM and CRLF", () => {
    const parsed = parseTreeKillOutput(
      "\uFEFF" +
        report(
          "E Access denied by policy",
          `R 0 root-only -`,
          `P 0 ${ROOT} failed win32-5`,
          `R 1 gone -`,
          `S 1 ${EDITOR}`
        )
    );

    expect(parsed?.censusError).toBe("Access denied by policy");
    expect(parsed?.roots.get(0)).toEqual({
      mode: "root-only",
      pids: [{ pid: ROOT, outcome: "failed win32-5" }],
      stale: [],
    });
    expect(parsed?.roots.get(1)).toEqual({ mode: "gone", pids: [], stale: [EDITOR] });
  });

  it("rejects a report without END as cut short", () => {
    expect(parseTreeKillOutput(`R 0 tree ${ROOT_MICROS}\r\nP 0 ${ROOT} killed`)).toBeNull();
    expect(parseTreeKillOutput("")).toBeNull();
  });
});

describe("parseTreeKillPlan", () => {
  it("reads the announced roots once K has been written", () => {
    const plan = parseTreeKillPlan(
      `E slow\r\nR 0 tree ${ROOT_MICROS}\r\nR 1 gone -\r\nK\r\nP 0 ${ROOT} killed\r\n`
    );
    expect([...plan!.entries()]).toEqual([
      [0, { mode: "tree", rootStart: ROOT_MICROS }],
      [1, { mode: "gone" }],
    ]);
  });

  it("is null for a run cut short before its kills began", () => {
    expect(parseTreeKillPlan(`R 0 tree ${ROOT_MICROS}\r\n`)).toBeNull();
    expect(parseTreeKillPlan("")).toBeNull();
  });
});

describe("planTreeKillRecovery", () => {
  const announced = (...lines: string[]) => [...lines, "K", ""].join("\r\n");

  it("repeats every root as asked when the run ended before any kill", () => {
    const targets = [target(ROOT), target(OTHER_ROOT, { own: true })];
    const { rerun, settled } = planTreeKillRecovery(targets, `R 0 tree 1`, true, "died");

    expect(rerun).toEqual([
      { index: 0, target: targets[0] },
      { index: 1, target: targets[1] },
    ]);
    expect(settled.size).toBe(0);
  });

  it("pins a root the census identified to that identity once kills may have begun", () => {
    const { rerun } = planTreeKillRecovery(
      [target(ROOT)],
      announced(`R 0 tree ${ROOT_MICROS}`),
      true,
      "died"
    );

    expect(rerun).toEqual([{ index: 0, target: target(ROOT, { start: ROOT_MICROS }) }]);
  });

  it("settles roots the census saw gone, reused or refused, without another run", () => {
    const { rerun, settled } = planTreeKillRecovery(
      [target(ROOT), target(CHILD), target(OTHER_ROOT)],
      announced(`R 0 gone -`, `R 1 mismatch 99`, `R 2 refused -`),
      true,
      "died"
    );

    expect(rerun).toEqual([]);
    expect(settled.get(0)).toMatchObject({ mode: "gone", rootEnded: true });
    expect(settled.get(1)).toMatchObject({
      mode: "identity-mismatch",
      rootEnded: true,
      rootStartTime: 99,
    });
    expect(settled.get(2)).toMatchObject({ mode: "skipped" });
  });

  it("drops a retried root's ownership once kills may have begun", () => {
    const { rerun } = planTreeKillRecovery(
      [target(ROOT, { own: true }), target(OTHER_ROOT, { own: true, start: ROOT_MICROS })],
      announced(`R 0 tree ${ROOT_MICROS}`, `R 1 root-only -`),
      true,
      "died"
    );

    // A failed census in the retry must not end either by bare PID.
    expect(rerun.map((entry) => entry.target.own)).toEqual([false, false]);
  });

  it("never repeats a root without an identity once it may have been ended", () => {
    // The census failed, so an owned root was ended by its PID: once it exited
    // its owner's handle no longer pins that PID.
    const { rerun, settled } = planTreeKillRecovery(
      [target(ROOT, { own: true }), target(OTHER_ROOT, { start: ROOT_MICROS })],
      announced(`R 0 root-only -`, `R 1 root-only -`),
      true,
      "died"
    );

    expect(rerun).toEqual([{ index: 1, target: target(OTHER_ROOT, { start: ROOT_MICROS }) }]);
    expect(settled.get(0)).toMatchObject({ mode: "root-only", unconfirmed: [ROOT] });
    expect(describeWindowsTreeKillProblem(settled.get(0)!)).toContain("died");
  });

  it("repeats a root the census left untouched", () => {
    const { rerun } = planTreeKillRecovery(
      [target(ROOT)],
      announced(`R 0 untouched -`),
      true,
      "died"
    );
    expect(rerun).toEqual([{ index: 0, target: target(ROOT) }]);
  });

  it("repeats only roots with their own identity when the report may be missing its K", () => {
    const { rerun, settled } = planTreeKillRecovery(
      [target(ROOT), target(CHILD, { own: true }), target(OTHER_ROOT, { start: ROOT_MICROS })],
      `R 0 tree ${ROOT_MICROS}`,
      false,
      "timed out"
    );

    expect(rerun).toEqual([{ index: 2, target: target(OTHER_ROOT, { start: ROOT_MICROS }) }]);
    expect(settled.get(0)).toMatchObject({ mode: "untouched", rootEnded: false });
    expect(settled.get(1)).toMatchObject({ mode: "untouched" });
  });
});

describe("classifyTreeKillOutput", () => {
  function classify(targets: NormalizedTreeKillTarget[], stdout: string) {
    return classifyTreeKillOutput(targets, parseTreeKillOutput(stdout)!);
  }

  it("splits killed, already gone, still running and failed, and keeps the census identity", () => {
    const [result] = classify(
      [target(ROOT)],
      report(
        `R 0 tree ${ROOT_MICROS}`,
        `P 0 ${ROOT} timeout`,
        `P 0 ${CHILD} killed`,
        `P 0 ${GRANDCHILD} failed win32-5`,
        `P 0 ${OTHER_ROOT} gone`,
        `P 0 ${EDITOR} mismatch`
      )
    );

    expect(result).toMatchObject({
      mode: "tree",
      targeted: [ROOT, CHILD, GRANDCHILD, OTHER_ROOT, EDITOR],
      killed: [CHILD],
      timedOut: [ROOT],
      failed: [{ pid: GRANDCHILD, code: "win32-5" }],
      alreadyGone: [OTHER_ROOT],
      identityMismatch: [EDITOR],
      rootStartTime: ROOT_MICROS,
      rootEnded: false,
    });
    expect(describeWindowsTreeKillProblem(result)).toContain(
      `still running after termination: ${ROOT}`
    );
  });

  it.each([
    ["gone", "gone", true],
    ["mismatch", "identity-mismatch", true],
    ["untouched", "untouched", false],
    ["refused", "skipped", false],
  ] as const)("reads root mode %s as %s", (raw, mode, rootEnded) => {
    const [result] = classify([target(ROOT)], report(`R 0 ${raw} -`));
    expect(result.mode).toBe(mode);
    expect(result.rootEnded).toBe(rootEnded);
    expect(result.targeted).toEqual([]);
  });

  it("reports a member the census could not identify as not ended, never opened by bare PID", () => {
    expect(TREE_KILL_SCRIPT).toContain(
      "elseif ($null -eq $rows[$m][1]) { $outcome[$m] = 'failed no-identity' }"
    );
    const [result] = classify(
      [target(ROOT)],
      report(`R 0 tree -`, `P 0 ${ROOT} failed no-identity`)
    );
    expect(result.failed).toEqual([{ pid: ROOT, code: "no-identity" }]);
    expect(result.rootEnded).toBe(false);
  });

  it("tells a root inside an earlier root's tree how it ended", () => {
    const results = classify(
      [target(ROOT), target(CHILD)],
      report(`R 0 tree ${ROOT_MICROS}`, `P 0 ${ROOT} killed`, `P 0 ${CHILD} killed`, `R 1 tree 1`)
    );

    expect(results[1].targeted).toEqual([]);
    expect(results[1].rootEnded).toBe(true);
  });
});

describe("Windows tree kill", () => {
  let killSpy: MockInstance<typeof process.kill>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setPlatform("win32");
    spawnSyncMock.mockReset();
    execFileMock.mockReset();
    spawnMock.mockReset();
    killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    disposeWindowsTreeKillService();
    Object.defineProperty(process, "platform", originalPlatform);
    killSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function helperReturns(stdout: string, status: number | null = 0): void {
    spawnSyncMock.mockReturnValue({ stdout, stderr: "", status, error: undefined });
  }

  describe("killWindowsProcessTreeSync", () => {
    it("lets the helper do every termination, so nothing is killed by bare PID", () => {
      helperReturns(TREE_REPORT);

      const result = killWindowsProcessTreeSync(ROOT, { timeoutMs: 3000 });

      expect(killSpy).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        mode: "tree",
        killed: [ROOT, CHILD],
        alreadyGone: [GRANDCHILD],
        stale: [EDITOR],
        rootEnded: true,
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(String(EDITOR)));
    });

    it("runs one bounded, hidden PowerShell whose script never contains a PID", () => {
      helperReturns(TREE_REPORT);

      killWindowsProcessTreeSync({ pid: ROOT, startTime: ROOT_START }, { timeoutMs: 3000 });
      killWindowsProcessTreeSync(OTHER_ROOT, { timeoutMs: 3000 });

      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
      const [first, second] = spawnSyncMock.mock.calls;
      expect(first[0]).toBe("powershell.exe");
      // Same script for different targets: the PIDs travel only as input.
      expect(second[1]).toEqual(first[1]);
      expect(String(first[1])).not.toContain(String(ROOT));
      expect(first[2]).toEqual(
        expect.objectContaining({ windowsHide: true, timeout: 3000, maxBuffer: expect.any(Number) })
      );
      expect(decodeInput(first[2]).roots).toEqual([
        { pid: ROOT, start: String(ROOT_MICROS), tree: true, own: false },
      ]);
    });

    it("keeps the exit wait inside the overall budget", () => {
      helperReturns(TREE_REPORT);

      killWindowsProcessTreeSync(ROOT, { timeoutMs: 2000, waitMs: 5000 });
      killWindowsProcessTreeSync(ROOT, { timeoutMs: 800 });

      expect(decodeInput(spawnSyncMock.mock.calls[0][2]).waitMs).toBeLessThan(2000);
      expect(decodeInput(spawnSyncMock.mock.calls[1][2]).waitMs).toBe(0);
    });

    it.each([
      ["a non-zero exit with no report", { stdout: "", stderr: "boom", status: 1 }],
      ["a timeout", { stdout: "", status: null, error: new Error("spawnSync ETIMEDOUT") }],
      [
        "a report cut short",
        { stdout: `R 0 tree ${ROOT_MICROS}\r\nP 0 ${ROOT} killed`, status: 0 },
      ],
    ])("after %s, ends only a root the caller owns, by PID", (_label, spawned) => {
      spawnSyncMock.mockReturnValue(spawned);

      const owned = killWindowsProcessTreeSync({ pid: ROOT, ownChild: true });
      const foreign = killWindowsProcessTreeSync(OTHER_ROOT);

      expect(killSpy.mock.calls).toEqual([[ROOT, "SIGKILL"]]);
      // Nothing here can watch the exit, so it is not claimed.
      expect(owned).toMatchObject({
        mode: "root-only",
        killed: [],
        unconfirmed: [ROOT],
        rootEnded: false,
      });
      expect(describeWindowsTreeKillProblem(owned)).toContain("exit not observed");
      expect(foreign).toMatchObject({ mode: "untouched", targeted: [], rootEnded: false });
      expect(describeWindowsTreeKillProblem(foreign)).toContain("ended nothing");
    });

    it("leaves a root with only an expected identity to the helper, which failed", () => {
      spawnSyncMock.mockImplementation(() => {
        throw new Error("EMFILE");
      });

      const result = killWindowsProcessTreeSync({ pid: ROOT, startTime: ROOT_START });

      expect(result.mode).toBe("untouched");
      expect(killSpy).not.toHaveBeenCalled();
    });

    it.each([0, -1, 4, 1.5, Number.NaN])("refuses PID %s without starting PowerShell", (pid) => {
      expect(killWindowsProcessTreeSync(pid).mode).toBe("skipped");
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("refuses this process and its parent", () => {
      expect(killWindowsProcessTreeSync(process.pid).mode).toBe("skipped");
      expect(killWindowsProcessTreeSync({ pid: process.ppid, ownChild: true }).mode).toBe(
        "skipped"
      );
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
    it("ends several trees in one run and answers in input order", () => {
      helperReturns(
        report(
          `R 0 tree ${ROOT_MICROS}`,
          `P 0 ${ROOT} killed`,
          `P 0 ${CHILD} killed`,
          `R 1 gone -`,
          `R 2 tree 1`
        )
      );

      const results = killWindowsProcessTreesSync([ROOT, 4, OTHER_ROOT, CHILD]);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(decodeInput(spawnSyncMock.mock.calls[0][2]).roots.map((r) => r.pid)).toEqual([
        ROOT,
        OTHER_ROOT,
        CHILD,
      ]);
      expect(results.map((r) => r.mode)).toEqual(["tree", "skipped", "gone", "tree"]);
      expect(results[3].rootEnded).toBe(true);
    });

    it("keeps a large batch in one run, its input split across variables", () => {
      spawnSyncMock.mockImplementation((_file, _args, options) => ({
        stdout: report(...decodeInput(options).roots.map((_r, i) => `R ${i} gone -`)),
        status: 0,
      }));

      const pids = Array.from({ length: 1500 }, (_v, i) => 8_000_000 + i);
      const results = killWindowsProcessTreesSync(pids);

      // One census covers every root: a second run could census a PID the
      // first had already ended and freed.
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const env = spawnSyncMock.mock.calls[0][2].env as Record<string, string>;
      expect(Number(env.DAINTREE_TREE_KILL_PARTS)).toBeGreaterThan(1);
      for (const [key, value] of Object.entries(env)) {
        if (key.startsWith("DAINTREE_TREE_KILL_INPUT_")) expect(value.length).toBeLessThan(32_767);
      }
      expect(decodeInput(spawnSyncMock.mock.calls[0][2]).roots).toHaveLength(1500);
      expect(results.every((r) => r.mode === "gone")).toBe(true);
    });
  });

  describe("killWindowsProcessTree", () => {
    function execFileYields(error: Error | null, stdout: string) {
      const stdinEnd = vi.fn();
      execFileMock.mockImplementation(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, stdout: string, stderr: string) => void
        ) => {
          queueMicrotask(() => callback(error, stdout, ""));
          return { stdin: { end: stdinEnd } };
        }
      );
      return stdinEnd;
    }

    function helperRuns() {
      const helper = createFakeTreeKillHelper();
      spawnMock.mockReturnValue(helper.child);
      return helper;
    }

    function helperWillNotStart() {
      spawnMock.mockImplementation(() => {
        throw new Error("spawn powershell.exe ENOENT");
      });
    }

    it("runs on the persistent helper, the request as one line of data", async () => {
      const helper = helperRuns();

      const pending = killWindowsProcessTree({ pid: ROOT, startTime: ROOT_START });
      await settleIo();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [file, args, options] = spawnMock.mock.calls[0];
      expect(file).toBe("powershell.exe");
      const encoded = (args as string[])[(args as string[]).indexOf("-EncodedCommand") + 1];
      expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(TREE_KILL_SERVER_SCRIPT);
      expect(String(args)).not.toContain(String(ROOT));
      expect(options).toEqual(expect.objectContaining({ windowsHide: true, shell: false }));

      expect(helper.requests).toHaveLength(1);
      const [id, json] = [
        helper.requests[0].slice(0, helper.requests[0].indexOf(" ")),
        helper.requests[0].slice(helper.requests[0].indexOf(" ") + 1),
      ];
      expect(id).toMatch(/^\d+$/);
      expect(JSON.parse(json)).toMatchObject({
        self: process.pid,
        roots: [{ pid: ROOT, start: String(ROOT_MICROS), tree: true, own: false }],
      });

      helper.answer([`R 0 tree ${ROOT_MICROS}`, "K", `P 0 ${ROOT} killed`, `P 0 ${CHILD} killed`]);
      const result = await pending;

      expect(result).toMatchObject({ mode: "tree", killed: [ROOT, CHILD], rootEnded: true });
      expect(execFileMock).not.toHaveBeenCalled();
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });

    it("shares one census between kills requested together", async () => {
      const helper = helperRuns();

      const first = killWindowsProcessTrees([ROOT, 4]);
      const second = killWindowsProcessTree(OTHER_ROOT);
      await settleIo();

      expect(helper.requests).toHaveLength(1);
      expect(helper.rootsOf(0)).toEqual([ROOT, OTHER_ROOT]);
      helper.answer(["R 0 gone -", "R 1 tree 5", "K", `P 1 ${OTHER_ROOT} killed`]);

      expect((await first).map((r) => r.mode)).toEqual(["gone", "skipped"]);
      expect((await second).killed).toEqual([OTHER_ROOT]);
    });

    it("finishes a run cut short after K through the one-shot, pinned to the census identity", async () => {
      const helper = helperRuns();
      execFileYields(null, report(`R 0 gone -`));

      const pending = killWindowsProcessTree(ROOT);
      await settleIo();
      helper.write(`R 0 tree ${ROOT_MICROS}\r\nK\r\n`);
      helper.die();

      // The helper may already have ended the root: the retry must not walk
      // whatever holds its PID now unless it is the process the census saw.
      expect((await pending).mode).toBe("gone");
      expect(decodeInput(execFileMock.mock.calls[0][2]).roots).toEqual([
        { pid: ROOT, start: String(ROOT_MICROS), tree: true, own: false },
      ]);
    });

    describe("when the persistent helper cannot start", () => {
      beforeEach(helperWillNotStart);

      it("resolves with the one-shot helper's report", async () => {
        const stdinEnd = execFileYields(null, TREE_REPORT);

        const result = await killWindowsProcessTree(ROOT, { timeoutMs: 3000 });

        expect(execFileMock).toHaveBeenCalledWith(
          "powershell.exe",
          expect.any(Array),
          expect.objectContaining({ windowsHide: true, timeout: 3000 }),
          expect.any(Function)
        );
        expect(stdinEnd).toHaveBeenCalled();
        expect(spawnSyncMock).not.toHaveBeenCalled();
        expect(result.killed).toEqual([ROOT, CHILD]);
        expect(killSpy).not.toHaveBeenCalled();
      });

      it("uses a complete report even when PowerShell exits non-zero", async () => {
        execFileYields(new Error("Command failed"), TREE_REPORT);

        expect((await killWindowsProcessTree(ROOT)).mode).toBe("tree");
      });

      it("falls back to the owned root alone when the one-shot fails too", async () => {
        execFileYields(new Error("Command failed"), "");

        const result = await killWindowsProcessTree({ pid: ROOT, ownChild: true });

        expect(result.mode).toBe("root-only");
        expect(killSpy.mock.calls).toEqual([[ROOT, "SIGKILL"]]);
        expect(describeWindowsTreeKillProblem(result)).toContain("census failed");
      });
    });
  });

  describe("keepWindowsTreeKillHelperWarm", () => {
    it("starts the helper ahead of the first kill", () => {
      const helper = createFakeTreeKillHelper();
      spawnMock.mockReturnValue(helper.child);

      keepWindowsTreeKillHelperWarm(true);

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(isWindowsTreeKillHelperRunning()).toBe(true);
    });

    it("does nothing off Windows", () => {
      setPlatform("linux");

      keepWindowsTreeKillHelperWarm(true);

      expect(spawnMock).not.toHaveBeenCalled();
      expect(isWindowsTreeKillHelperRunning()).toBe(false);
    });
  });

  describe("killWindowsProcessTreeInBackground", () => {
    it("logs a problem under the caller's tag and never rejects", async () => {
      spawnMock.mockImplementation(() => {
        throw new Error("spawn EPERM");
      });
      execFileMock.mockImplementation(() => {
        throw new Error("spawn EPERM");
      });

      const result = await killWindowsProcessTreeInBackground(ROOT, "[Caller]");

      expect(result?.mode).toBe("untouched");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`[Caller] tree kill pid=${ROOT}`)
      );
    });
  });
});
