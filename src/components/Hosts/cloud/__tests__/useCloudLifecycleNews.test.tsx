// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { CloudHostStatus } from "@shared/types/cloudHosts";
import { useCloudLifecycleNews } from "../useCloudLifecycleNews";

function status(machine: CloudHostStatus["machine"]): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    ownership: "created-by-daintree",
    machine,
    rawState: null,
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
  };
}

const nameOf = () => "boat-e2e";

describe("useCloudLifecycleNews", () => {
  it("says a state change once, from the newest surface only, and never the first sight", () => {
    const chip = renderHook(({ hosts }) => useCloudLifecycleNews(hosts, nameOf), {
      initialProps: { hosts: [status("stopped")] },
    });
    expect(chip.result.current).toBe("");

    const settings = renderHook(({ hosts }) => useCloudLifecycleNews(hosts, nameOf), {
      initialProps: { hosts: [status("stopped")] },
    });
    const running = [status("running")];
    act(() => {
      chip.rerender({ hosts: running });
      settings.rerender({ hosts: running });
    });
    expect(settings.result.current).toBe("boat-e2e: machine running");
    expect(chip.result.current).toBe("");

    // Settings closes: the chip speaks again, but only of what happens next.
    settings.unmount();
    chip.rerender({ hosts: running });
    expect(chip.result.current).toBe("");
    act(() => chip.rerender({ hosts: [status("stopped")] }));
    expect(chip.result.current).toBe("boat-e2e: machine stopped");
    chip.unmount();
  });
});
