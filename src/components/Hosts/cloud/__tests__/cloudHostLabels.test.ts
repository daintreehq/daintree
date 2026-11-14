import { describe, expect, it } from "vitest";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import {
  canCheckMachine,
  canStartMachine,
  canStopMachine,
  cloudChipStatus,
  cloudStatusLabel,
  isObservationStale,
  formatHourly,
  lifetimeSentence,
  machineSpecLabel,
} from "../cloudHostLabels";

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    ownership: "created-by-daintree",
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: 0,
    lastEndpoint: null,
    hostKeyFingerprint: null,
    keptRunningAt: null,
    ...overrides,
  };
}

describe("cloud host labels", () => {
  it("says what Daintree is doing before what the provider reports", () => {
    expect(
      cloudStatusLabel(
        status({
          machine: "stopped",
          operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
        })
      )
    ).toBe("Machine starting");
    expect(
      cloudStatusLabel(
        status({
          operation: { id: "o", kind: "stopping", startedAt: 0, stage: "" },
          stop: { status: "failing", error: "disk" },
        })
      )
    ).toBe("Machine stopping, retrying the save");
    expect(cloudStatusLabel(status({ machine: "stopped" }))).toBe("Machine stopped");
  });

  it("tells an unfinished create from a host never created", () => {
    expect(cloudStatusLabel(status({ resourceId: null, machine: "not-created" }))).toBe(
      "Not created"
    );
    expect(
      cloudStatusLabel(
        status({
          resourceId: null,
          machine: "not-created",
          lastError: { code: "outcome-unknown", message: "lost", at: 0 },
        })
      )
    ).toBe("Setup incomplete");
  });

  it("offers Start only for a stopped machine with data, and Stop only for a running one", () => {
    expect(canStartMachine(status({ machine: "stopped" }))).toBe(true);
    expect(canStartMachine(status({ machine: "stopped", dataExpired: true }))).toBe(false);
    expect(canStartMachine(status({ machine: "running" }))).toBe(false);
    expect(
      canStartMachine(
        status({
          machine: "stopped",
          operation: { id: "o", kind: "deleting", startedAt: 0, stage: "" },
        })
      )
    ).toBe(false);
    expect(canStopMachine(status({ machine: "running" }))).toBe(true);
    expect(
      canStopMachine(
        status({
          machine: "starting",
          operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
        })
      )
    ).toBe(true);
    expect(canStopMachine(status({ machine: "stopped" }))).toBe(false);
    expect(canStopMachine(status({ resourceId: null, machine: "not-created" }))).toBe(false);
  });

  it("says an imported lifetime exactly, never rounded to the hour", () => {
    expect(lifetimeSentence(1800)).toContain("30 minutes after starting");
    expect(lifetimeSentence(5400)).toContain("90 minutes after starting");
    expect(lifetimeSentence(7200)).toContain("2 hours after starting");
    expect(lifetimeSentence(null)).toBe("It runs until you stop it.");
  });

  it("never reads an unknown state as stopped", () => {
    const unknown = status({ machine: "unknown" });
    expect(cloudStatusLabel(unknown)).toBe("Couldn't check the machine");
    expect(canStartMachine(unknown)).toBe(false);
    expect(canStopMachine(unknown)).toBe(false);
    expect(canCheckMachine(unknown, 0)).toBe(true);
    // The chip never truncates its status, so the long ones have short forms.
    expect(cloudChipStatus(unknown)).toBe("state unknown");
    expect(
      cloudChipStatus(
        status({
          operation: { id: "o", kind: "stopping", startedAt: 0, stage: "" },
          stop: { status: "failing", error: "disk" },
        })
      )
    ).toBe("machine stopping");
  });

  it("marks a reading past its freshness as the last one", () => {
    const minute = 60_000;
    const stopped = status({ machine: "stopped", observedAt: 0 });
    expect(isObservationStale(stopped, 10 * minute)).toBe(false);
    expect(isObservationStale(stopped, 13 * minute)).toBe(true);
    expect(cloudStatusLabel(stopped, true)).toBe("Last reported stopped");
    expect(canCheckMachine(stopped, 13 * minute)).toBe(true);

    const running = status({ machine: "running", observedAt: 0 });
    expect(isObservationStale(running, 2 * minute)).toBe(false);
    expect(isObservationStale(running, 4 * minute)).toBe(true);
    // Under way, Daintree is polling every few seconds: never stale, never "last reported".
    const starting = status({
      machine: "stopped",
      observedAt: 0,
      operation: { id: "o", kind: "starting", startedAt: 0, stage: "" },
    });
    expect(isObservationStale(starting, 60 * minute)).toBe(false);
    expect(cloudStatusLabel(starting, true)).toBe("Machine starting");
    expect(isObservationStale(status({ observedAt: null }), 0)).toBe(true);
    expect(isObservationStale(status({ resourceId: null, observedAt: null }), 0)).toBe(false);
  });

  it("formats what is known of a size and its price", () => {
    expect(machineSpecLabel(4, 8)).toBe("4 vCPU · 8 GB");
    expect(machineSpecLabel(null, null)).toBe("Size unknown");
    expect(formatHourly(0.0361)).toBe("$0.036 an hour while running");
    expect(formatHourly(null)).toBe("Price not reported");
  });
});
