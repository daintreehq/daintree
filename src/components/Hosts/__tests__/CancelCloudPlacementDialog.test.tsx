// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { CloudHostStatus, CloudProviderInfo } from "@shared/types/cloudHosts";

vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: { deleteMachine: vi.fn(async () => {}) },
}));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));
vi.mock("../pendingPlacement", () => ({
  cancelPlacement: vi.fn(async () => {}),
  holdHostSetup: () => () => {},
}));
vi.mock("../cloudWorktreePlacement", () => ({ disarmCloudSetup: vi.fn() }));

import { CancelCloudPlacementDialog } from "../CancelCloudPlacementDialog";
import { BOAT_PROVIDER, DELETE_ONLY_PROVIDER } from "../cloud/__tests__/cloudProviderFixtures";

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "login-host",
    providerId: DELETE_ONLY_PROVIDER.id,
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "lease-1",
    machineName: "login-box",
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "active",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "none" },
    autoStopAt: null,
    lifetimeSeconds: null,
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

function open(current: CloudHostStatus, provider: CloudProviderInfo) {
  render(
    <CancelCloudPlacementDialog
      hostId="login-host"
      hostName="Login box"
      label="feature/login"
      status={current}
      provider={provider}
      initialChoice="keep"
      madeForIt
      onClose={() => {}}
    />
  );
  return screen.getByTestId("cancel-cloud-placement-choice").textContent ?? "";
}

afterEach(cleanup);

describe("CancelCloudPlacementDialog for a machine whose provider has no stop (#18229)", () => {
  it("says a kept machine bills until it's deleted, made or still being made", () => {
    expect(open(status(), DELETE_ONLY_PROVIDER)).toContain(
      "It stays in your host list, marked as made for feature/login, and bills Personal until it's deleted."
    );
    cleanup();
    expect(open(status({ resourceId: null }), DELETE_ONLY_PROVIDER)).toContain(
      "A machine its create makes bills Personal until it's deleted."
    );
  });

  it("keeps every other provider's words", () => {
    expect(open({ ...status(), providerId: "boat" }, BOAT_PROVIDER)).toContain(
      "It stays in your host list, marked as made for feature/login, and bills Personal while it runs."
    );
  });
});
