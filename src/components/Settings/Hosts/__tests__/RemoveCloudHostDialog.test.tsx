// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudHostCreatedFor,
  CloudHostStatus,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

const { cloudClient, remoteClient, system } = vi.hoisted(() => ({
  cloudClient: { deleteMachine: vi.fn() },
  remoteClient: { forget: vi.fn() },
  system: { openExternal: vi.fn() },
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: cloudClient }));
vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: remoteClient }));
vi.mock("@/clients/systemClient", () => ({ systemClient: system }));

import { RemoveCloudHostDialog } from "../RemoveCloudHostDialog";
import {
  BOAT_PROVIDER,
  provider as providerWith,
} from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

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
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: "bx_23456789",
    machineName: "feature-login-box",
    ownership: "created-by-daintree",
    createdFor: MARK,
    worktreeCleanup: null,
    provisioning: null,
    machine: "stopped",
    rawState: "archived",
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

function open(current: CloudHostStatus, provider: CloudProviderInfo = BOAT_PROVIDER) {
  return render(
    <RemoveCloudHostDialog
      hostId="build"
      name="Login box"
      status={current}
      providerName={provider.name}
      provider={provider}
      onClose={() => {}}
    />
  );
}

const dialogText = () => screen.getByRole("alertdialog").textContent ?? "";

beforeEach(() => {
  cloudClient.deleteMachine.mockResolvedValue(undefined);
  remoteClient.forget.mockResolvedValue(undefined);
  system.openExternal.mockResolvedValue(undefined);
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

  it("qualifies an old reading the same way, even while an operation waits on it", () => {
    for (const operation of [
      null,
      { id: "op", kind: "starting" as const, startedAt: 0, stage: "Starting the machine" },
    ]) {
      open(status({ machine: "starting", observedAt: 0, operation }));
      expect(dialogText()).toContain("removing it doesn't delete its machine 'feature-login-box'");
      expect(dialogText()).not.toContain("still exists");
      cleanup();
    }
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

describe("RemoveCloudHostDialog by what the provider declares (#17346)", () => {
  const typedName = () => screen.queryByRole("textbox");

  it("keeps Boat's keep and delete choices and their words", () => {
    open(status({ createdFor: null }));
    expect(screen.getByRole("radio", { name: /Keep it on Boat/ })).toBeTruthy();
    expect(dialogText()).toContain(
      "It stays stopped in your account. You can add it back from Add host."
    );
    fireEvent.click(screen.getByRole("radio", { name: /Delete the machine too/ }));
    expect(screen.getByRole("button", { name: "Delete machine" })).toBeTruthy();
    expect(typedName()).not.toBeNull();
    expect(screen.queryByTestId("remove-cloud-host-console")).toBeNull();
  });

  it("says a kept machine keeps billing until it's deleted when its provider bills it stopped", () => {
    const billed = providerWith({ stoppedComputeBilled: true, deletion: true });
    open(status({ createdFor: null }), billed);
    expect(dialogText()).toContain(
      "It stays stopped in your account and keeps billing Personal until it's deleted."
    );
    cleanup();
    open(status({ createdFor: null, machine: "running" }), billed);
    expect(dialogText()).toContain(
      "It's running and keeps billing Personal until it's deleted, even once it stops."
    );
    expect(screen.getByRole("radio", { name: /Delete the machine too/ })).toBeTruthy();
  });

  it("says a kept machine's disk keeps billing where its provider bills storage alone (#17347)", () => {
    const sleeper = providerWith({
      stoppedComputeBilled: false,
      stoppedStorageBilled: true,
      deletion: true,
      lifetime: { kind: "idle-sleep", idleSeconds: 900 },
    });
    open(status({ createdFor: null, rawState: "stopped" }), sleeper);
    expect(dialogText()).toContain(
      "It stays stopped in your account, where its disk keeps billing Personal until it's deleted. You can add it back from Add host."
    );
    cleanup();
    open(status({ createdFor: null, asleep: true, rawState: "sleeping" }), sleeper);
    expect(dialogText()).toContain(
      "It stays asleep in your account, where its disk keeps billing Personal until it's deleted."
    );
    cleanup();
    // Running, compute ends with the stop, and the disk bills on after it.
    open(status({ createdFor: null, machine: "running", rawState: "running" }), sleeper);
    expect(dialogText()).toContain(
      "It's running and keeps billing Personal until it stops on Acme, and for its disk after that until it's deleted."
    );
    cleanup();
    open(status({ createdFor: null, machine: "unknown", rawState: "?" }), sleeper);
    expect(dialogText()).toContain("and for its disk until it's deleted");
  });

  it("offers no Delete for a provider that can't delete, and only forgets the host", async () => {
    const consoleOnly = providerWith({ stoppedComputeBilled: true, deletion: false });
    open(status({ createdFor: null }), consoleOnly);
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete machine" })).toBeNull();
    expect(typedName()).toBeNull();
    expect(dialogText()).toContain("Remove 'Login box'?");
    expect(dialogText()).not.toContain("Delete 'Login box'?");
    expect(dialogText()).toContain("its machine stays in your Acme account");
    expect(dialogText()).toContain("keeps billing Personal until it's deleted");
    expect(dialogText()).toContain(
      "Daintree can't delete machines on Acme. To delete it and stop paying for it, use Acme's console."
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Acme console" }));
    expect(system.openExternal).toHaveBeenCalledWith(consoleOnly.dashboardUrl);

    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("forgets a host whose create never answered, pointing to the console instead", async () => {
    const consoleOnly = providerWith({ stoppedComputeBilled: false, deletion: false });
    open(
      status({
        resourceId: null,
        machine: "not-created",
        lastError: { code: "outcome-unknown", message: "No answer", at: 0 },
      }),
      consoleOnly
    );
    expect(typedName()).toBeNull();
    expect(dialogText()).toContain(
      "Acme hasn't confirmed whether it made a machine for it, and removing the host doesn't delete one."
    );
    expect(screen.getByRole("button", { name: "Open Acme console" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("needs no console for a host that never had a machine", async () => {
    open(status({ resourceId: null, machine: "not-created" }), providerWith({ deletion: false }));
    expect(dialogText()).toContain("No machine was created for it.");
    expect(screen.queryByTestId("remove-cloud-host-console")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });
});

describe("RemoveCloudHostDialog for a provider without deletion, as its machine changes (#17346)", () => {
  const consoleOnly = providerWith({ stoppedComputeBilled: true, deletion: false });

  function openWith(
    current: CloudHostStatus,
    declared: CloudProviderInfo | null,
    providerName = "Acme"
  ) {
    return render(
      <RemoveCloudHostDialog
        hostId="build"
        name="Login box"
        status={current}
        providerName={providerName}
        provider={declared}
        onClose={() => {}}
      />
    );
  }

  it("keeps the console when a create lands while it is open", async () => {
    const creating = status({
      createdFor: null,
      resourceId: null,
      machine: "not-created",
      operation: { id: "op", kind: "creating", startedAt: 0, stage: "Asking Acme" },
    });
    const view = openWith(creating, consoleOnly);
    view.rerender(
      <RemoveCloudHostDialog
        hostId="build"
        name="Login box"
        status={status({ createdFor: null, machine: "running" })}
        providerName="Acme"
        provider={consoleOnly}
        onClose={() => {}}
      />
    );
    expect(dialogText()).not.toContain("No machine was created for it.");
    expect(dialogText()).toContain("Acme made a machine for it while this was open");
    expect(screen.getByRole("button", { name: "Open Acme console" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("claims no machine the provider reported deleted, and offers no console for it", () => {
    openWith(status({ createdFor: null, machine: "deleted" }), consoleOnly);
    expect(dialogText()).not.toContain("stays in your Acme account");
    expect(dialogText()).not.toContain("keeps billing");
    expect(screen.queryByTestId("remove-cloud-host-console")).toBeNull();
  });

  it("only says removing doesn't delete a machine it last saw long ago", () => {
    openWith(status({ createdFor: null, observedAt: 0 }), consoleOnly);
    expect(dialogText()).toContain("removing it doesn't delete its machine from your Acme account");
    expect(dialogText()).not.toContain("stays in your Acme account");
  });

  it("takes Delete away when the provider registers as unable to delete", async () => {
    const view = openWith(status({ createdFor: null }), null, "the provider");
    expect(screen.getByRole("radio", { name: /Delete the machine too/ })).toBeTruthy();
    view.rerender(
      <RemoveCloudHostDialog
        hostId="build"
        name="Login box"
        status={status({ createdFor: null })}
        providerName="Acme"
        provider={consoleOnly}
        onClose={() => {}}
      />
    );
    expect(screen.queryByRole("radio")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("forgets an unanswered create's host once its provider registers as unable to delete", async () => {
    const creating = status({
      createdFor: null,
      resourceId: null,
      machine: "not-created",
      operation: { id: "op", kind: "creating", startedAt: 0, stage: "Asking Acme" },
    });
    const view = openWith(creating, null, "the provider");
    // Opened able to delete: an unanswered create goes the delete way.
    expect(screen.getByRole("button", { name: "Delete machine" })).toBeTruthy();
    view.rerender(
      <RemoveCloudHostDialog
        hostId="build"
        name="Login box"
        status={creating}
        providerName="Acme"
        provider={consoleOnly}
        onClose={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove host" }));
    await waitFor(() => expect(remoteClient.forget).toHaveBeenCalledWith("build"));
    expect(cloudClient.deleteMachine).not.toHaveBeenCalled();
  });

  it("still says a kept machine bills when its saved disk has expired", () => {
    openWith(
      status({ createdFor: null, dataExpired: true }),
      providerWith({ stoppedComputeBilled: true, deletion: true })
    );
    expect(dialogText()).toContain(
      "Acme has deleted its saved disk. It keeps billing Personal until it's deleted."
    );
  });
});
