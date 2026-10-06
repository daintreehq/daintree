import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { probeStartTimesSync, takeKillCensusSync } from "../TerminalLineageLedger.js";

// Runs the real `ps`: the census's parse and the per-PID probe's parse have to
// agree on the identity string for whatever this platform's ps prints, which a
// fixture cannot prove.
describe.skipIf(process.platform === "win32")("takeKillCensusSync against the real ps", () => {
  let child: ChildProcess | null = null;

  afterEach(async () => {
    const running = child;
    child = null;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill("SIGKILL");
    await exited;
  });

  it("sees a just-spawned child with the identity the ledger probe records", async () => {
    child = spawn("sleep", ["30"], { stdio: "ignore" });
    const spawned = child;
    await new Promise<void>((resolve, reject) => {
      spawned.once("spawn", () => resolve());
      spawned.once("error", reject);
    });
    const pid = spawned.pid!;

    const census = takeKillCensusSync(5000);

    expect(census).not.toBeNull();
    expect(census!.childrenOf(process.pid)).toContain(pid);
    const startTime = census!.startTimeOf(pid);
    expect(startTime).toBeTruthy();
    expect(probeStartTimesSync([pid], 5000).get(pid)).toBe(startTime);
  });
});
