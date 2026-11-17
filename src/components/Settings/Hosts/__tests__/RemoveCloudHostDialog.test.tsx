// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudHostCreatedFor, CloudHostStatus } from "@shared/types/cloudHosts";

const { cloudClient, remoteClient } = vi.hoisted(() => ({
  cloudClient: { deleteMachine: vi.fn() },
  remoteClient: { forget: vi.fn() },
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: cloudClient }));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: remoteClient }));

import { RemoveCloudHostDialog } from "../RemoveCloudHostDialog";

const MARK: CloudHostCreatedFor = {
  hostId: null,
  projectId: "0f1e2d3c",
  worktreeId: "/Users/me/code/app-worktrees/feature-login",
  projectName: "app",
  worktreeName: "feature/login",
  hostName: null,
};

function status(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
  return {
    hostId: "build",
    providerId: "boat",
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    machineName: "feature-login-box",
    ownership: "created-by-daintree",
    createdFor: MARK,
    machine: "stopped",
    rawState: "archived",
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
    observedAt: Date.now(),
    lastEndpoint: null,
    hostKeyFingerprint: null,
    keptRunningAt: null,
    ...overrides,
  };
}

function open(current: CloudHostStatus) {
  return render(
    <RemoveCloudHostDialog
      hostId="build"
      name="Login box"
      status={current}
      providerName="Boat"
      onClose={() => {}}
    />
  );
}

const dialogText = () => screen.getByRole("alertdialog").textContent ?? "";

beforeEach(() => {
  cloudClient.deleteMachine.mockResolvedValue(undefined);
  remoteClient.forget.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RemoveCloudHostDialog for a machine made for a worktree", () => {
  it("names the machine that stays in the provider's account, not the host", async () => {
    open(status());
    expect(dialogText()).toContain(
      "its machine 'feature-login-box' still exists in your Boat account (Personal)"
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("names it by its id when the provider never reported a name", () => {
    open(status({ machineName: null, machine: "running" }));
    expect(dialogText()).toContain("its machine 'bx_23456789' still exists in your Boat account");
  });

  it("drops the sentence once deleting the machine is chosen", () => {
    open(status());
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine too/ }));
    expect(dialogText()).not.toContain("still exists");
    expect(dialogText()).toContain("deleted from Boat");
  });

  it("says only that removing the host doesn't delete a machine it can't see", () => {
    // A 404 on refresh leaves the machine unknown: it may have been deleted on the provider.
    open(status({ machine: "unknown", lastError: { code: "not-found", message: "gone", at: 0 } }));
    expect(dialogText()).toContain(
      "removing it doesn't delete its machine 'feature-login-box' from your Boat account (Personal)"
    );
    expect(dialogText()).not.toContain("still exists");
  });

  it("qualifies an old reading the same way", () => {
    open(status({ machine: "running", observedAt: 0 }));
    expect(dialogText()).toContain("removing it doesn't delete its machine 'feature-login-box'");
    expect(dialogText()).not.toContain("still exists");
  });

  it("doesn't claim a machine the provider reported deleted still exists", () => {
    open(status({ machine: "deleted" }));
    expect(dialogText()).not.toContain("still exists");
  });
});

describe("RemoveCloudHostDialog for any other machine", () => {
  it("says only that the host leaves the list for an unmarked machine", () => {
    open(status({ createdFor: null }));
    expect(dialogText()).toContain("The host leaves your list.");
    expect(dialogText()).not.toContain("still exists");
  });

  it("says nothing of a machine that was never created", () => {
    open(status({ resourceId: null, machine: "not-created" }));
    expect(dialogText()).toContain("No machine was created for it.");
    expect(dialogText()).not.toContain("still exists");
  });
});
