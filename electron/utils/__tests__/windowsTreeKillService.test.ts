import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { spawn } from "child_process";
import {
  TREE_KILL_FAILURES_BEFORE_COOLDOWN,
  TREE_KILL_HELPER_CLOSE_GRACE_MS,
  WindowsTreeKillService,
  type TreeKillBudget,
  type TreeKillEngine,
} from "../windowsTreeKillService.js";
import type { NormalizedTreeKillTarget, WindowsTreeKillResult } from "../windowsTreeKill.js";
import {
  createFakeTreeKillHelper,
  settleIo,
  type FakeTreeKillHelper,
} from "./helpers/fakeTreeKillHelper.js";

// Started by absolute path under %SystemRoot%, never resolved from a working directory.
const POWERSHELL = /^[A-Za-z]:\\.*\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i;

const BUDGET: TreeKillBudget = { timeoutMs: 5000, waitMs: 1500 };

function target(pid: number): NormalizedTreeKillTarget {
  return { pid, tree: true, own: false };
}

function result(mode: WindowsTreeKillResult["mode"], pid: number): WindowsTreeKillResult {
  return {
    mode,
    targeted: [pid],
    killed: mode === "tree" ? [pid] : [],
    alreadyGone: [],
    timedOut: [],
    unconfirmed: [],
    failed: [],
    identityMismatch: [],
    stale: [],
    rootEnded: mode === "tree",
  };
}

/**
 * The real engine decides what may be killed; these tests are about transport,
 * so this one answers "tree" for every root of a report with END and records
 * how each failed run was handed over.
 */
function fakeEngine() {
  return {
    serverArgs: ["-EncodedCommand", "SERVER"],
    encodeInput: vi.fn((targets: readonly NormalizedTreeKillTarget[], waitMs: number) =>
      JSON.stringify({ waitMs, roots: targets.map((t) => ({ pid: t.pid })) })
    ),
    readReport: vi.fn((targets: readonly NormalizedTreeKillTarget[], report: string) =>
      /^END$/m.test(report.replace(/\r/g, "")) ? targets.map((t) => result("tree", t.pid)) : null
    ),
    recover: vi.fn(
      async (
        targets: readonly NormalizedTreeKillTarget[],
        _partial: string,
        _complete: boolean,
        _budget: TreeKillBudget,
        _reason: string
      ) => targets.map((t) => result("root-only", t.pid))
    ),
  } satisfies TreeKillEngine;
}

describe("WindowsTreeKillService", () => {
  let helpers: FakeTreeKillHelper[];
  let spawnMock: ReturnType<typeof vi.fn>;
  let engine: ReturnType<typeof fakeEngine>;
  let service: WindowsTreeKillService;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function createService(options: { idleRetireMs?: number } = {}) {
    return new WindowsTreeKillService({
      engine,
      spawn: spawnMock as unknown as typeof spawn,
      ...options,
    });
  }

  beforeEach(() => {
    helpers = [];
    spawnMock = vi.fn(() => {
      const helper = createFakeTreeKillHelper(5000 + helpers.length);
      helpers.push(helper);
      return helper.child;
    });
    engine = fakeEngine();
    service = createService();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    service.dispose();
    vi.useRealTimers();
    warnSpy.mockRestore();
  });

  describe("queueing and coalescing", () => {
    it("runs kills made in the same tick as one request on one helper", async () => {
      const a = service.kill([target(101)], BUDGET);
      const b = service.kill([target(102), target(103)], BUDGET);
      await settleIo();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toMatch(POWERSHELL);
      expect(spawnMock.mock.calls[0][1]).toEqual(engine.serverArgs);
      expect(helpers[0].requests).toHaveLength(1);
      expect(helpers[0].rootsOf(0)).toEqual([101, 102, 103]);

      helpers[0].answer(["R 0 tree 1"]);
      expect((await a).map((r) => r.targeted)).toEqual([[101]]);
      expect((await b).map((r) => r.targeted)).toEqual([[102], [103]]);
    });

    it("holds kills that arrive during a run and runs them together next", async () => {
      const first = service.kill([target(101)], BUDGET);
      await settleIo();
      const second = service.kill([target(102)], BUDGET);
      const third = service.kill([target(103)], BUDGET);
      await settleIo();

      // One run at a time: nothing more was sent while the first is open.
      expect(helpers[0].requests).toHaveLength(1);

      helpers[0].answer([]);
      await first;
      await settleIo();

      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(helpers[0].requests).toHaveLength(2);
      expect(helpers[0].rootsOf(1)).toEqual([102, 103]);

      helpers[0].answer([]);
      expect((await second)[0].targeted).toEqual([102]);
      expect((await third)[0].targeted).toEqual([103]);
    });

    it("reports a kill as started only once a helper process has it", async () => {
      const first = vi.fn();
      const second = vi.fn();

      void service.kill([target(101)], BUDGET, first);
      expect(first).not.toHaveBeenCalled();
      await settleIo();
      expect(first).toHaveBeenCalledTimes(1);

      void service.kill([target(102)], BUDGET, second);
      await settleIo();
      // Still in this process's queue, behind the first run.
      expect(second).not.toHaveBeenCalled();
      helpers[0].answer([]);
      await settleIo();
      expect(second).toHaveBeenCalledTimes(1);
    });

    it("gives a run the largest budget among its requests", async () => {
      void service.kill([target(101)], { timeoutMs: 3000, waitMs: 500 });
      void service.kill([target(102)], { timeoutMs: 5000, waitMs: 1500 });
      await settleIo();

      expect(engine.encodeInput).toHaveBeenCalledWith([target(101), target(102)], 1500);
    });

    it("ignores a sentinel for another run and one embedded in a line", async () => {
      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      const id = helpers[0].requestIds[0];
      let settled = false;
      void kill.then(() => (settled = true));

      helpers[0].write(`E access denied __DAINTREE_TREE_KILL_END__:${id}\r\n`);
      helpers[0].write(`END\r\n__DAINTREE_TREE_KILL_END__:${id}0\r\n`);
      await settleIo();
      expect(settled).toBe(false);

      helpers[0].write(`__DAINTREE_TREE_KILL_END__:${id}\r\n`);
      expect((await kill)[0].mode).toBe("tree");
    });
  });

  describe("when the persistent helper fails", () => {
    it("finishes the run through the one-shot from what it wrote, and every pending kill resolves", async () => {
      const inFlight = service.kill([target(101)], BUDGET);
      await settleIo();
      const queued = service.kill([target(102)], BUDGET);
      await settleIo();

      helpers[0].write("R 0 tree 1234\r\nK\r\n");
      helpers[0].die(3);

      const [recovered] = await inFlight;
      expect(recovered.mode).toBe("root-only");
      expect(engine.recover).toHaveBeenCalledTimes(1);
      const [targets, partial, complete, budget, reason] = engine.recover.mock.calls[0];
      expect(targets).toEqual([target(101)]);
      expect(partial).toContain("K");
      // The pipe closed, so the partial report is everything there was.
      expect(complete).toBe(true);
      expect(budget).toEqual(BUDGET);
      expect(reason).toMatch(/exited \(code=3/);

      // The kill that was waiting gets a fresh helper.
      await settleIo();
      expect(spawnMock).toHaveBeenCalledTimes(2);
      helpers[1].answer([]);
      expect((await queued)[0].mode).toBe("tree");
    });

    it("finishes through the one-shot when PowerShell cannot be started", async () => {
      spawnMock.mockImplementationOnce(() => {
        throw new Error("spawn powershell.exe ENOENT");
      });
      const started = vi.fn();

      const [recovered] = await service.kill([target(101)], BUDGET, started);

      expect(recovered.mode).toBe("root-only");
      // The one-shot helper has it.
      expect(started).toHaveBeenCalledTimes(1);
      expect(engine.recover).toHaveBeenCalledWith(
        [target(101)],
        "",
        true,
        BUDGET,
        expect.stringContaining("ENOENT")
      );
    });

    it("terminates a helper that runs past the budget and recovers once its pipe closes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = service.kill([target(101)], { timeoutMs: 1000, waitMs: 0 });
      await settleIo();
      helpers[0].write("R 0 tree 1234\r\nK\r\n");
      await settleIo();

      vi.advanceTimersByTime(1000);
      await kill;

      expect(helpers[0].killed).toBe(true);
      const [, partial, complete, , reason] = engine.recover.mock.calls[0];
      expect(partial).toContain("R 0 tree 1234");
      expect(complete).toBe(true);
      expect(reason).toMatch(/timed out/);
    });

    it("says the report may be missing lines when a terminated helper's pipe never closes", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = service.kill([target(101)], { timeoutMs: 1000, waitMs: 0 });
      await settleIo();
      helpers[0].dieOnKill = false;

      vi.advanceTimersByTime(1000);
      await settleIo();
      expect(engine.recover).not.toHaveBeenCalled();
      vi.advanceTimersByTime(TREE_KILL_HELPER_CLOSE_GRACE_MS);
      await kill;

      expect(engine.recover.mock.calls[0][2]).toBe(false);
    });

    it("takes a complete report that arrives while the helper is being given up on", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const kill = service.kill([target(101)], { timeoutMs: 1000, waitMs: 0 });
      await settleIo();
      helpers[0].dieOnKill = false;
      vi.advanceTimersByTime(1000);

      helpers[0].answer(["R 0 tree 1"]);

      expect((await kill)[0].mode).toBe("tree");
      expect(engine.recover).not.toHaveBeenCalled();
    });

    it("treats a report without END as a failure", async () => {
      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      helpers[0].write(`R 0 tree 1\r\n__DAINTREE_TREE_KILL_END__:${helpers[0].requestIds[0]}\r\n`);

      expect((await kill)[0].mode).toBe("root-only");
      expect(helpers[0].killed).toBe(true);
    });

    it("stops starting helpers after repeated failures and goes straight to the one-shot", async () => {
      spawnMock.mockImplementation(() => {
        throw new Error("spawn powershell.exe EPERM");
      });

      for (let i = 0; i < TREE_KILL_FAILURES_BEFORE_COOLDOWN; i++) {
        await service.kill([target(101 + i)], BUDGET);
      }
      expect(spawnMock).toHaveBeenCalledTimes(TREE_KILL_FAILURES_BEFORE_COOLDOWN);

      await service.kill([target(200)], BUDGET);

      expect(spawnMock).toHaveBeenCalledTimes(TREE_KILL_FAILURES_BEFORE_COOLDOWN);
      expect(engine.recover).toHaveBeenLastCalledWith(
        [target(200)],
        "",
        true,
        BUDGET,
        expect.stringContaining("cooling down")
      );
    });

    it("retires a helper that writes when nothing was asked", async () => {
      await settleIo();
      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      helpers[0].answer([]);
      await kill;

      helpers[0].write("unexpected\r\n");
      await settleIo();

      expect(helpers[0].killed).toBe(true);
      expect(service.isRunning).toBe(false);
    });
  });

  describe("lifetime", () => {
    it("retires an idle helper, and the next kill starts a fresh one", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      service = createService({ idleRetireMs: 30_000 });
      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      helpers[0].answer([]);
      await kill;

      vi.advanceTimersByTime(29_999);
      expect(helpers[0].stdinEnded).toBe(false);
      vi.advanceTimersByTime(1);
      expect(helpers[0].stdinEnded).toBe(true);
      expect(helpers[0].killed).toBe(true);
      expect(service.isRunning).toBe(false);

      void service.kill([target(102)], BUDGET);
      await settleIo();
      expect(spawnMock).toHaveBeenCalledTimes(2);
    });

    it("does not retire a helper while a run is queued or in flight", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      service = createService({ idleRetireMs: 10 });
      const first = service.kill([target(101)], BUDGET);
      await settleIo();
      helpers[0].answer([]);
      await first;
      void service.kill([target(102)], BUDGET);
      await settleIo();

      vi.advanceTimersByTime(50);

      expect(helpers[0].stdinEnded).toBe(false);
      expect(service.retireIfIdle()).toBe(false);
    });

    it("starts a helper ahead of the first kill and keeps it while held warm", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      service = createService({ idleRetireMs: 10 });

      service.setKeepWarm(true);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      expect(helpers[0].requests).toHaveLength(1);
      helpers[0].answer([]);
      await kill;
      vi.advanceTimersByTime(1000);
      expect(helpers[0].stdinEnded).toBe(false);

      service.setKeepWarm(false);
      vi.advanceTimersByTime(10);
      expect(helpers[0].stdinEnded).toBe(true);
    });

    it("replaces a helper that failed a run while held warm", async () => {
      service.setKeepWarm(true);
      const kill = service.kill([target(101)], BUDGET);
      await settleIo();
      helpers[0].die();
      await kill;
      await settleIo();

      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(service.isRunning).toBe(true);
    });

    it("finishes the run in flight and every later kill through the one-shot once disposed", async () => {
      const inFlight = service.kill([target(101)], BUDGET);
      await settleIo();

      service.dispose();
      expect((await inFlight)[0].mode).toBe("root-only");
      expect(engine.recover.mock.calls[0][4]).toMatch(/disposed/);

      expect((await service.kill([target(102)], BUDGET))[0].mode).toBe("root-only");
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });
  });
});
