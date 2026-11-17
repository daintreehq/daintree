// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type {
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

const { cloud } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
}));
vi.mock("../cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: { stopHost: vi.fn(), startHost: vi.fn(), refreshHost: vi.fn() },
}));

import { useCloudMachineActions } from "../useCloudMachineActions";
import { BOAT_PROVIDER, provider } from "./cloudProviderFixtures";

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    machineName: "build",
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "renewable" },
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: Date.now(),
    lastEndpoint: null,
    hostKeyFingerprint: null,
    hostKeyReview: null,
    keptRunningAt: null,
    asleep: false,
    ...overrides,
  };
}

let actions: ReturnType<typeof useCloudMachineActions> | null = null;

function Harness() {
  actions = useCloudMachineActions();
  return <>{actions.dialogs}</>;
}

function show(current: CloudHostStatus, declared: CloudProviderInfo) {
  cloud.snapshot = {
    providers: [declared],
    accounts: [],
    hosts: [{ ...current, providerId: declared.id }],
  };
  render(<Harness />);
}

// Stop is destructive (an alertdialog); Start is a plain dialog.
const dialogText = () =>
  (screen.queryByRole("alertdialog") ?? screen.getByRole("dialog")).textContent ?? "";

afterEach(() => {
  cleanup();
  actions = null;
});

describe("useCloudMachineActions confirms by what the provider declares (#17346)", () => {
  it("keeps Boat's Stop confirm word for word", () => {
    show(status(), BOAT_PROVIDER);
    act(() => actions!.requestStop("build", "build"));
    expect(dialogText()).toContain(
      "Terminals, agents and anything else running on it end, and billing for its compute stops. Files in its home folder are kept for at least 14 days while it's stopped, and may be deleted after that; /tmp, caches and memory aren't."
    );
  });

  it("never says a stop ends billing where the stopped machine still bills", () => {
    show(status(), provider({ stoppedComputeBilled: true, deletion: true }));
    act(() => actions!.requestStop("build", "build"));
    expect(dialogText()).not.toContain("billing for its compute stops");
    expect(dialogText()).toContain(
      "Terminals, agents and anything else running on it end. Acme keeps billing a stopped machine for compute until it's deleted. To stop paying for it, remove the host and delete its machine. Files on its disk are kept for when you start it again; caches and memory aren't."
    );
  });

  it("says a stopped machine bills only for its disk where the provider declares it", () => {
    show(status(), provider({ stoppedComputeBilled: false, stoppedStorageBilled: true }));
    act(() => actions!.requestStop("build", "build"));
    expect(dialogText()).not.toContain("billing for the machine stops");
    expect(dialogText()).toContain(
      "Terminals, agents and anything else running on it end. Acme bills only for its disk while it's stopped. Files on its disk are kept for when you start it again; caches and memory aren't."
    );
  });

  it("points to the console from the Stop confirm when Daintree can't delete there", () => {
    show(status(), provider({ stoppedComputeBilled: true, deletion: false }));
    act(() => actions!.requestStop("build", "build"));
    expect(dialogText()).toContain("To stop paying for it, delete the machine in Acme's console.");
  });

  it("keeps Boat's Start confirm, and says a stopped machine already bills where it does", () => {
    show(status({ machine: "stopped" }), BOAT_PROVIDER);
    act(() => actions!.confirmStart({ hostId: "build", name: "build" }));
    expect(dialogText()).toContain(
      "build's machine is stopped. Starting it bills Personal about $0.036 an hour while it runs."
    );
    cleanup();

    show(status({ machine: "stopped" }), provider({ stoppedComputeBilled: true, deletion: true }));
    act(() => actions!.confirmStart({ hostId: "build", name: "build" }));
    expect(dialogText()).not.toContain("Starting it bills");
    expect(dialogText()).toContain(
      "build's machine is stopped. It bills Personal about $0.036 an hour while it runs. Acme keeps billing a stopped machine for compute until it's deleted."
    );
  });
});

describe("useCloudMachineActions for a machine that sleeps when idle (#17347)", () => {
  const sleeper = provider({
    name: "Agent 37",
    stoppedComputeBilled: false,
    stoppedStorageBilled: true,
    lifetime: { kind: "idle-sleep", idleSeconds: 900 },
  });

  it("says Stop cuts the bill to the disk, never that it ends it", () => {
    show(status({ lifetime: sleeper.capabilities.lifetime }), sleeper);
    act(() => actions!.requestStop("build", "build"));
    expect(dialogText()).not.toContain("billing for the machine stops");
    expect(dialogText()).toContain(
      "Terminals, agents and anything else running on it end. Agent 37 bills only for its disk while it's stopped or asleep."
    );
  });

  it("asks to start an asleep machine in its own words, with when it sleeps again", () => {
    show(
      status({
        machine: "stopped",
        asleep: true,
        rawState: "sleeping",
        lifetime: sleeper.capabilities.lifetime,
        lifetimeSeconds: null,
      }),
      sleeper
    );
    act(() => actions!.confirmStart({ hostId: "build", name: "build" }));
    expect(dialogText()).toContain(
      "build's machine is asleep. It bills Personal about $0.036 an hour while it runs. Agent 37 bills only for its disk while it's stopped or asleep. It sleeps by itself after 15 minutes without activity."
    );
  });
});
