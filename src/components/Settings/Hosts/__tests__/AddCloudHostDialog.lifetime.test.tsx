// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudAccountSummary,
  CloudCatalog,
  CloudHostsSnapshot,
  CloudLifetimeModel,
  CloudProviderInfo,
} from "@shared/types/cloudHosts";

const { cloud, client } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  client: {
    getCatalog: vi.fn(),
    listResources: vi.fn(),
    createHost: vi.fn(),
    importHost: vi.fn(),
    startHost: vi.fn(),
    refreshHost: vi.fn(),
    retryCreate: vi.fn(),
  },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));
vi.mock("../ConnectCloudAccountDialog", () => ({ ConnectCloudAccountDialog: () => null }));

import { AddCloudHostDialog } from "../AddCloudHostDialog";

function provider(lifetime: CloudLifetimeModel): CloudProviderInfo {
  return {
    id: "acme.clouds.vm",
    name: "Acme",
    description: "Machines on Acme",
    apiKeyUrl: "https://acme.test/keys",
    dashboardUrl: "https://acme.test",
    docsUrl: "https://acme.test/docs",
    credentialFields: [],
    capabilities: {
      persistence: {
        kept: "Files on its disk",
        lost: "memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: false,
      },
      typicalStartSeconds: null,
      lifetime,
      sshTrust: "pinned-from-api",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "none", image: "none", network: "none", sshKey: "after-create" },
      deletion: true,
    },
    unsupportedReason: null,
  };
}

const ACCOUNT: CloudAccountSummary = {
  id: "ca_0123456789",
  providerId: "acme.clouds.vm",
  providerUnavailable: null,
  displayName: "Personal",
  identity: "octocat",
  billingScope: { kind: "personal", id: "personal", name: "Personal" },
  validation: { status: "valid", checkedAt: 0 },
  hostCount: 0,
  addedAt: 0,
  keyHint: "abcd",
};

const CATALOG: CloudCatalog = {
  accountId: ACCOUNT.id,
  machineTypes: [
    {
      id: "default",
      label: "Default",
      vcpu: 4,
      memoryGB: 8,
      hourlyDollars: 0.036,
      available: true,
      reason: null,
    },
  ],
  provisioning: { location: null, image: null, network: null },
  lastChoice: null,
  canStart: true,
  includedHoursRemaining: null,
  startsRemaining: null,
  savedSnapshotDayDollars: null,
  fetchedAt: 0,
};

async function open(lifetime: CloudLifetimeModel) {
  cloud.snapshot = { providers: [provider(lifetime)], accounts: [ACCOUNT], hosts: [] };
  return show();
}

async function show() {
  render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
  // The review appears once the sizes are read and one is chosen.
  return (await screen.findByTestId("add-cloud-host-review")).textContent ?? "";
}

/** Names the host and presses Create; resolves with the lifetime the request carried. */
async function createAndSend(): Promise<number | null> {
  fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and connect" }));
  await waitFor(() => expect(client.createHost).toHaveBeenCalledTimes(1));
  return client.createHost.mock.calls[0]![0].lifetimeHours;
}

/** Opens a Radix select from the keyboard and picks one of its options. */
async function choose(trigger: HTMLElement, option: string | RegExp) {
  await act(async () => {
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
  });
  const item = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.click(item);
  });
}

const review = () => screen.getByTestId("add-cloud-host-review").textContent ?? "";
const lifetimeNote = () =>
  screen.queryByTestId("add-cloud-host-lifetime-note")?.textContent ?? null;
const lifetimeChoice = () => screen.queryByTestId("add-cloud-host-lifetime");

beforeEach(() => {
  client.getCatalog.mockResolvedValue(CATALOG);
  client.listResources.mockResolvedValue([]);
  client.createHost.mockResolvedValue({ hostId: "build" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddCloudHostDialog lifetime", () => {
  it("offers a renewable lifetime that's pushed back while the machine is in use", async () => {
    const initial = await open({ kind: "renewable" });
    expect(lifetimeChoice()).not.toBeNull();
    expect(lifetimeNote()).toBeNull();
    expect(screen.getByText(/pushed back while a window here shows it/)).toBeTruthy();
    expect(initial).toContain("It stops by itself 2 hours after starting unless it's in use here.");
    await choose(lifetimeChoice()!, "4 hours");
    expect(review()).toContain(
      "It stops by itself 4 hours after starting unless it's in use here."
    );
    expect(await createAndSend()).toBe(4);
  });

  it("offers a fixed limit at create, and says it can't be extended while it runs", async () => {
    const initial = await open({ kind: "fixed-at-create", canChangeWhileStopped: false });
    expect(lifetimeChoice()).not.toBeNull();
    expect(screen.getByText(/Acme can't extend it while the machine runs/)).toBeTruthy();
    expect(initial).toContain("2 hours after starting, and that can't be extended while it runs");
    expect(initial).not.toContain("unless it's in use here");
    await choose(lifetimeChoice()!, "8 hours");
    expect(review()).toContain("8 hours after starting, and that can't be extended");
    expect(await createAndSend()).toBe(8);
  });

  it("drops the fixed limit's warning once Never is chosen, and sends none", async () => {
    await open({ kind: "fixed-at-create", canChangeWhileStopped: true });
    await choose(lifetimeChoice()!, "Never");
    expect(review()).toContain("It runs until you stop it.");
    expect(screen.queryByText(/it stops then even if/)).toBeNull();
    expect(screen.getByText(/with none, it runs until you stop it/)).toBeTruthy();
    expect(await createAndSend()).toBeNull();
  });

  it("sends no lifetime once the account switches to a provider without one", async () => {
    cloud.snapshot = {
      providers: [
        { ...provider({ kind: "renewable" }), id: "acme.clouds.renew", name: "Renewing" },
        provider({ kind: "none" }),
      ],
      accounts: [
        { ...ACCOUNT, id: "ca_renewing0001", displayName: "Work", providerId: "acme.clouds.renew" },
        ACCOUNT,
      ],
      hosts: [],
    };
    await show();
    await choose(lifetimeChoice()!, "8 hours");
    // The account select comes first in the form; the dialog's selects carry no accessible name.
    await choose(screen.getAllByRole("combobox")[0]!, /^Personal/);
    await screen.findByTestId("add-cloud-host-lifetime-note");
    expect(lifetimeChoice()).toBeNull();
    expect(await createAndSend()).toBeNull();
    expect(client.createHost.mock.calls[0]![0].accountId).toBe(ACCOUNT.id);
  });

  it("offers no lifetime on a provider without one, and sends none", async () => {
    const initial = await open({ kind: "none" });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe(
      "Acme has no lifetime for its machines: it runs until you stop it."
    );
    expect(initial).toContain("It runs until you stop it.");
    expect(await createAndSend()).toBeNull();
  });

  it("says a provider sleeps idle machines, with its idle time, and sends no lifetime", async () => {
    const initial = await open({ kind: "idle-sleep", idleSeconds: 1800 });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe(
      "Acme puts it to sleep by itself after 30 minutes without activity."
    );
    expect(initial).toContain("It sleeps by itself after 30 minutes without activity.");
    expect(await createAndSend()).toBeNull();
  });

  // An existing machine's own setting decides whether it sleeps (#17347): the provider's
  // default for new ones is no promise about it.
  it("promises nothing about sleep for an existing machine, and calls an asleep one asleep", async () => {
    const old = {
      resourceId: "vm_1",
      name: "old",
      machine: "stopped",
      boundHostId: null,
      asleep: true,
    };
    client.listResources.mockResolvedValue([{ ...old, vcpu: 4, memoryGB: 8 }]);
    await open({ kind: "idle-sleep", idleSeconds: 1800 });
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    const row = await screen.findByRole("radio", { name: /^old/ });
    expect(row.closest("label")?.textContent ?? document.body.textContent).toContain("Asleep");
    fireEvent.click(row);
    const note = screen.getByTestId("add-cloud-host-import-note").textContent ?? "";
    expect(note).toContain("doesn't start it or change whether Acme puts it to sleep when idle");
    expect(note).not.toContain("30 minutes");
  });

  it("says an existing machine is reachable only if it took this account's key when it was made", async () => {
    const old = { resourceId: "vm_1", name: "old", machine: "running", boundHostId: null };
    client.listResources.mockResolvedValue([{ ...old, vcpu: 4, memoryGB: 8 }]);
    const atCreate = provider({ kind: "none" });
    atCreate.capabilities.provisioning.sshKey = "at-create";
    cloud.snapshot = { providers: [atCreate], accounts: [ACCOUNT], hosts: [] };
    await show();
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    fireEvent.click(await screen.findByRole("radio", { name: /^old/ }));
    expect(screen.getByTestId("add-cloud-host-import-note").textContent).toBe(
      "Adding it doesn't start it or change its auto-stop. Acme has no lifetime for its machines: it runs until you stop it. Acme takes an SSH key only when a machine is created, so Daintree can connect only to one it made with this account."
    );
  });

  it("says a provider sleeps idle machines even when it doesn't say after how long", async () => {
    await open({ kind: "idle-sleep", idleSeconds: null });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe("Acme puts it to sleep by itself once it's been idle for a while.");
  });
});
