// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";

const { cloud } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/components/Hosts/cloud/useCloudMachineActions", () => ({
  useCloudMachineActions: () => ({
    errorFor: () => null,
    isPending: () => false,
    start: vi.fn(),
    check: vi.fn(),
    requestStop: vi.fn(),
    dialogs: null,
  }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: { retryCreate: vi.fn(), setLifetime: vi.fn() },
}));

import { CloudMachineSection } from "../CloudMachineSection";

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: null,
    machineName: "build",
    ownership: "created-by-daintree",
    createdFor: null,
    machine: "not-created",
    rawState: null,
    machineType: "default",
    vcpu: null,
    memoryGB: null,
    hourlyDollars: null,
    autoStopAt: null,
    lifetimeSeconds: 7200,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: { id: "op", kind: "creating", startedAt: 0, stage: "Asking Boat for a machine" },
    lastError: null,
    observedAt: null,
    lastEndpoint: null,
    hostKeyFingerprint: null,
    keptRunningAt: null,
    ...overrides,
  };
}

function show(current: CloudHostStatus) {
  cloud.snapshot = { providers: [], accounts: [], hosts: [current] };
  return render(<CloudMachineSection hostId="build" hostName="build" />);
}

const createdFor = () => screen.queryByTestId("cloud-machine-created-for")?.textContent ?? null;

afterEach(cleanup);

describe("CloudMachineSection created-for row", () => {
  it("shows the worktree on this device while the machine is still being created", () => {
    show(
      status({
        createdFor: {
          hostId: null,
          projectId: "0f1e2d3c",
          worktreeId: "/Users/me/code/app-worktrees/feature-login",
          projectName: "app",
          worktreeName: "feature/login",
          hostName: null,
        },
      })
    );
    expect(createdFor()).toBe("feature/login in app");
  });

  it("names the host a remote worktree lives on", () => {
    show(
      status({
        resourceId: "bx_23456789",
        machine: "running",
        operation: null,
        createdFor: {
          hostId: "studio",
          projectId: "9a8b7c6d",
          worktreeId: "/home/me/api-worktrees/fix-auth",
          projectName: "api",
          worktreeName: "fix/auth",
          hostName: "Studio",
        },
      })
    );
    expect(createdFor()).toBe("fix/auth in api on Studio");
  });

  it("has no row for a machine made from Settings or imported", () => {
    show(status());
    expect(createdFor()).toBeNull();
    cleanup();
    show(status({ ownership: "imported", resourceId: "bx_23456789", operation: null }));
    expect(createdFor()).toBeNull();
    expect(screen.getByText(/Added from the account/)).toBeTruthy();
  });
});
