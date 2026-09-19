import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FdMonitor, classifyFds, type FdSample } from "../FdMonitor.js";
import type { FdOwnerCounts } from "../../../shared/types/pty-host.js";

// Real descriptors, real listing, real fstat — no mocks. Each vitest file runs
// in its own forked process, so the only descriptors that move are this
// test's own.

const INTERVAL = 30_000;
const NO_OWNERS: FdOwnerCounts = { terminals: 0, pooledPtys: 0, pluginPtys: 0, analysisWorkers: 0 };
const fdDir = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

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

    it("catches a descriptor retained per open/close cycle and classifies it", () => {
      const monitor = new FdMonitor({ startedAt: 0 });
      let now = 0;
      const transitions: NonNullable<FdSample["transition"]>[] = [];
      const sample = () => {
        now += INTERVAL;
        const result = monitor.sample(NO_OWNERS, now);
        expect(result).not.toBeNull();
        if (result?.transition) transitions.push(result.transition);
        return result!;
      };

      while (sample().baselineFds === null) {
        // warm-up and settle on the untouched table
      }
      const before = classifyFds(fs.readdirSync(fdDir));

      // Each cycle opens two descriptors and closes one — the second is the
      // one a buggy teardown forgets.
      for (let cycle = 0; cycle < 40; cycle++) {
        const file = path.join(dir, `cycle-${cycle}`);
        const transient = fs.openSync(file, "w");
        const retained = fs.openSync(file, "r");
        fs.closeSync(transient);
        open.push(retained);
        sample();
      }

      expect(transitions.map((t) => t.state)).toEqual(["elevated"]);
      const elevated = transitions[0]!;
      expect(elevated.growth).toBeGreaterThanOrEqual(32);
      expect(elevated.descriptorTypes!.file - before.file).toBeGreaterThanOrEqual(elevated.growth);

      for (const fd of open.splice(0)) fs.closeSync(fd);
      sample();
      sample();

      expect(transitions.map((t) => t.state)).toEqual(["elevated", "recovered"]);
      expect(Math.abs(transitions[1]!.growth)).toBeLessThanOrEqual(2);
      expect(transitions[1]!.episodeStartedAt).toBe(elevated.episodeStartedAt);
    });

    it("stays quiet when every opened descriptor is closed again", () => {
      const monitor = new FdMonitor({ startedAt: 0 });
      let now = 0;
      for (let cycle = 0; cycle < 60; cycle++) {
        const fd = fs.openSync(path.join(dir, `cycle-${cycle}`), "w");
        fs.closeSync(fd);
        now += INTERVAL;
        expect(monitor.sample(NO_OWNERS, now)?.transition).toBeNull();
      }
    });
  }
);
