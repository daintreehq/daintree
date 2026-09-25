import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  OUTPUT_RECOVERY_GRACE_MS,
  OUTPUT_RECOVERY_MAX_FAILURES,
  OUTPUT_RECOVERY_PROBE_INTERVAL_MS,
  TerminalOutputRecovery,
} from "../TerminalOutputRecovery";
import type { MissingOutputRecoveryOutcome } from "../TerminalRestoreController";
import type { ManagedTerminal } from "../types";
import type { TerminalScrollbackRestoreError } from "@shared/types/panel";

vi.mock("@/utils/logger", () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

describe("TerminalOutputRecovery (#12754)", () => {
  let instances: Map<string, ManagedTerminal>;
  let recoverMissingOutput: ReturnType<
    typeof vi.fn<(id: string) => Promise<MissingOutputRecoveryOutcome>>
  >;
  let reportUnrecoverable: ReturnType<
    typeof vi.fn<(id: string, error: TerminalScrollbackRestoreError) => void>
  >;
  let recovery: TerminalOutputRecovery;

  beforeEach(() => {
    instances = new Map();
    recoverMissingOutput = vi.fn<(id: string) => Promise<MissingOutputRecoveryOutcome>>();
    reportUnrecoverable = vi.fn<(id: string, error: TerminalScrollbackRestoreError) => void>();
    recovery = new TerminalOutputRecovery({
      getInstance: (id) => instances.get(id),
      recoverMissingOutput,
      reportUnrecoverable,
    });
  });

  function addPane(overrides: Partial<ManagedTerminal> = {}): ManagedTerminal {
    const managed = { ...overrides } as ManagedTerminal;
    instances.set("t1", managed);
    return managed;
  }

  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it("waits out the grace window after first sighting before probing", () => {
    const managed = addPane();
    recoverMissingOutput.mockResolvedValue("no-host-output");

    expect(recovery.maybeProbe("t1", managed, 1000)).toBe(false);
    expect(recovery.maybeProbe("t1", managed, 1000 + OUTPUT_RECOVERY_GRACE_MS - 1)).toBe(false);
    expect(recoverMissingOutput).not.toHaveBeenCalled();

    expect(recovery.maybeProbe("t1", managed, 1000 + OUTPUT_RECOVERY_GRACE_MS)).toBe(true);
    expect(recoverMissingOutput).toHaveBeenCalledWith("t1");
  });

  it("keeps probing a silent pane at the probe interval without ever reporting it", async () => {
    const managed = addPane();
    recoverMissingOutput.mockResolvedValue("no-host-output");

    recovery.maybeProbe("t1", managed, 0);
    expect(recovery.maybeProbe("t1", managed, OUTPUT_RECOVERY_GRACE_MS)).toBe(true);
    await settle();

    const next = OUTPUT_RECOVERY_GRACE_MS + OUTPUT_RECOVERY_PROBE_INTERVAL_MS;
    expect(recovery.maybeProbe("t1", managed, next - 1)).toBe(false);
    expect(recovery.maybeProbe("t1", managed, next)).toBe(true);
    await settle();

    expect(recoverMissingOutput).toHaveBeenCalledTimes(2);
    expect(reportUnrecoverable).not.toHaveBeenCalled();
    expect(managed.outputRecoveryGaveUp).toBeUndefined();
  });

  it("does not start a second probe while one is in flight", () => {
    const managed = addPane();
    recoverMissingOutput.mockReturnValue(new Promise(() => {}));

    recovery.maybeProbe("t1", managed, 0);
    expect(recovery.maybeProbe("t1", managed, OUTPUT_RECOVERY_GRACE_MS)).toBe(true);
    expect(recovery.maybeProbe("t1", managed, 10 * OUTPUT_RECOVERY_PROBE_INTERVAL_MS)).toBe(false);
    expect(recoverMissingOutput).toHaveBeenCalledTimes(1);
  });

  it("stops watching once a recovery repaints the pane", async () => {
    const managed = addPane();
    recoverMissingOutput.mockResolvedValue("recovered");

    recovery.maybeProbe("t1", managed, 0);
    recovery.maybeProbe("t1", managed, OUTPUT_RECOVERY_GRACE_MS);
    await settle();

    expect(managed.hasReceivedOutput).toBe(true);
    expect(recovery.isCandidate(managed)).toBe(false);
  });

  it("never probes a pane that has received output", () => {
    const managed = addPane({ hasReceivedOutput: true });
    expect(recovery.maybeProbe("t1", managed, 0)).toBe(false);
    expect(recovery.maybeProbe("t1", managed, 60_000)).toBe(false);
    expect(recoverMissingOutput).not.toHaveBeenCalled();
  });

  it("reports the pane after repeated failed recoveries, with the classified error", async () => {
    const managed = addPane();
    const error: TerminalScrollbackRestoreError = {
      type: "timeout",
      message: "Write timeout",
      timestamp: 1,
    };
    recoverMissingOutput.mockImplementation(async () => {
      managed.lastScrollbackRestoreError = error;
      return "failed";
    });

    let now = 0;
    recovery.maybeProbe("t1", managed, now);
    for (let i = 0; i < OUTPUT_RECOVERY_MAX_FAILURES; i++) {
      now += OUTPUT_RECOVERY_PROBE_INTERVAL_MS;
      expect(recovery.maybeProbe("t1", managed, now)).toBe(true);
      await settle();
    }

    expect(reportUnrecoverable).toHaveBeenCalledTimes(1);
    expect(reportUnrecoverable).toHaveBeenCalledWith("t1", error);
    expect(managed.outputRecoveryGaveUp).toBe(true);
    expect(recovery.maybeProbe("t1", managed, now * 10)).toBe(false);
  });

  it("falls back to a generic error when the failure left none behind", async () => {
    const managed = addPane({ outputRecoveryFailures: OUTPUT_RECOVERY_MAX_FAILURES - 1 });
    recoverMissingOutput.mockRejectedValue(new Error("boom"));

    recovery.maybeProbe("t1", managed, 0);
    recovery.maybeProbe("t1", managed, OUTPUT_RECOVERY_GRACE_MS);
    await settle();

    expect(reportUnrecoverable).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ type: "error", message: "boom" })
    );
  });

  it("drops the outcome when the instance was replaced mid-probe", async () => {
    const managed = addPane({ outputRecoveryFailures: OUTPUT_RECOVERY_MAX_FAILURES - 1 });
    let resolve!: (outcome: MissingOutputRecoveryOutcome) => void;
    recoverMissingOutput.mockReturnValue(new Promise((r) => (resolve = r)));

    recovery.maybeProbe("t1", managed, 0);
    recovery.maybeProbe("t1", managed, OUTPUT_RECOVERY_GRACE_MS);
    instances.set("t1", {} as ManagedTerminal);
    resolve("failed");
    await settle();

    expect(reportUnrecoverable).not.toHaveBeenCalled();
    expect(managed.outputRecoveryInFlight).toBe(false);
  });
});
