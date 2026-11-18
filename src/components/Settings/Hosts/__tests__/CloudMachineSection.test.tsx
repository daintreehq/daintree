// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudLifetimeModel,
  CloudProviderInfo,
  CloudSshTrust,
} from "@shared/types/cloudHosts";

const { cloud, trustHostKey, connect, retryWorktreeCleanup, dismissWorktreeCleanup } = vi.hoisted(
  () => ({
    cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
    trustHostKey: vi.fn(),
    connect: vi.fn(),
    retryWorktreeCleanup: vi.fn(async () => {}),
    dismissWorktreeCleanup: vi.fn(async () => {}),
  })
);
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
  cloudHostsClient: {
    retryCreate: vi.fn(),
    setLifetime: vi.fn(),
    trustHostKey,
    retryWorktreeCleanup,
    dismissWorktreeCleanup,
  },
}));
vi.mock("@/clients/remoteHostsClient", () => ({
  remoteHostsClient: { connect },
}));
const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}) }));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal } }));

import { CloudMachineSection } from "../CloudMachineSection";
import { cloudHostsClient } from "@/clients/cloudHostsClient";
import { BOAT_PROVIDER, provider } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";
import { clockTime } from "@/components/Hosts/cloud/cloudHostLabels";
import { ClientAppError } from "@/utils/clientAppError";

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
    worktreeCleanup: null,
    provisioning: null,
    machine: "not-created",
    rawState: null,
    machineType: "default",
    vcpu: null,
    memoryGB: null,
    hourlyDollars: null,
    lifetime: { kind: "renewable" },
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
    asleep: false,
    ...overrides,
  };
}

/** A provider reached through its own CLI, or directly; its machines' identity as `sshTrust` says. */
function tunnelProvider(
  sshTrust: CloudSshTrust,
  tunnelled: boolean,
  id = "boat",
  name = "Acme"
): CloudProviderInfo {
  const command = name.toLowerCase();
  return {
    ...BOAT_PROVIDER,
    id,
    name,
    capabilities: {
      ...BOAT_PROVIDER.capabilities,
      sshTrust,
      transport: tunnelled ? "provider-command" : "direct",
      tunnel: tunnelled
        ? { command, args: ["tunnel", "%h"], installUrl: `https://${command}.test/cli` }
        : null,
    },
  };
}

function show(current: CloudHostStatus, providers: CloudProviderInfo[] = []) {
  cloud.snapshot = { providers, accounts: [], hosts: [current] };
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

  it("never shows one key's refusal under a different key", async () => {
    let reject!: (error: unknown) => void;
    trustHostKey.mockImplementation(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const offered = (fingerprint: string) =>
      status({
        ...running,
        hostKeyReview: {
          reason: "first-connect",
          fingerprint,
          keyType: "ED25519",
          seenAt: 1,
          previousFingerprint: null,
          previousTrustedAt: null,
        },
      });
    const view = show(offered("SHA256:first"));
    fireEvent.click(screen.getByRole("button", { name: "Trust this key" }));
    cloud.snapshot = { providers: [], accounts: [], hosts: [offered("SHA256:second")] };
    view.rerender(
      <CloudMachineSection hostId="build" hostName="build" connected={false} liveSummary={null} />
    );
    await act(async () => {
      reject(
        Object.assign(new Error("changed"), {
          name: "AppError",
          code: "VALIDATION",
          userMessage: "The machine's host key changed again since it was shown.",
        })
      );
    });
    expect(review()).toContain("SHA256:second");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("CloudMachineSection SSH identity", () => {
  const running = (overrides: Partial<CloudHostStatus> = {}) =>
    status({ resourceId: "bx_23456789", machine: "running", operation: null, ...overrides });
  const identity = () => screen.queryByTestId("cloud-machine-identity")?.textContent ?? null;

  it("says when the provider's tunnel, not a pinned key, vouches for the machine", () => {
    show(running({ lastEndpoint: "root@ab12cd34ef.acme.test" }), [
      tunnelProvider("provider-tunnel", true),
    ]);
    expect(identity()).toMatch(/^Vouched for by Acme's tunnel instead of a pinned host key/);
    expect(screen.getByText(/Tunnel acme tunnel %h/)).toBeTruthy();
  });

  it("adds nothing for a pinned key, through a tunnel or not", () => {
    show(running({ hostKeyFingerprint: "SHA256:abc" }), [tunnelProvider("pinned-from-api", false)]);
    expect(identity()).toBeNull();
    expect(screen.queryByText(/Tunnel /)).toBeNull();
    cleanup();
    show(running({ hostKeyFingerprint: "SHA256:abc" }), [tunnelProvider("pinned-from-api", true)]);
    expect(identity()).toBeNull();
    expect(screen.getByText(/Tunnel acme tunnel %h/)).toBeTruthy();
    expect(screen.getByText(/Host key SHA256:abc/)).toBeTruthy();
  });

  it("offers the missing command's page beside the error that names it", () => {
    const message = "Acme machines are reached through its acme command, which isn't installed.";
    show(running({ lastError: { code: "ssh-tunnel-command-missing", message, at: 1 } }), [
      tunnelProvider("provider-tunnel", true, "acme.clouds.other", "Other"),
      tunnelProvider("provider-tunnel", true),
    ]);
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.queryByRole("button", { name: "Get other" })).toBeNull();
    const get = screen.getByRole("button", { name: "Get acme" });
    // On the error's own line, not among the machine's controls.
    expect(screen.getByRole("alert").closest("[id]")?.contains(get)).toBe(true);
    fireEvent.click(get);
    expect(openExternal).toHaveBeenCalledWith("https://acme.test/cli");
  });

  it("offers no install page while the tunnel works or another error is shown", () => {
    show(running(), [tunnelProvider("provider-tunnel", true)]);
    expect(screen.queryByRole("button", { name: "Get acme" })).toBeNull();
    cleanup();
    // The missing-command error is still on file, but an operation's stage is what shows.
    show(
      running({
        lastError: { code: "ssh-tunnel-command-missing", message: "missing", at: 1 },
        operation: { id: "op", kind: "stopping", startedAt: 0, stage: "Stopping" },
      }),
      [tunnelProvider("provider-tunnel", true)]
    );
    expect(screen.getByTestId("cloud-machine-state").textContent).toContain("Stopping");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get acme" })).toBeNull();
    cleanup();
    show(
      running({ lastError: { code: "ssh-authorization", message: "SSH access failed", at: 1 } }),
      [tunnelProvider("provider-tunnel", true)]
    );
    expect(screen.getByRole("alert").textContent).toBe("SSH access failed");
    expect(screen.queryByRole("button", { name: "Get acme" })).toBeNull();
  });
});

describe("CloudMachineSection lifetime row", () => {
  const DEADLINE = new Date(Date.now() + 90 * 60_000).toISOString();
  const lifetimeText = () => screen.getByTestId("cloud-machine-lifetime").textContent ?? "";
  const lifetimeChoice = () => screen.queryByRole("combobox", { name: "Stops by itself after" });

  function machine(lifetime: CloudLifetimeModel | null, overrides: Partial<CloudHostStatus> = {}) {
    return status({
      lifetime,
      resourceId: "bx_23456789",
      machine: "running",
      operation: null,
      observedAt: Date.now(),
      autoStopAt: DEADLINE,
      ...overrides,
    });
  }

  it("says a machine with no provider lifetime runs until it's stopped, with nothing to choose", () => {
    show(machine({ kind: "none" }, { autoStopAt: null }));
    expect(lifetimeText()).toContain("it runs until you stop it");
    expect(lifetimeChoice()).toBeNull();
  });

  it("says the provider sleeps it when idle, with its idle time", () => {
    show(machine({ kind: "idle-sleep", idleSeconds: 1800 }, { autoStopAt: null }));
    expect(screen.getByText("Sleeps when idle")).toBeTruthy();
    expect(lifetimeText()).toContain("to sleep by itself after 30 minutes without activity");
    expect(lifetimeChoice()).toBeNull();
  });

  it("shows a fixed limit's deadline, and that it can't be extended while it runs", () => {
    show(machine({ kind: "fixed-at-create", canChangeWhileStopped: false }));
    const text = lifetimeText();
    expect(text).toContain(`2 hours. This run stops by itself ${clockTime(DEADLINE)}.`);
    expect(text).toContain("can't extend or change it");
    expect(text).not.toContain("pushed back");
    expect(lifetimeChoice()).toBeNull();
  });

  it("lets a reported deadline speak for a fixed limit none was asked for", () => {
    const fixed = { kind: "fixed-at-create", canChangeWhileStopped: false } as const;
    show(machine(fixed, { lifetimeSeconds: null }));
    expect(lifetimeText()).toMatch(/^This run stops by itself /);
    expect(lifetimeText()).not.toContain("Never");
    cleanup();
    show(machine(fixed, { lifetimeSeconds: 7200, autoStopAt: null }));
    expect(lifetimeText()).toContain("hasn't said when this run stops");
    cleanup();
    show(machine(fixed, { lifetimeSeconds: null, autoStopAt: null }));
    expect(lifetimeText()).toMatch(/^Never\. This run doesn't stop by itself\./);
  });

  it("lets a fixed limit change only while the machine is stopped, where the provider allows", () => {
    show(machine({ kind: "fixed-at-create", canChangeWhileStopped: true }));
    expect(lifetimeText()).toContain(`This run stops by itself ${clockTime(DEADLINE)}.`);
    expect(lifetimeText()).toContain("can't extend it while the machine runs");
    expect(lifetimeChoice()?.hasAttribute("disabled")).toBe(true);
    cleanup();
    show(
      machine(
        { kind: "fixed-at-create", canChangeWhileStopped: true },
        { machine: "stopped", autoStopAt: null }
      )
    );
    expect(lifetimeText()).toContain("applies the next time Daintree starts it");
    expect(lifetimeChoice()?.hasAttribute("disabled")).toBe(false);
  });

  it("keeps a renewable lifetime's choice and the keeper's promise", () => {
    show(machine({ kind: "renewable" }));
    expect(lifetimeChoice()?.hasAttribute("disabled")).toBe(false);
    expect(screen.getByText(/Daintree pushes it back while a window here shows it/)).toBeTruthy();
  });

  it("promises nothing while the provider isn't available", () => {
    show(machine(null, { providerUnavailable: "Its plugin isn't installed." }));
    expect(lifetimeText()).toContain("as last reported");
    expect(lifetimeText()).toContain("Unknown while boat isn't available");
    expect(lifetimeChoice()).toBeNull();
  });
});

describe("CloudMachineSection with its worktree's delete (#17360)", () => {
  const MARK = {
    hostId: null,
    projectId: "0f1e2d3c",
    worktreeId: "/Users/me/code/app-worktrees/feature-login",
    projectName: "app",
    worktreeName: "feature/login",
    hostName: null,
  };
  const notice = () => screen.queryByTestId("cloud-machine-cleanup");

  it("shows a failed delete with Retry, the provider's console and Keep", async () => {
    show(
      status({
        resourceId: "bx_23456789",
        machine: "running",
        operation: null,
        createdFor: MARK,
        worktreeCleanup: {
          choice: "delete",
          phase: "failed",
          worktreeHostId: null,
          error: { code: "failed", message: "Boat didn't answer.", at: 1 },
        },
      }),
      [BOAT_PROVIDER]
    );
    expect(notice()?.textContent).toContain("Couldn't delete it with 'feature/login'");
    expect(notice()?.textContent).toContain("Boat didn't answer.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryWorktreeCleanup).toHaveBeenCalledWith("build");
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Open Boat console/ }));
    expect(openExternal).toHaveBeenCalledWith(BOAT_PROVIDER.dashboardUrl);
    fireEvent.click(screen.getByRole("button", { name: "Keep machine" }));
    expect(dismissWorktreeCleanup).toHaveBeenCalledWith("build");
  });

  it("says a failed Retry in place", async () => {
    retryWorktreeCleanup.mockRejectedValueOnce(
      new ClientAppError("OUTCOME_UNKNOWN", "refused", "Boat refused it.")
    );
    show(
      status({
        resourceId: "bx_23456789",
        machine: "running",
        operation: null,
        createdFor: MARK,
        worktreeCleanup: {
          choice: "stop",
          phase: "failed",
          worktreeHostId: null,
          error: { code: "failed", message: "Boat didn't answer.", at: 1 },
        },
      }),
      [BOAT_PROVIDER]
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(notice()?.textContent).toMatch(/Couldn't stop/);
    expect(notice()?.textContent).toContain("Boat refused it.");
    expect(notice()?.textContent).not.toContain("Boat didn't answer.");
  });

  it("offers no Retry for a worktree elsewhere it never heard back about", () => {
    show(
      status({
        resourceId: "bx_23456789",
        machine: "running",
        operation: null,
        createdFor: { ...MARK, hostId: "devbox", hostName: "devbox" },
        worktreeCleanup: {
          choice: "delete",
          phase: "unconfirmed",
          worktreeHostId: "devbox",
          error: {
            code: "outcome-unknown",
            message: "Daintree quit before it heard whether the worktree was deleted.",
            at: 1,
          },
        },
      }),
      [BOAT_PROVIDER]
    );
    expect(notice()?.textContent).toContain("Not deleted with 'feature/login'");
    expect(notice()?.textContent).toContain("If it was, delete the machine here.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep machine" }));
    expect(dismissWorktreeCleanup).toHaveBeenCalledWith("build");
  });

  it("checks again only for a worktree on this device, and says when a provider holds it up", () => {
    const base = {
      resourceId: "bx_23456789",
      machine: "running" as const,
      operation: null,
      createdFor: MARK,
    };
    show(
      status({
        ...base,
        worktreeCleanup: { choice: "stop", phase: "waiting", worktreeHostId: null, error: null },
      }),
      [BOAT_PROVIDER]
    );
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(retryWorktreeCleanup).toHaveBeenCalledWith("build");
    cleanup();
    show(
      status({
        ...base,
        worktreeCleanup: {
          choice: "stop",
          phase: "waiting",
          worktreeHostId: "devbox",
          error: null,
        },
      }),
      [BOAT_PROVIDER]
    );
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    cleanup();
    show(
      status({
        ...base,
        worktreeCleanup: {
          choice: "delete",
          phase: "running",
          worktreeHostId: null,
          error: { code: "unsupported", message: "Its plugin is disabled", at: 1 },
        },
      }),
      [BOAT_PROVIDER]
    );
    expect(notice()?.textContent).toBe("It will be deleted once Boat is available again.");
  });

  it("says what's still to come while it waits or runs, and nothing for a machine with none", () => {
    const base = { resourceId: "bx_23456789", machine: "running" as const, operation: null };
    show(
      status({
        ...base,
        createdFor: MARK,
        worktreeCleanup: { choice: "stop", phase: "waiting", worktreeHostId: null, error: null },
      }),
      [BOAT_PROVIDER]
    );
    expect(notice()?.textContent).toContain("It will be stopped once 'feature/login' is deleted.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();
    show(
      status({
        ...base,
        createdFor: MARK,
        worktreeCleanup: { choice: "delete", phase: "running", worktreeHostId: null, error: null },
      }),
      [BOAT_PROVIDER]
    );
    expect(notice()?.textContent).toBe("It's being deleted with 'feature/login'.");
    cleanup();
    show(status({ ...base, createdFor: MARK }), [BOAT_PROVIDER]);
    expect(notice()).toBeNull();
  });
});

describe("CloudMachineSection while its provider is missing", () => {
  it("says why beside an unconfirmed create, and offers no Retry that couldn't work", () => {
    const interrupted = status({
      operation: null,
      lastError: {
        code: "outcome-unknown",
        message: "Boat didn't confirm the machine. Retry looks for it before creating another.",
        at: 1,
      },
    });
    show({ ...interrupted, providerUnavailable: "Its plugin is turned off." });
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("Its plugin is turned off.");
    expect(alert).toContain("didn't confirm the machine");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    cleanup();

    show(interrupted);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("keeps why, and the unconfirmed create, in view after an action of its own failed", async () => {
    const interrupted = status({
      operation: null,
      lastError: {
        code: "outcome-unknown",
        message: "Boat didn't confirm the machine. Retry looks for it before creating another.",
        at: 1,
      },
    });
    vi.mocked(cloudHostsClient.retryCreate).mockRejectedValueOnce(
      new Error("Couldn't reach the plugin")
    );
    const view = show(interrupted);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/Couldn't reach the plugin/);
    cloud.snapshot = {
      providers: [],
      accounts: [],
      hosts: [{ ...interrupted, providerUnavailable: "Its plugin is turned off." }],
    };
    view.rerender(
      <CloudMachineSection hostId="build" hostName="build" connected={false} liveSummary={null} />
    );
    const alert = screen.getByRole("alert").textContent ?? "";
    expect(alert).toContain("Couldn't reach the plugin");
    expect(alert).toContain("Its plugin is turned off.");
    expect(alert).toContain("didn't confirm the machine");
  });
});

describe("CloudMachineSection while its plugin's provider is gone (#17353)", () => {
  const gone = (overrides: Partial<CloudHostStatus> = {}) =>
    status({
      providerId: "acme.droplets.droplets",
      providerUnavailable:
        "Its cloud provider comes from the acme.droplets plugin, which isn't installed.",
      pluginProvider: {
        pluginName: "Acme Droplets",
        providerName: "Droplets",
        dashboardUrl: "https://cloud.example.com/droplets",
      },
      resourceId: "dr_23456789",
      machine: "running",
      operation: null,
      observedAt: Date.now(),
      ...overrides,
    });

  it("names the provider and its plugin, reads even a fresh reading as the last one, and links the console", () => {
    openExternal.mockClear();
    show(gone());
    expect(screen.getByTestId("cloud-machine-state").textContent).toMatch(/^Last reported running/);
    expect(screen.getByText(/Droplets from the Acme Droplets plugin · Personal/)).toBeTruthy();
    const consoles = screen.getAllByRole("button", { name: "Open Droplets console" });
    expect(consoles).toHaveLength(1);
    fireEvent.click(consoles[0]!);
    expect(openExternal).toHaveBeenCalledWith("https://cloud.example.com/droplets");
  });

  it("offers the console once beside a cleanup that names it, and never a time it doesn't know", () => {
    show(
      gone({
        observedAt: 0,
        createdFor: {
          hostId: null,
          projectId: "0f1e2d3c",
          worktreeId: "/Users/me/code/app-worktrees/feature-login",
          projectName: "app",
          worktreeName: "feature/login",
          hostName: null,
        },
        worktreeCleanup: { choice: "delete", phase: "failed", worktreeHostId: null, error: null },
      })
    );
    expect(screen.getAllByRole("button", { name: "Open Droplets console" })).toHaveLength(1);
    expect(screen.getByTestId("cloud-machine-state").textContent).not.toMatch(/checked|1970/);
  });
});
