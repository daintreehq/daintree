import { describe, expect, it } from "vitest";
import {
  checkMaterialised,
  checkRendererContinuity,
  checkWindowEvents,
  checkWindowTiming,
  computeTreeUsage,
  cpuPercent,
  descendantsOf,
  frozenDuring,
  parseDaemonCpu,
  parseIdleHarnessConfig,
  parsePsCpuTime,
  parseSamplerOutput,
  resolveLabel,
  sliceSpawnCensus,
  type CellObservation,
  type IdleHarnessConfig,
  type ProcessSample,
  type SamplerSnapshot,
} from "../idleHarnessMeasurement.js";

const MS = 1_000_000;

function proc(pid: number, ppid: number, over: Partial<ProcessSample> = {}): ProcessSample {
  return {
    pid,
    ppid,
    startUs: pid * 1_000,
    selfNs: 0,
    childNs: 0,
    idleWakeups: 0,
    interruptWakeups: 0,
    childIdleWakeups: 0,
    childInterruptWakeups: 0,
    name: `proc-${pid}`,
    ...over,
  };
}

function snap(atUs: number, ...samples: ProcessSample[]): SamplerSnapshot {
  return { atUs, processes: new Map(samples.map((sample) => [sample.pid, sample])) };
}

/** The same labels at both ends of the window. */
function both(entries: Array<[number, string]> = []) {
  const map = new Map(entries);
  return { start: map, end: map };
}

function treeTotal(snapshot: SamplerSnapshot, rootPid: number): number {
  let total = 0;
  for (const pid of descendantsOf(snapshot, rootPid)) {
    const sample = snapshot.processes.get(pid)!;
    total += sample.selfNs + sample.childNs;
  }
  return total;
}

describe("parseSamplerOutput", () => {
  it("parses the header and one row per process, names with spaces intact", () => {
    const out = parseSamplerOutput(
      "v1\t1700000000000000\n" +
        "42\t1\t1699999999000000\t5000\t700\t11\t22\t3\t4\tDaintree Helper (Renderer)\n"
    );
    expect(out.atUs).toBe(1_700_000_000_000_000);
    expect(out.processes.get(42)).toEqual({
      pid: 42,
      ppid: 1,
      startUs: 1_699_999_999_000_000,
      selfNs: 5000,
      childNs: 700,
      idleWakeups: 11,
      interruptWakeups: 22,
      childIdleWakeups: 3,
      childInterruptWakeups: 4,
      name: "Daintree Helper (Renderer)",
    });
  });

  it("rejects output without the v1 header rather than reading zeros", () => {
    expect(() => parseSamplerOutput("42\t1\t0\t0\t0\t0\t0\t0\t0\tx\n")).toThrow(/v1 header/);
    expect(() => parseSamplerOutput("")).toThrow(/v1 header/);
  });

  it("skips truncated and non-numeric rows", () => {
    const out = parseSamplerOutput(
      "v1\t1\n7\t1\t0\t5\n8\t1\tNaN\t0\t0\t0\t0\t0\t0\tx\n9\t1\t0\t0\t0\t0\t0\t0\t0\tok\n"
    );
    expect([...out.processes.keys()]).toEqual([9]);
  });
});

describe("parsePsCpuTime", () => {
  it("reads unbounded minutes, hours and days", () => {
    expect(parsePsCpuTime("1238:55.38")).toBeCloseTo(74_335.38);
    expect(parsePsCpuTime("0:00.00")).toBe(0);
    expect(parsePsCpuTime("1:02:03.50")).toBeCloseTo(3_723.5);
    expect(parsePsCpuTime("2-01:00:00.00")).toBe(176_400);
  });

  it("returns null for anything else", () => {
    expect(parsePsCpuTime("")).toBeNull();
    expect(parsePsCpuTime("-")).toBeNull();
    expect(parsePsCpuTime("12")).toBeNull();
  });
});

describe("parseDaemonCpu", () => {
  it("picks named daemons by executable basename", () => {
    const out = parseDaemonCpu(
      "   94 522:13.98 /System/Library/Frameworks/CoreServices.framework/Support/fseventsd\n" +
        "39951 1238:55.38 /usr/libexec/sysmond\n" +
        "  500   0:01.00 /usr/libexec/sysmond-helper\n" +
        "  777   0:02.00 /Applications/My App.app/Contents/MacOS/My App\n",
      ["sysmond", "fseventsd"]
    );
    expect(out.sysmond).toEqual({ pid: 39951, cpuSeconds: expect.closeTo(74_335.38) });
    expect(out.fseventsd?.pid).toBe(94);
    expect(Object.keys(out).sort()).toEqual(["fseventsd", "sysmond"]);
  });

  it("omits a daemon that is not running", () => {
    expect(parseDaemonCpu("1 0:00.00 /sbin/launchd\n", ["sysmond"])).toEqual({});
  });
});

describe("descendantsOf / resolveLabel", () => {
  const tree = snap(0, proc(10, 1), proc(11, 10), proc(12, 11), proc(20, 1));

  it("walks the tree below the root only", () => {
    expect([...descendantsOf(tree, 10)].sort()).toEqual([10, 11, 12]);
    expect(descendantsOf(tree, 99).size).toBe(0);
  });

  it("inherits the nearest labelled ancestor", () => {
    const labels = new Map([
      [10, "main"],
      [11, "pty-host"],
    ]);
    expect(resolveLabel(tree, 11, labels)).toBe("pty-host");
    expect(resolveLabel(tree, 12, labels)).toBe("pty-host/child");
    expect(resolveLabel(tree, 20, labels)).toBe("other");
  });
});

describe("computeTreeUsage", () => {
  it("measures deltas of live processes", () => {
    const usage = computeTreeUsage({
      start: snap(
        0,
        proc(10, 1, { selfNs: 100 * MS, idleWakeups: 50 }),
        proc(11, 10, { selfNs: 5 * MS })
      ),
      end: snap(
        10_000_000,
        proc(10, 1, { selfNs: 300 * MS, idleWakeups: 150 }),
        proc(11, 10, { selfNs: 25 * MS })
      ),
      rootPid: 10,
      labels: both([[10, "main"]]),
    });
    expect(usage.elapsedMs).toBe(10_000);
    expect(usage.totalCpuNs).toBe(220 * MS);
    expect(usage.totalIdleWakeups).toBe(100);
    expect(usage.byLabel.main).toEqual({
      processes: 1,
      cpuNs: 200 * MS,
      idleWakeups: 100,
      interruptWakeups: 0,
    });
    expect(usage.byLabel["main/child"]?.cpuNs).toBe(20 * MS);
    expect(usage.departed).toEqual([]);
  });

  it("counts children born and reaped inside the window without ever seeing them", () => {
    // The pty-host (11) forked and reaped `ps` children worth 400ms mid-window.
    const usage = computeTreeUsage({
      start: snap(0, proc(10, 1), proc(11, 10, { selfNs: 10 * MS, childNs: 1_000 * MS })),
      end: snap(1_000_000, proc(10, 1), proc(11, 10, { selfNs: 30 * MS, childNs: 1_400 * MS })),
      rootPid: 10,
      labels: both([
        [10, "main"],
        [11, "pty-host"],
      ]),
    });
    const ptyHost = usage.processes.find((p) => p.pid === 11)!;
    expect(ptyHost.cpuNs).toBe(20 * MS);
    expect(ptyHost.reapedChildCpuNs).toBe(400 * MS);
    expect(usage.byLabel["pty-host"]?.cpuNs).toBe(420 * MS);
    expect(usage.totalCpuNs).toBe(420 * MS);
  });

  it("charges a departed process's pre-window share back to its reaper", () => {
    // Workspace host 12 had used 900ms before the window, used 100ms more, then
    // exited; main reaped it, so main's child counter grew by its 1000ms lifetime.
    const start = snap(
      0,
      proc(10, 1, { childNs: 50 * MS, childIdleWakeups: 5 }),
      proc(12, 10, { selfNs: 900 * MS, idleWakeups: 90 })
    );
    const end = snap(1_000_000, proc(10, 1, { childNs: 1_050 * MS, childIdleWakeups: 105 }));
    const usage = computeTreeUsage({
      start,
      end,
      rootPid: 10,
      labels: both([
        [10, "main"],
        [12, "workspace-host"],
      ]),
    });
    const main = usage.processes.find((p) => p.pid === 10)!;
    expect(main.reapedChildCpuNs).toBe(100 * MS);
    expect(main.reapedChildIdleWakeups).toBe(10);
    expect(usage.departed).toEqual([
      {
        pid: 12,
        name: "proc-12",
        label: "workspace-host",
        chargedToPid: 10,
        chargedThroughDeparted: false,
      },
    ]);
    expect(usage.totalCpuNs).toBe(treeTotal(end, 10) - treeTotal(start, 10));
    expect(usage.unattributedNs).toBe(0);
  });

  it("walks past departed ancestors to the first live one", () => {
    // 12 -> 13 both exit; 13's lifetime folded into 12, then 12's into main.
    const start = snap(
      0,
      proc(10, 1),
      proc(12, 10, { selfNs: 10 * MS }),
      proc(13, 12, { selfNs: 20 * MS })
    );
    const end = snap(1_000_000, proc(10, 1, { childNs: 45 * MS }));
    const usage = computeTreeUsage({ start, end, rootPid: 10, labels: both() });
    expect(usage.departed.map((d) => [d.chargedToPid, d.chargedThroughDeparted])).toEqual([
      [10, false],
      [10, true],
    ]);
    expect(usage.uncertainNs).toBe(20 * MS);
    expect(usage.totalCpuNs).toBe(15 * MS);
    expect(usage.totalCpuNs).toBe(treeTotal(end, 10) - treeTotal(start, 10));
  });

  it("treats a reused pid as a new process, not a continuation", () => {
    const start = snap(0, proc(10, 1), proc(11, 10, { startUs: 1, selfNs: 500 * MS }));
    const end = snap(
      1_000_000,
      proc(10, 1, { childNs: 600 * MS }),
      proc(11, 10, { startUs: 2, selfNs: 5 * MS })
    );
    const usage = computeTreeUsage({ start, end, rootPid: 10, labels: both() });
    const reborn = usage.processes.find((p) => p.pid === 11)!;
    expect(reborn.born).toBe(true);
    expect(reborn.cpuNs).toBe(5 * MS);
    expect(usage.departed.map((d) => d.pid)).toEqual([11]);
    expect(usage.totalCpuNs).toBe(105 * MS);
  });

  it("keeps accounting for a process reparented out of the tree", () => {
    const start = snap(0, proc(10, 1), proc(11, 10, { selfNs: 10 * MS }));
    const end = snap(1_000_000, proc(10, 1), proc(11, 1, { selfNs: 40 * MS }));
    const usage = computeTreeUsage({ start, end, rootPid: 10, labels: both() });
    expect(usage.processes.map((p) => p.pid).sort()).toEqual([10, 11]);
    expect(usage.totalCpuNs).toBe(30 * MS);
  });

  it("keeps accounting for what an escaped process spawned since", () => {
    const start = snap(0, proc(10, 1), proc(11, 10, { selfNs: 10 * MS }));
    const end = snap(
      1_000_000,
      proc(10, 1),
      proc(11, 1, { selfNs: 20 * MS }),
      proc(12, 11, { selfNs: 7 * MS })
    );
    const usage = computeTreeUsage({ start, end, rootPid: 10, labels: both() });
    expect(usage.processes.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    expect(usage.totalCpuNs).toBe(17 * MS);
  });

  it("labels each end by its own pid map, so a reused pid is not mislabelled", () => {
    const start = snap(0, proc(10, 1), proc(11, 10, { startUs: 1 }));
    const end = snap(1_000_000, proc(10, 1), proc(11, 10, { startUs: 2 }));
    const usage = computeTreeUsage({
      start,
      end,
      rootPid: 10,
      labels: { start: new Map([[11, "workspace-host"]]), end: new Map([[10, "main"]]) },
    });
    expect(usage.departed[0]?.label).toBe("workspace-host");
    expect(usage.processes.find((p) => p.pid === 11)?.label).toBe("main/child");
  });

  it("refuses an opening sample without the root rather than reading lifetimes", () => {
    expect(() =>
      computeTreeUsage({
        start: snap(0),
        end: snap(1, proc(10, 1, { selfNs: 9_000 * MS })),
        rootPid: 10,
        labels: both(),
      })
    ).toThrow(/missing from the opening sample/);
  });

  it("refuses a root that is a different process at each end", () => {
    expect(() =>
      computeTreeUsage({
        start: snap(0, proc(10, 1, { startUs: 1 })),
        end: snap(1, proc(10, 1, { startUs: 2 })),
        rootPid: 10,
        labels: both(),
      })
    ).toThrow(/different process/);
  });

  it("refuses samples with no elapsed time or a counter going backwards", () => {
    expect(() =>
      computeTreeUsage({
        start: snap(5, proc(10, 1)),
        end: snap(5, proc(10, 1)),
        rootPid: 10,
        labels: both(),
      })
    ).toThrow(/not later/);
    expect(() =>
      computeTreeUsage({
        start: snap(0, proc(10, 1, { idleWakeups: 9 })),
        end: snap(1, proc(10, 1, { idleWakeups: 3 })),
        rootPid: 10,
        labels: both(),
      })
    ).toThrow(/idleWakeups went backwards/);
  });

  it("refuses a closing sample without the root", () => {
    expect(() =>
      computeTreeUsage({
        start: snap(0, proc(10, 1)),
        end: snap(1, proc(11, 1)),
        rootPid: 10,
        labels: both(),
      })
    ).toThrow(/root pid 10/);
  });
});

describe("cpuPercent", () => {
  it("is percent of one core", () => {
    expect(cpuPercent(500 * MS, 1_000)).toBe(50);
    expect(cpuPercent(1, 0)).toBeNaN();
  });
});

describe("sliceSpawnCensus", () => {
  it("sums only whole buckets inside the window, keyed by role", () => {
    const slice = sliceSpawnCensus(
      [
        {
          role: "pty-host",
          pid: 5,
          flushedAtMs: 20_000,
          exited: false,
          buckets: { "9": { ps: 100 }, "10": { ps: 3 }, "11": { ps: 4, git: 1 }, "12": { ps: 50 } },
        },
        { role: "main", pid: 1, flushedAtMs: 20_000, exited: false, buckets: { "10": { git: 2 } } },
      ],
      10_000,
      12_000
    );
    expect(slice.byCommand).toEqual({ "pty-host:ps": 7, "pty-host:git": 1, "main:git": 2 });
    expect(slice.total).toBe(10);
    expect(slice.stale).toEqual([]);
    expect(slice.files).toBe(2);
  });

  it("flags a live process whose last flush predates the window's close", () => {
    const slice = sliceSpawnCensus(
      [
        { role: "workspace-host", pid: 7, flushedAtMs: 11_000, exited: false, buckets: {} },
        { role: "workspace-host", pid: 8, flushedAtMs: 11_000, exited: true, buckets: {} },
      ],
      10_000,
      12_000
    );
    expect(slice.stale).toEqual([{ role: "workspace-host", pid: 7, flushedAtMs: 11_000 }]);
  });
});

const VALID_CONFIG: IdleHarnessConfig = {
  cell: "p3-t19-stream-focused",
  terminalsPerProject: [7, 6, 6],
  stream: true,
  blurred: false,
  protectedProjectIndex: 1,
  windowMs: 300_000,
  settleMs: 30_000,
  samplerPath: "/tmp/sampler",
};

describe("parseIdleHarnessConfig", () => {
  const parse = (over: Partial<IdleHarnessConfig> | Record<string, unknown>) =>
    parseIdleHarnessConfig(JSON.stringify({ ...VALID_CONFIG, ...over }));

  it("accepts a valid cell", () => {
    expect(parse({})).toEqual({ config: VALID_CONFIG });
    expect(
      parse({ terminalsPerProject: [0], stream: false, protectedProjectIndex: null })
    ).toHaveProperty("config");
  });

  it("names every problem instead of guessing", () => {
    expect(parseIdleHarnessConfig(undefined)).toEqual({
      errors: [expect.stringMatching(/not set/)],
    });
    expect(parseIdleHarnessConfig("{")).toEqual({ errors: [expect.stringMatching(/not JSON/)] });
    expect(parse({ terminalsPerProject: [] })).toHaveProperty("errors");
    expect(parse({ terminalsPerProject: [1, 1, 1, 1, 1, 1] })).toHaveProperty("errors");
    expect(parse({ terminalsPerProject: [0, 6, 6] })).toEqual({
      errors: [expect.stringMatching(/stream needs/)],
    });
    expect(parse({ protectedProjectIndex: 0 })).toHaveProperty("errors");
    expect(parse({ protectedProjectIndex: 3 })).toHaveProperty("errors");
    expect(parse({ protectedProjectIndex: undefined })).toHaveProperty("errors");
    expect(parse({ terminalsPerProject: [7, 0, 6] })).toEqual({
      errors: [expect.stringMatching(/protected project needs/)],
    });
    expect(parse({ samplerPath: "" })).toHaveProperty("errors");
    expect(parse({ windowMs: -1 })).toHaveProperty("errors");
    expect(parse({ windowMs: 0 })).toHaveProperty("errors");
    expect(parse({ windowMs: 1_500 })).toHaveProperty("errors");
    expect(parseIdleHarnessConfig("null")).toEqual({ errors: [expect.stringMatching(/object/)] });
  });
});

function observation(over: Partial<CellObservation> = {}): CellObservation {
  return {
    views: [
      { state: "active", rendererPid: 101 },
      { state: "cached", rendererPid: 102 },
      { state: "cached", rendererPid: 103 },
    ],
    liveTerminals: [7, 6, 6],
    inventoryDegraded: false,
    windowCount: 1,
    windowVisible: true,
    windowMinimized: false,
    windowFocused: true,
    documentHasFocus: true,
    protectedAgentActive: true,
    streamWorkloadAlive: true,
    ...over,
  };
}

describe("checkMaterialised", () => {
  it("passes the cell that was asked for", () => {
    expect(checkMaterialised(VALID_CONFIG, observation(), "start")).toEqual([]);
  });

  it("fails every way the fixture can differ from the request", () => {
    const failures = checkMaterialised(
      VALID_CONFIG,
      observation({
        views: [
          { state: "active", rendererPid: 101 },
          { state: null, rendererPid: null },
          { state: "cached", rendererPid: 101 },
        ],
        liveTerminals: [7, 6, 5],
        inventoryDegraded: true,
        windowFocused: false,
        documentHasFocus: false,
        protectedAgentActive: false,
        streamWorkloadAlive: false,
      }),
      "end"
    );
    expect(failures).toEqual([
      "project 2 view is missing, expected cached at window end",
      "project 3 has 5 live terminals, expected 6 at window end",
      "project views share a renderer process at window end; per-view cost is not separable",
      "a pty-host shard did not answer the terminal inventory at window end",
      "window is blurred at window end, the cell asks otherwise",
      "active view document.hasFocus() is false at window end",
      "protected project has no active agent state at window end; the freeze would not skip it",
      "streaming workload is not running at window end",
    ]);
  });

  it("expects a blurred window when the cell is blurred", () => {
    const config = { ...VALID_CONFIG, blurred: true };
    expect(
      checkMaterialised(
        config,
        observation({ windowFocused: false, documentHasFocus: false }),
        "start"
      )
    ).toEqual([]);
    expect(checkMaterialised(config, observation({ windowFocused: true }), "start")).toContain(
      "window is focused at window start, the cell asks otherwise"
    );
  });

  it("treats missing focus evidence and a second window as failures", () => {
    expect(
      checkMaterialised(
        VALID_CONFIG,
        observation({ documentHasFocus: null, windowCount: 2 }),
        "end"
      )
    ).toEqual([
      "2 windows are open at window end; the fixture has one",
      "active view did not answer document.hasFocus() at window end",
    ]);
  });

  it("does not ask for an agent or a stream the cell does not have", () => {
    const config = { ...VALID_CONFIG, stream: false, protectedProjectIndex: null };
    expect(
      checkMaterialised(
        config,
        observation({ protectedAgentActive: null, streamWorkloadAlive: null }),
        "start"
      )
    ).toEqual([]);
  });
});

describe("checkRendererContinuity", () => {
  it("flags a renderer replaced between the samples", () => {
    const before = observation();
    const after = observation({
      views: [
        { state: "active", rendererPid: 101 },
        { state: "cached", rendererPid: 999 },
        { state: "cached", rendererPid: 103 },
      ],
    });
    expect(checkRendererContinuity(before, before)).toEqual([]);
    expect(checkRendererContinuity(before, after)).toEqual([
      "project 2's renderer was replaced inside the window (pid 102 -> 999)",
    ]);
  });
});

describe("checkWindowEvents", () => {
  const quiet = {
    windowStartMs: 40_000,
    windowEndMs: 100_000,
    terminalExits: 0,
    focusChanges: 0,
    processesGone: 0,
    protectedAgentStates: [],
  };

  it("passes a window where nothing happened", () => {
    expect(checkWindowEvents(quiet)).toEqual([]);
    expect(
      checkWindowEvents({
        ...quiet,
        streamLastOutputAt: 99_500,
        streamWorkloadCpuNs: 5 * MS,
        protectedLifecycle: [["freeze", 100_500]],
      })
    ).toEqual([]);
  });

  it("names each event that invalidates the reading", () => {
    expect(
      checkWindowEvents({
        ...quiet,
        terminalExits: 2,
        focusChanges: 1,
        processesGone: 1,
        protectedAgentStates: ["waiting", "completed"],
        streamLastOutputAt: 90_000,
        streamWorkloadCpuNs: 0,
        protectedLifecycle: [
          ["freeze", 50_000],
          ["resume", 51_000],
        ],
      })
    ).toEqual([
      "2 fixture terminal(s) exited inside the window",
      "window focus changed inside the window — someone used the machine",
      "a process crashed or was killed inside the window",
      "protected agent left the active states inside the window (completed)",
      "streaming terminal had gone quiet by the end of the window",
      "streaming workload used no CPU inside the window — it was blocked, not writing",
      "the protected view was frozen, so the freeze-exempt population was not measured",
    ]);
  });

  it("keeps an agent moving between active states", () => {
    expect(checkWindowEvents({ ...quiet, protectedAgentStates: ["waiting", "working"] })).toEqual(
      []
    );
  });

  it("treats a protected view that did not answer as frozen", () => {
    expect(
      checkWindowEvents({ ...quiet, protectedLifecycle: "no answer — the view is frozen or gone" })
    ).toEqual(["the protected view was frozen, so the freeze-exempt population was not measured"]);
  });
});

describe("frozenDuring", () => {
  it("counts only frozen intervals that overlap the window", () => {
    expect(
      frozenDuring(
        [
          ["freeze", 1],
          ["resume", 5],
        ],
        10,
        20
      )
    ).toBe(false);
    expect(frozenDuring([["freeze", 25]], 10, 20)).toBe(false);
    expect(
      frozenDuring(
        [
          ["freeze", 1],
          ["resume", 12],
        ],
        10,
        20
      )
    ).toBe(true);
    expect(
      frozenDuring(
        [
          ["freeze", 15],
          ["resume", 16],
        ],
        10,
        20
      )
    ).toBe(true);
    expect(frozenDuring([["freeze", 1]], 10, 20)).toBe(true);
    expect(
      frozenDuring(
        [
          ["resume", 12],
          ["freeze", 1],
        ],
        10,
        20
      )
    ).toBe(true);
  });
});

describe("checkWindowTiming", () => {
  const nominal = { nominalStartMs: 10_000, nominalEndMs: 310_000 };

  it("accepts sampling edges close to the nominal window", () => {
    expect(
      checkWindowTiming({ ...nominal, sampledStartMs: 10_040, sampledEndMs: 310_030 })
    ).toEqual([]);
  });

  it("rejects an edge that stalled", () => {
    expect(
      checkWindowTiming({ ...nominal, sampledStartMs: 11_300, sampledEndMs: 310_000 })
    ).toEqual([
      "samples drifted from the window (start 1300ms, end 0ms, limit 1000ms) — the machine stalled at an edge",
    ]);
  });
});
