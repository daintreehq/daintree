import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_RESTART_STARTUP_SAMPLES } from "../../../../shared/config/memoryLeakPolicy.js";
import type {
  PtyHostEvent,
  TerminalResourceBatchPayload,
} from "../../../../shared/types/pty-host.js";
import {
  resetPhysFootprintReaderForTesting,
  setPhysFootprintReaderForTesting,
} from "../../../utils/processMemory.js";
import { MemoryLeakAutoRestartService } from "../../MemoryLeakAutoRestartService.js";
import { ProcessTreeCache } from "../../ProcessTreeCache.js";
import type { PtyManager } from "../../PtyManager.js";
import { TerminalResourceMonitor } from "../TerminalResourceMonitor.js";

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock("child_process", () => ({
  exec: vi.fn(),
  execFile: mockExecFile,
  spawn: vi.fn(),
}));

const SHELL_PID = 100;
const PROBE_PID = 999;
const THRESHOLD_MB = 1024;
const OVER_THRESHOLD_KB = THRESHOLD_MB * 1024 * 2;

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function psSucceeds(agentRssKb: number): void {
  mockExecFile.mockImplementation((_f: string, _a: unknown, _o: unknown, cb: ExecCallback) => {
    cb(
      null,
      [
        "  PID  PPID %CPU   RSS COMM COMMAND",
        `  ${SHELL_PID}     1  0.0  2048 zsh /bin/zsh -l`,
        `  101   ${SHELL_PID}  3.0  ${agentRssKb} node node agent.js`,
        `  ${PROBE_PID}     1  0.0   512 ps ps -eo pid`,
      ].join("\n"),
      ""
    );
    return { pid: PROBE_PID };
  });
}

function psFails(): void {
  mockExecFile.mockImplementation((_f: string, _a: unknown, _o: unknown, cb: ExecCallback) => {
    cb(new Error("ps: operation not permitted"), "", "");
    return { pid: PROBE_PID };
  });
}

describe("TerminalResourceMonitor", () => {
  let cache: ProcessTreeCache;
  let events: Array<Extract<PtyHostEvent, { type: "resource-metrics" }>>;
  let monitor: TerminalResourceMonitor;
  const disposers: Array<() => void> = [];

  /** `subscribeAhead` registers refresh listeners that run before the monitor's. */
  async function enableAfterFirstCensus(subscribeAhead?: () => void): Promise<void> {
    const refresh = vi.spyOn(cache, "refresh");
    subscribeAhead?.();
    monitor = new TerminalResourceMonitor(
      cache,
      {
        getAll: () => [{ id: "t1", ptyProcess: { pid: SHELL_PID } }],
      } as unknown as PtyManager,
      (event) => {
        if (event.type === "resource-metrics") events.push(event);
      }
    );
    monitor.setEnabled(true);
    // The first subscriber kicks off a census of its own.
    expect(refresh).toHaveBeenCalledTimes(1);
    await refresh.mock.results[0]!.value;
    refresh.mockRestore();
    expect(events).toHaveLength(1);
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    setPhysFootprintReaderForTesting(null);
    mockExecFile.mockReset();
    cache = new ProcessTreeCache(2500);
    (cache as unknown as { isWindows: boolean }).isWindows = false;
    events = [];
  });

  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
    monitor?.dispose();
    cache.stop();
    resetPhysFootprintReaderForTesting();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("publishes nothing for a census that failed after a successful one", async () => {
    psSucceeds(4096);
    await enableAfterFirstCensus();
    // Other subscribers still hear a failed census: process detection holds
    // its state on the cache's error rather than reading an empty tree.
    const notified = vi.fn();
    cache.onRefresh(notified);

    psFails();
    await cache.refresh();
    await cache.refresh();

    expect(cache.getLastError()).not.toBeNull();
    expect(notified).toHaveBeenCalledTimes(2);
    expect(events).toHaveLength(1);
  });

  it("stamps a recovered sample with the time of the census that measured it", async () => {
    vi.setSystemTime(1_000);
    psSucceeds(4096);
    // Runs ahead of the monitor on every census, so the time a batch is sent
    // is never the time its census finished.
    await enableAfterFirstCensus(() => cache.onRefresh(() => vi.setSystemTime(Date.now() + 500)));
    expect(events[0]!.timestamp).toBe(1_000);

    vi.setSystemTime(5_000);
    psFails();
    await cache.refresh();

    vi.setSystemTime(9_000);
    psSucceeds(8192);
    await cache.refresh();

    expect(events).toHaveLength(2);
    expect(events[1]!.timestamp).toBe(9_000);
    expect(events[1]!.metrics.t1!.memoryKb).toBe(2048 + 8192);
  });

  it("does not advance the auto-restart startup count on a failed census", async () => {
    const readTerminal = vi.fn(async () => null);
    let deliver: ((metrics: TerminalResourceBatchPayload) => void) | null = null;
    const service = new MemoryLeakAutoRestartService({
      onMetrics: (listener) => {
        deliver = listener;
        return () => {};
      },
      onExit: () => () => {},
      readPolicy: () => ({ enabled: true, thresholdMb: THRESHOLD_MB }),
      generationOf: () => 1,
      readTerminal,
      pickTarget: () => ({ kind: "wait" }),
      restartOnHost: async () => "restarted",
      now: () => Date.now(),
    });
    disposers.push(() => service.dispose());
    const forwarded: number[] = [];
    const onEvent = (): void => {
      while (forwarded.length < events.length) {
        const event = events[forwarded.length]!;
        forwarded.push(event.timestamp);
        deliver?.(event.metrics);
      }
    };

    psSucceeds(OVER_THRESHOLD_KB);
    await enableAfterFirstCensus();
    onEvent();
    // One short of the startup grace, every sample over the threshold.
    for (let i = 1; i < AUTO_RESTART_STARTUP_SAMPLES - 1; i++) {
      await cache.refresh();
      onEvent();
    }
    expect(readTerminal).not.toHaveBeenCalled();

    psFails();
    for (let i = 0; i < 5; i++) {
      await cache.refresh();
      onEvent();
    }
    expect(readTerminal).not.toHaveBeenCalled();

    psSucceeds(OVER_THRESHOLD_KB);
    await cache.refresh();
    onEvent();
    expect(readTerminal).toHaveBeenCalledTimes(1);
    expect(forwarded).toHaveLength(AUTO_RESTART_STARTUP_SAMPLES);
  });

  it("publishes nothing for a census that completes after the monitor is disposed", async () => {
    psSucceeds(4096);
    await enableAfterFirstCensus();

    psSucceeds(8192);
    const pending = cache.refresh();
    monitor.dispose();
    await pending;

    expect(cache.getTreeResourceSummary(SHELL_PID)!.memoryKb).toBe(2048 + 8192);
    expect(events).toHaveLength(1);
  });
});
