import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GROUP_STOP_WINDOW_MS,
  findZygotes,
  finishIfGroupStop,
  isChromiumChildSignalKill,
  isProcessTerminating,
  noteChildProcessGone,
  noteRendererGone,
  resetGroupStopForTests,
  setChromiumChildProbeForTests,
  setGroupStopFinisher,
} from "../groupStop.js";

const gpuKilled = { type: "GPU", reason: "killed", serviceName: "GPU" } as const;
const watchdogKilled = {
  type: "Utility",
  reason: "killed",
  serviceName: "daintree-watchdog",
} as const;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function procReader(files: Record<string, string | NodeJS.ErrnoException>) {
  return (procPath: string): string => {
    const entry = files[procPath];
    if (entry === undefined) throw errno("ENOENT");
    if (typeof entry !== "string") throw entry;
    return entry;
  };
}

// Field 9 is `flags` (4194560 = 0x400100, PF_EXITING clear); field 22 is the
// start time.
const stat = (state: string, { flags = 4194560, startTime = "9001", pid = 4242 } = {}) =>
  `${pid} (daintree) ${state} 4100 4000 4000 0 -1 ${flags} 1210 0 0 0 31 9 0 0 20 0 21 0 ${startTime} 0 0`;
const status = ({ sigPnd = "0", shdPnd = "0" } = {}) =>
  [
    "Name:\tdaintree",
    "State:\tS (sleeping)",
    "SigQ:\t0/63379",
    `SigPnd:\t${sigPnd.padStart(16, "0")}`,
    `ShdPnd:\t${shdPnd.padStart(16, "0")}`,
    "SigBlk:\t0000000000000000",
    "SigIgn:\t0000000000001000",
    "SigCgt:\t0000000180004a02",
  ].join("\n");

const zygote = { pid: 4242, startTime: "9001" };

describe("isProcessTerminating", () => {
  it.each([
    ["a sleeping process with nothing pending", stat("S"), status(), false],
    // A default-action SIGTERM is queued as SIGKILL on every thread.
    ["a process with SIGKILL pending", stat("S"), status({ sigPnd: "100" }), true],
    ["a process with SIGTERM pending process-wide", stat("S"), status({ shdPnd: "4000" }), true],
    ["a process with SIGINT pending", stat("R"), status({ shdPnd: "2" }), true],
    ["a process with only SIGUSR1 pending", stat("S"), status({ shdPnd: "200" }), false],
    ["a zombie", stat("Z"), status(), true],
    ["a process already exiting", stat("R", { flags: 4194564 }), status(), true],
  ])("%s → %s", (_label, statText, statusText, expected) => {
    const read = procReader({ "/proc/4242/stat": statText, "/proc/4242/status": statusText });
    expect(isProcessTerminating(zygote, read)).toBe(expected);
  });

  it("reads the fields after the last parenthesis of a hostile process name", () => {
    const read = procReader({
      "/proc/4242/stat": stat("S").replace("(daintree)", "(x) Z (y)"),
      "/proc/4242/status": status(),
    });
    expect(isProcessTerminating(zygote, read)).toBe(false);
  });

  it("treats a pid that now names another process as the old one gone", () => {
    const read = procReader({
      "/proc/4242/stat": stat("S", { startTime: "123456" }),
      "/proc/4242/status": status(),
    });
    expect(isProcessTerminating(zygote, read)).toBe(true);
  });

  it("treats a process that is already gone as terminated", () => {
    expect(isProcessTerminating(zygote, procReader({}))).toBe(true);
    expect(isProcessTerminating(zygote, procReader({ "/proc/4242/stat": stat("S") }))).toBe(true);
  });

  it("treats an unreadable process as alive", () => {
    const read = procReader({ "/proc/4242/stat": errno("EACCES") });
    expect(isProcessTerminating(zygote, read)).toBe(false);
  });
});

describe("findZygotes", () => {
  it("returns Main's children whose command line marks them as a zygote", () => {
    const read = procReader({
      "/proc/self/task/100/children": "200 201 ",
      "/proc/self/task/101/children": "202\n",
      "/proc/self/task/102/children": "",
      "/proc/200/cmdline": "/opt/Daintree/daintree\0--type=zygote\0--no-zygote-sandbox\0",
      "/proc/200/stat": stat("S", { pid: 200, startTime: "500" }),
      "/proc/201/cmdline": "/opt/Daintree/daintree\0--type=utility\0--utility-sub-type=node\0",
      "/proc/201/stat": stat("S", { pid: 201, startTime: "501" }),
      "/proc/202/cmdline": "/opt/Daintree/daintree\0--type=zygote\0",
      "/proc/202/stat": stat("S", { pid: 202, startTime: "502" }),
    });
    expect(findZygotes(read, () => ["100", "101", "102"])).toEqual([
      { pid: 200, startTime: "500" },
      { pid: 202, startTime: "502" },
    ]);
  });

  it("skips threads and children it cannot read", () => {
    const read = procReader({
      "/proc/self/task/101/children": "200 203",
      "/proc/200/cmdline": "/opt/Daintree/daintree\0--type=zygote\0",
      "/proc/200/stat": stat("S", { pid: 200, startTime: "500" }),
    });
    expect(findZygotes(read, () => ["100", "101"])).toEqual([{ pid: 200, startTime: "500" }]);
  });

  it("finds nothing when Main's threads cannot be listed", () => {
    const listThreads = () => {
      throw errno("ENOENT");
    };
    expect(findZygotes(procReader({}), listThreads)).toEqual([]);
  });
});

describe("isChromiumChildSignalKill", () => {
  it.each([
    ["the GPU process killed by a signal", gpuKilled, true],
    [
      "Chromium's network service killed by a signal",
      { type: "Utility", reason: "killed", serviceName: "network.mojom.NetworkService" },
      true,
    ],
    ["a GPU crash", { type: "GPU", reason: "crashed", serviceName: "GPU" }, false],
    ["a GPU clean exit", { type: "GPU", reason: "clean-exit", serviceName: "GPU" }, false],
    ["a Daintree utility process killed by a signal", watchdogKilled, false],
    ["a utility process with no service name", { type: "Utility", reason: "killed" }, false],
  ] as const)("%s → %s", (_label, details, expected) => {
    expect(isChromiumChildSignalKill(details)).toBe(expected);
  });
});

describe("group stop detection", () => {
  let finisher: ReturnType<typeof vi.fn<() => boolean>>;
  let zygotesTerminating: boolean;
  const runDeferred = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    resetGroupStopForTests();
    zygotesTerminating = false;
    setChromiumChildProbeForTests(() => zygotesTerminating);
    finisher = vi.fn<() => boolean>(() => true);
    setGroupStopFinisher(finisher);
  });

  afterEach(() => {
    resetGroupStopForTests();
    vi.useRealTimers();
  });

  it("finishes at once when the signal has reached the zygotes too", () => {
    zygotesTerminating = true;

    expect(finishIfGroupStop()).toBe(true);
    expect(finisher).toHaveBeenCalledOnce();
  });

  it("leaves a signal sent to Main alone to the graceful chain", async () => {
    expect(finishIfGroupStop()).toBe(false);

    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS * 2);
    expect(finisher).not.toHaveBeenCalled();
  });

  it("keeps looking when the zygotes are signalled a moment after Main", async () => {
    expect(finishIfGroupStop()).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    zygotesTerminating = true;
    await vi.advanceTimersByTimeAsync(50);

    expect(finisher).toHaveBeenCalledOnce();
  });

  it("stops looking once the window after Main's signal has passed", async () => {
    finishIfGroupStop();

    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS + 100);
    zygotesTerminating = true;
    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS);

    expect(finisher).not.toHaveBeenCalled();
  });

  it("does not poll when there is nothing to look at", () => {
    setChromiumChildProbeForTests(null);

    expect(finishIfGroupStop()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("looks again a turn after a child dies during the signal shutdown", async () => {
    finishIfGroupStop();
    zygotesTerminating = true;

    noteChildProcessGone(watchdogKilled);
    // Not inside Chromium's teardown of the dead child.
    expect(finisher).not.toHaveBeenCalled();

    await runDeferred();
    expect(finisher).toHaveBeenCalledOnce();
  });

  it("looks again a turn after a renderer dies during the signal shutdown", async () => {
    finishIfGroupStop();
    zygotesTerminating = true;

    noteRendererGone();
    await runDeferred();

    expect(finisher).toHaveBeenCalledOnce();
  });

  it("takes a Chromium child killed next to Main's signal as evidence the probe cannot give", async () => {
    finishIfGroupStop();

    noteChildProcessGone(gpuKilled);
    await runDeferred();

    expect(finisher).toHaveBeenCalledOnce();
  });

  it("takes a Chromium child killed just before Main's signal as evidence", () => {
    noteChildProcessGone(gpuKilled, 100_000);

    expect(finishIfGroupStop(100_000 + GROUP_STOP_WINDOW_MS)).toBe(true);
    expect(finisher).toHaveBeenCalledOnce();
  });

  it("does not tie a Chromium child killed well before Main's signal to it", () => {
    noteChildProcessGone(gpuKilled, 100_000);

    expect(finishIfGroupStop(100_000 + GROUP_STOP_WINDOW_MS + 1)).toBe(false);
    expect(finisher).not.toHaveBeenCalled();
  });

  it("does not finish for Daintree's own processes or a GPU crash", async () => {
    finishIfGroupStop();

    noteChildProcessGone(watchdogKilled);
    noteChildProcessGone({ type: "GPU", reason: "crashed", serviceName: "GPU" });
    noteRendererGone();
    await runDeferred();

    expect(finisher).not.toHaveBeenCalled();
  });

  it("leaves the app running when children die before Main has any signal", async () => {
    zygotesTerminating = true;

    noteChildProcessGone(gpuKilled);
    noteRendererGone();
    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS);

    expect(finisher).not.toHaveBeenCalled();
  });

  it("finishes only once however many deaths follow", async () => {
    zygotesTerminating = true;
    expect(finishIfGroupStop()).toBe(true);

    noteChildProcessGone(gpuKilled);
    noteRendererGone();
    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS);

    expect(finisher).toHaveBeenCalledOnce();
  });

  it("tries again after a finisher that declined", async () => {
    finisher.mockReturnValueOnce(false);
    zygotesTerminating = true;
    expect(finishIfGroupStop()).toBe(true);

    noteRendererGone();
    await runDeferred();

    expect(finisher).toHaveBeenCalledTimes(2);
  });
});
