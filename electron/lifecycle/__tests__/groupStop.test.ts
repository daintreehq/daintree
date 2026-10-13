import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as Array<{ message: string; context?: unknown }>);
vi.mock("../../utils/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: (message: string, context?: unknown) => logged.push({ message, context }),
    warn: (message: string, context?: unknown) => logged.push({ message, context }),
    error: vi.fn(),
  }),
}));

import {
  GROUP_STOP_WINDOW_MS,
  findZygotes,
  finishIfGroupStop,
  isChromiumChildSignalKill,
  noteChildProcessGone,
  noteRendererGone,
  readProcessState,
  resetGroupStopForTests,
  setChromiumChildProbeForTests,
  setGroupStopFinisher,
} from "../groupStop.js";

const gpuKilled = { type: "GPU", reason: "killed", serviceName: "GPU" } as const;
// What Electron reports for a `utilityProcess.fork` child (seen live for the
// watchdog): the service is Node's, and the fork's name goes in `name`.
const watchdogKilled = {
  type: "Utility",
  reason: "killed",
  serviceName: "node.mojom.NodeService",
  name: "daintree-watchdog",
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

describe("readProcessState", () => {
  it.each([
    ["a sleeping process with nothing pending", stat("S"), status(), "running"],
    // A default-action SIGTERM is queued as SIGKILL on every thread.
    ["a process with SIGKILL pending", stat("S"), status({ sigPnd: "100" }), "signalled"],
    ["a process with SIGTERM pending", stat("S"), status({ shdPnd: "4000" }), "signalled"],
    ["a process with SIGINT pending", stat("R"), status({ shdPnd: "2" }), "signalled"],
    ["a process with only SIGUSR1 pending", stat("S"), status({ shdPnd: "200" }), "running"],
    ["a zombie", stat("Z"), status(), "exited"],
    ["a process already exiting", stat("R", { flags: 4194564 }), status(), "exiting"],
  ])("%s → %s", (_label, statText, statusText, expected) => {
    const read = procReader({ "/proc/4242/stat": statText, "/proc/4242/status": statusText });
    expect(readProcessState(zygote, read)).toBe(expected);
  });

  it("reads the fields after the last parenthesis of a hostile process name", () => {
    const read = procReader({
      "/proc/4242/stat": stat("S").replace("(daintree)", "(x) Z (y)"),
      "/proc/4242/status": status(),
    });
    expect(readProcessState(zygote, read)).toBe("running");
  });

  it("tells a pid that now names another process from the one remembered", () => {
    const read = procReader({
      "/proc/4242/stat": stat("S", { startTime: "123456" }),
      "/proc/4242/status": status(),
    });
    expect(readProcessState(zygote, read)).toBe("replaced");
  });

  it("reports a process that has been reaped as gone", () => {
    expect(readProcessState(zygote, procReader({}))).toBe("gone");
    expect(readProcessState(zygote, procReader({ "/proc/4242/stat": stat("S") }))).toBe("gone");
  });

  it("reports an entry it may not read as unreadable", () => {
    const read = procReader({ "/proc/4242/stat": errno("EACCES") });
    expect(readProcessState(zygote, read)).toBe("unreadable");
  });
});

describe("findZygotes", () => {
  it("finds Main's zygote children by the title Chromium gives them", () => {
    const read = procReader({
      "/proc/self/task/100/children": "200 201 ",
      "/proc/self/task/101/children": "202\n",
      "/proc/self/task/102/children": "",
      // setproctitle: the arguments become one space-separated string.
      "/proc/200/cmdline": "/opt/Daintree/daintree --type=zygote --no-zygote-sandbox\0",
      "/proc/200/stat": stat("S", { pid: 200, startTime: "500" }),
      "/proc/201/cmdline": "/opt/Daintree/daintree --type=utility --utility-sub-type=node\0",
      "/proc/201/stat": stat("S", { pid: 201, startTime: "501" }),
      // An untouched argv is NUL-separated.
      "/proc/202/cmdline": "/opt/Daintree/daintree\0--type=zygote\0",
      "/proc/202/stat": stat("S", { pid: 202, startTime: "502" }),
    });
    expect(findZygotes(read, () => ["100", "101", "102"])).toEqual([
      { pid: 200, startTime: "500" },
      { pid: 202, startTime: "502" },
    ]);
  });

  it("does not take a switch that merely starts with the zygote type", () => {
    const read = procReader({
      "/proc/self/task/100/children": "200",
      "/proc/200/cmdline": "/opt/Daintree/daintree --type=zygote-helper\0",
      "/proc/200/stat": stat("S", { pid: 200, startTime: "500" }),
    });
    expect(findZygotes(read, () => ["100"])).toEqual([]);
  });

  it("skips threads and children it cannot read", () => {
    const read = procReader({
      "/proc/self/task/101/children": "200 203",
      "/proc/200/cmdline": "/opt/Daintree/daintree --type=zygote\0",
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
  const messages = () => logged.map((entry) => entry.message);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    logged.length = 0;
    resetGroupStopForTests();
    zygotesTerminating = false;
    setChromiumChildProbeForTests(() => ({
      terminating: zygotesTerminating,
      summary: zygotesTerminating ? "76904=signalled" : "76904=running",
    }));
    finisher = vi.fn<() => boolean>(() => true);
    setGroupStopFinisher(finisher);
  });

  afterEach(() => {
    resetGroupStopForTests();
    vi.useRealTimers();
  });

  it("finishes at once when the signal has reached the zygotes too, and says what it saw", () => {
    zygotesTerminating = true;

    expect(finishIfGroupStop()).toBe(true);
    expect(finisher).toHaveBeenCalledOnce();
    expect(logged).toContainEqual({
      message: "Group stop recognised on the signal, 0ms after the termination signal",
      context: { zygotes: "76904=signalled", chromiumChildKilled: false },
    });
  });

  it("leaves a signal sent to Main alone to the graceful chain", async () => {
    expect(finishIfGroupStop()).toBe(false);

    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS * 2);
    expect(finisher).not.toHaveBeenCalled();
    expect(logged).toContainEqual({
      message:
        "Termination signal: Chromium's zygotes are still running; watching for a group stop",
      context: { zygotes: "76904=running" },
    });
    expect(messages()).toContain(
      `No group stop within ${GROUP_STOP_WINDOW_MS}ms of the termination signal; the graceful shutdown continues`
    );
  });

  it("keeps looking when the zygotes are signalled a moment after Main", async () => {
    expect(finishIfGroupStop()).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    zygotesTerminating = true;
    await vi.advanceTimersByTimeAsync(50);

    expect(finisher).toHaveBeenCalledOnce();
    expect(messages().some((m) => m.startsWith("Group stop recognised while watching"))).toBe(true);
  });

  it("stops looking once the window after Main's signal has passed", async () => {
    finishIfGroupStop();

    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS + 100);
    zygotesTerminating = true;
    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS);

    expect(finisher).not.toHaveBeenCalled();
  });

  // Shutdown's own work kills children long after the signal; only the window counts.
  it("ignores a death once the window after Main's signal has passed", async () => {
    finishIfGroupStop();
    await vi.advanceTimersByTimeAsync(GROUP_STOP_WINDOW_MS + 100);

    zygotesTerminating = true;
    noteRendererGone();
    noteChildProcessGone(gpuKilled);
    await runDeferred();

    expect(finisher).not.toHaveBeenCalled();
  });

  it("lets healthy zygotes outweigh a GPU process killed next to the signal", async () => {
    setChromiumChildProbeForTests(() => ({ terminating: false, summary: "76904=running" }), true);
    finishIfGroupStop();

    noteChildProcessGone(gpuKilled);
    await runDeferred();

    expect(finisher).not.toHaveBeenCalled();
  });

  it("does not poll when there are no zygotes to look at", () => {
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

  it("tries again after a finisher that declined, logging the recognition once", async () => {
    finisher.mockReturnValueOnce(false);
    zygotesTerminating = true;
    expect(finishIfGroupStop()).toBe(true);

    noteRendererGone();
    await runDeferred();

    expect(finisher).toHaveBeenCalledTimes(2);
    expect(messages().filter((m) => m.startsWith("Group stop recognised"))).toHaveLength(1);
  });
});
