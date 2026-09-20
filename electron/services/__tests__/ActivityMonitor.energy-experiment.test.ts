import { test, vi } from "vitest";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { replayCastThroughFsm, loadExpected } from "./replay/castReplayHarness.js";
import { ActivityMonitor } from "../ActivityMonitor.js";

// Investigation apparatus only: report counterfactual cadences; do not change production defaults.
test.skipIf(process.env.RUN_ACTIVITY_ENERGY_REPLAY !== "1")(
  "compare detection timelines and polling work at alternative cadences",
  async () => {
    const root = path.join(import.meta.dirname, "fixtures/activity-monitor");
    const names = readdirSync(root)
      .filter((n) => n.endsWith(".expected.json"))
      .map((n) => n.replace(".expected.json", ""));
    const result = [];
    for (const name of names) {
      const expected = loadExpected(path.join(root, name + ".expected.json"));
      for (const seed of [null, 42, 12345, 99999]) {
        const arms = [];
        for (const pollingIntervalMs of [50, 100, 200, 400, 500, 1000]) {
          vi.useFakeTimers({
            toFake: [
              "setTimeout",
              "clearTimeout",
              "setInterval",
              "clearInterval",
              "setImmediate",
              "clearImmediate",
              "Date",
              "performance",
            ],
          });
          vi.setSystemTime(1700000000000);
          const proto = ActivityMonitor.prototype as unknown as { runPollingCycle: () => void };
          const poll = vi.spyOn(proto, "runPollingCycle");
          const snapshotProto = ActivityMonitor.prototype as unknown as {
            computeSimpleOutputSnapshot: () => unknown;
          };
          const compute = snapshotProto.computeSimpleOutputSnapshot;
          let snapshotComputes = 0;
          let unchangedSnapshots = 0;
          let priorSnapshot = "";
          vi.spyOn(snapshotProto, "computeSimpleOutputSnapshot").mockImplementation(function (
            this: unknown
          ) {
            const result = compute.call(this);
            snapshotComputes++;
            const signature = JSON.stringify(result);
            if (signature === priorSnapshot) unchangedSnapshots++;
            priorSnapshot = signature;
            return result;
          });

          try {
            const replay = await replayCastThroughFsm(path.join(root, name + ".cast"), {
              agentId: expected.agentId,
              settleMs: expected.settleMs,
              pollingMaxBootMs: expected.pollingMaxBootMs,
              maxWorkingSilenceMs: expected.maxWorkingSilenceMs,
              idleDebounceMs: expected.idleDebounceMs,
              promptFastPathMinQuietMs: expected.promptFastPathMinQuietMs,
              pollingIntervalMs,
              fragmentation: seed === null ? undefined : { seed, maxSplits: 4 },
            });
            arms.push({
              pollingIntervalMs,
              polls: poll.mock.calls.length,
              snapshotComputes,
              unchangedSnapshots,
              ...replay,
            });
          } finally {
            vi.restoreAllMocks();
            vi.clearAllTimers();
            vi.useRealTimers();
          }
        }
        result.push({ name, seed, arms });
      }
    }
    writeFileSync(
      path.join(tmpdir(), "daintree-energy-detection-fsm-cadences.json"),
      JSON.stringify(result, null, 2)
    );
    console.log("Detection cadence comparisons:", result.length);
  },
  180000
);
