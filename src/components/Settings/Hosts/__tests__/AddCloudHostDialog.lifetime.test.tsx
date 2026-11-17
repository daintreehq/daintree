// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      },
      typicalStartSeconds: null,
      lifetime,
      sshTrust: "pinned-from-api",
      transport: "direct",
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
    const review = await open({ kind: "renewable" });
    expect(lifetimeChoice()).not.toBeNull();
    expect(lifetimeNote()).toBeNull();
    expect(screen.getByText(/pushed back while a window here shows it/)).toBeTruthy();
    expect(review).toContain("It stops by itself 2 hours after starting unless it's in use here.");
    expect(await createAndSend()).toBe(2);
  });

  it("offers a fixed limit at create, and says it can't be extended while it runs", async () => {
    const review = await open({ kind: "fixed-at-create", canChangeWhileStopped: false });
    expect(lifetimeChoice()).not.toBeNull();
    expect(screen.getByText(/Acme can't extend it while the machine runs/)).toBeTruthy();
    expect(review).toContain("2 hours after starting, and that can't be extended while it runs");
    expect(review).not.toContain("unless it's in use here");
    expect(await createAndSend()).toBe(2);
  });

  it("offers no lifetime on a provider without one, and sends none", async () => {
    const review = await open({ kind: "none" });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe(
      "Acme has no lifetime for its machines: it runs until you stop it."
    );
    expect(review).toContain("It runs until you stop it.");
    expect(await createAndSend()).toBeNull();
  });

  it("says a provider sleeps idle machines, with its idle time, and sends no lifetime", async () => {
    const review = await open({ kind: "idle-sleep", idleSeconds: 1800 });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe(
      "Acme puts it to sleep by itself after 30 minutes without activity."
    );
    expect(review).toContain("It sleeps by itself after 30 minutes without activity.");
    expect(await createAndSend()).toBeNull();
  });

  it("says a provider sleeps idle machines even when it doesn't say after how long", async () => {
    await open({ kind: "idle-sleep", idleSeconds: null });
    expect(lifetimeChoice()).toBeNull();
    expect(lifetimeNote()).toBe("Acme puts it to sleep by itself once it's been idle for a while.");
  });
});
