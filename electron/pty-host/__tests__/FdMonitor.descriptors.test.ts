import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FdMonitor, classifyFds, type FdSample } from "../FdMonitor.js";
import type { FdOwnerCounts } from "../../../shared/types/pty-host.js";

// Real descriptors, real listing, real fstat — no mocks. Each vitest file runs
// in its own forked process, so the only descriptors that move are this
// test's own.

const INTERVAL = 30_000;
const NO_OWNERS: FdOwnerCounts = { terminals: 0, pooledPtys: 0, pluginPtys: 0, analysisWorkers: 0 };
const fdDir = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

function realFdCount(): number {
  return fs.readdirSync(fdDir).length;
}

describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "FdMonitor against the real descriptor table",
  () => {
    let dir: string;
    const open: number[] = [];

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "fd-monitor-"));
    });

    afterEach(() => {
      for (const fd of open.splice(0)) fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function calibratedMonitor() {
      const monitor = new FdMonitor({ startedAt: 0 });
      let now = 0;
      const transitions: NonNullable<FdSample["transition"]>[] = [];
      const sample = (): FdSample => {
        now += INTERVAL;
        const result = monitor.sample(NO_OWNERS, now);
        expect(result).not.toBeNull();
        if (result?.transition) transitions.push(result.transition);
        return result!;
      };
      let baseline: number | null = null;
      for (let i = 0; i < 20 && baseline === null; i++) baseline = sample().baselineFds;
      expect(baseline).not.toBeNull();
      return { sample, transitions };
    }

    it("catches a descriptor retained per open/close cycle and classifies it", () => {
      const { sample, transitions } = calibratedMonitor();
      const before = classifyFds(fs.readdirSync(fdDir));

      // Each cycle opens two descriptors and closes one — the second is the
      // one a buggy teardown forgets.
      let retainedAtElevation = 0;
      for (let cycle = 0; cycle < 40; cycle++) {
        const file = path.join(dir, `cycle-${cycle}`);
        const transient = fs.openSync(file, "w");
        const retained = fs.openSync(file, "r");
        fs.closeSync(transient);
        open.push(retained);
        const { transition } = sample();
        if (transition) retainedAtElevation = open.length;
      }

      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
      const elevated = transitions[0]!;
      expect(elevated.growth).toBeGreaterThanOrEqual(32);
      // Every retained descriptor shows up as a regular file.
      expect(elevated.descriptorTypes!.file - before.file).toBe(retainedAtElevation);

      for (const fd of open.splice(0)) fs.closeSync(fd);
      sample();
      sample();

      expect(transitions.map((t) => t.state)).toEqual(["elevated", "recovered"]);
      expect(transitions[1]!.episodeStartedAt).toBe(elevated.episodeStartedAt);
    });

    it("stays quiet when every opened descriptor is closed again", () => {
      const { sample, transitions } = calibratedMonitor();
      for (let cycle = 0; cycle < 60; cycle++) {
        const fd = fs.openSync(path.join(dir, `cycle-${cycle}`), "w");
        fs.closeSync(fd);
        sample();
      }
      expect(transitions).toEqual([]);
    });

    it("accounts for exactly the descriptors a worker thread holds", async () => {
      const monitor = new FdMonitor();
      const before = realFdCount();
      const worker = new Worker("setInterval(() => {}, 1000);", { eval: true });
      try {
        await new Promise<void>((resolve, reject) => {
          worker.once("online", () => resolve());
          worker.once("error", reject);
        });
        // Let the worker finish bringing up its event loop.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const held = realFdCount() - before;
        expect(held).toBe(monitor.expectedFds({ ...NO_OWNERS, analysisWorkers: 1 }));
      } finally {
        await worker.terminate();
      }
    });
  }
);
