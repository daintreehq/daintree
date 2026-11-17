// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

const { cloud, trustHostKey, connect } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  trustHostKey: vi.fn(),
  connect: vi.fn(),
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
  cloudHostsClient: { retryCreate: vi.fn(), setLifetime: vi.fn(), trustHostKey },
}));
vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: { connect },
}));

import { CloudMachineSection } from "../CloudMachineSection";
import { BOAT_PROVIDER, provider } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

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
    provisioning: null,
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
    hostKeyReview: null,
    keptRunningAt: null,
    ...overrides,
  };
}

function show(current: CloudHostStatus) {
  cloud.snapshot = { providers: [], accounts: [], hosts: [current] };
  return render(
    <CloudMachineSection hostId="build" hostName="build" connected={false} liveSummary={null} />
  );
}

const createdFor = () => screen.queryByTestId("cloud-machine-created-for")?.textContent ?? null;

afterEach(() => {
  cleanup();
  trustHostKey.mockReset();
  connect.mockReset();
});

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

describe("CloudMachineSection provisioning rows", () => {
  it("shows where the machine runs and what it boots, as named at create, with its provider gone", () => {
    show(
      status({
        providerId: "acme.clouds.ec2",
        provisioning: {
          location: { label: "Region", id: "eu-west-1", value: "Europe (Ireland)" },
          image: { label: "AMI", id: "ami-0abc", value: "Ubuntu 24.04" },
          network: { label: "Subnet", id: null, value: "Chosen by Acme" },
        },
      })
    );
    expect(screen.getByTestId("cloud-machine-location").textContent).toBe(
      "Europe (Ireland) · eu-west-1"
    );
    expect(screen.getByTestId("cloud-machine-image").textContent).toBe("Ubuntu 24.04 · ami-0abc");
    expect(screen.getByTestId("cloud-machine-network").textContent).toBe("Chosen by Acme");
    // The provider's own names for them, kept with the machine.
    expect(screen.getByText("Region")).toBeTruthy();
    expect(screen.getByText("AMI")).toBeTruthy();
    expect(screen.getByText("Subnet")).toBeTruthy();
  });

  it("names a choice once when its id is its name, and only the dimensions it was given", () => {
    show(
      status({
        provisioning: {
          location: { label: "Zone", id: "us-central1-a", value: "us-central1-a" },
          image: null,
          network: null,
        },
      })
    );
    expect(screen.getByTestId("cloud-machine-location").textContent).toBe("us-central1-a");
    expect(screen.getByText("Zone")).toBeTruthy();
    expect(screen.queryByTestId("cloud-machine-image")).toBeNull();
    expect(screen.queryByTestId("cloud-machine-network")).toBeNull();
  });

  it("has no rows for a machine that named none", () => {
    show(status());
    expect(screen.queryByTestId("cloud-machine-location")).toBeNull();
    expect(screen.queryByTestId("cloud-machine-image")).toBeNull();
    expect(screen.queryByTestId("cloud-machine-network")).toBeNull();
  });
});

describe("CloudMachineSection stopped billing (#17346)", () => {
  const billing = () => screen.queryByTestId("cloud-machine-stopped-billing")?.textContent ?? null;
  const stopped = status({
    resourceId: "bx_23456789",
    machine: "stopped",
    operation: null,
    hourlyDollars: 0.036,
    observedAt: Date.now(),
  });

  function showWith(current: CloudHostStatus, declared: CloudProviderInfo) {
    cloud.snapshot = {
      providers: [declared],
      accounts: [],
      hosts: [{ ...current, providerId: declared.id }],
    };
    return render(
      <CloudMachineSection hostId="build" hostName="build" connected={false} liveSummary={null} />
    );
  }

  it("says nothing more for Boat, whose stop ends the bill", () => {
    showWith(stopped, BOAT_PROVIDER);
    expect(billing()).toBeNull();
    expect(screen.getByTestId("cloud-machine-state").textContent).toContain(
      "Stopped · $0.036/h when started"
    );
  });

  it("says a stopped machine still bills, beside it and beside Stop", () => {
    const billed = provider({ stoppedComputeBilled: true, deletion: true });
    showWith(stopped, billed);
    expect(screen.getByTestId("cloud-machine-state").textContent).toContain(
      "Stopped · still billing"
    );
    expect(billing()).toContain("To stop paying for it, remove the host and delete its machine.");
    cleanup();
    showWith(status({ resourceId: "bx_23456789", machine: "running", operation: null }), billed);
    expect(billing()).toContain("Acme keeps billing a stopped machine for compute");
  });
});

describe("CloudMachineSection host key review", () => {
  const running = {
    resourceId: "dr_1234",
    machine: "running" as const,
    operation: null,
    observedAt: Date.now(),
  };
  const review = () => screen.queryByTestId("cloud-host-key-review")?.textContent ?? null;

  it("shows nothing to review for a machine whose key is pinned", () => {
    show(status({ ...running, hostKeyFingerprint: "SHA256:old" }));
    expect(review()).toBeNull();
    expect(screen.queryByRole("button", { name: /trust/i })).toBeNull();
  });

  it("shows a first key's fingerprint and trusts exactly that one before dialling", async () => {
    trustHostKey.mockResolvedValue(undefined);
    connect.mockResolvedValue(undefined);
    show(
      status({
        ...running,
        hostKeyReview: {
          reason: "first-connect",
          fingerprint: "SHA256:first",
          keyType: "ED25519",
          seenAt: 1,
          previousFingerprint: null,
          previousTrustedAt: null,
        },
      })
    );
    expect(review()).toContain("ED25519 SHA256:first");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
    });
    expect(trustHostKey).toHaveBeenCalledWith("build", "SHA256:first");
    expect(connect).toHaveBeenCalledWith("build");
  });

  it("warns that a changed key is a new identity and shows both fingerprints", () => {
    show(
      status({
        ...running,
        hostKeyFingerprint: "SHA256:old",
        hostKeyReview: {
          reason: "changed",
          fingerprint: "SHA256:new",
          keyType: "ECDSA",
          seenAt: 2,
          previousFingerprint: "SHA256:old",
          previousTrustedAt: 1,
        },
      })
    );
    expect(review()).toMatch(/identity changed/i);
    expect(review()).toContain("Trusted SHA256:old");
    expect(review()).toContain("Now ECDSA SHA256:new");
    expect(screen.getByRole("button", { name: "Trust new key" })).toBeTruthy();
  });

  it("says why a trust was refused and doesn't dial", async () => {
    trustHostKey.mockRejectedValue(
      Object.assign(new Error("changed"), {
        name: "AppError",
        code: "VALIDATION",
        userMessage: "The machine's host key changed again since it was shown.",
      })
    );
    show(
      status({
        ...running,
        hostKeyReview: {
          reason: "first-connect",
          fingerprint: "SHA256:first",
          keyType: "ED25519",
          seenAt: 1,
          previousFingerprint: null,
          previousTrustedAt: null,
        },
      })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "The machine's host key changed again since it was shown."
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
