import { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spawnObserverMisses } from "../lib/gitPipelineFixture";

/**
 * The observer behind every spawn count in this suite is an in-process patch of
 * `ChildProcess.prototype.spawn`. A count of zero has two causes that look
 * identical in the results file — the subsystem stopped spawning, or the hook
 * stopped observing — and the second one reads as the best number the harness
 * has ever recorded.
 */
describe("spawn counter self-validation", () => {
  it("proves itself against a real child process", () => {
    expect(spawnObserverMisses()).toBe(0);
  });

  it("reports a miss once something else owns the prototype hook", () => {
    const proto = ChildProcess.prototype as unknown as { spawn: unknown };
    const ours = proto.spawn;
    proto.spawn = function replacement(): undefined {
      return undefined;
    };
    try {
      expect(spawnObserverMisses()).toBe(1);
    } finally {
      proto.spawn = ours;
    }
    // And recovers once the hook is back, so a transient re-patch does not
    // permanently poison every later scenario's reading.
    expect(spawnObserverMisses()).toBe(0);
  });
});
