// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudAccountSummary,
  CloudCatalog,
  CloudHostsSnapshot,
  CloudProviderInfo,
  CloudProvisioning,
  CloudProvisioningChoice,
} from "@shared/types/cloudHosts";

const { cloud, client } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  client: {
    getCatalog: vi.fn(),
    createHost: vi.fn(),
    listResources: vi.fn(),
    startHost: vi.fn(),
    refreshHost: vi.fn(),
    retryCreate: vi.fn(),
    importHost: vi.fn(),
  },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));

import { AddCloudHostDialog } from "../AddCloudHostDialog";

const NONE: CloudProvisioning = {
  location: "none",
  image: "none",
  network: "none",
  sshKey: "after-create",
};
/** EC2's shape: a region and an AMI always, a subnet when asked. */
const EC2: CloudProvisioning = {
  location: "required",
  image: "required",
  network: "optional",
  sshKey: "at-create",
};

function provider(id: string, name: string, provisioning: CloudProvisioning): CloudProviderInfo {
  return {
    id,
    name,
    description: "",
    apiKeyUrl: "",
    dashboardUrl: "",
    docsUrl: "",
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
      lifetime: { kind: "renewable" },
      sshTrust: "pinned-from-api",
      transport: "direct",
      provisioning,
      deletion: true,
    },
    unsupportedReason: null,
  };
}

function account(providerId: string): CloudAccountSummary {
  return {
    id: "ca_0123456789",
    providerId,
    providerUnavailable: null,
    displayName: "Personal",
    identity: "octocat",
    billingScope: { kind: "personal", id: "personal", name: "Personal" },
    validation: { status: "valid", checkedAt: 1 },
    hostCount: 0,
    addedAt: 1,
    keyHint: null,
  };
}

const choice = (
  id: string,
  label: string,
  locations: string[] | null = null
): CloudProvisioningChoice => ({
  id,
  label,
  description: null,
  available: true,
  reason: null,
  locations,
});

function catalog(overrides: Partial<CloudCatalog> = {}): CloudCatalog {
  return {
    accountId: "ca_0123456789",
    machineTypes: [
      {
        id: "default",
        label: "Default",
        vcpu: 2,
        memoryGB: 4,
        hourlyDollars: 0.05,
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
    fetchedAt: 1,
    ...overrides,
  };
}

function ec2Catalog(overrides: Partial<CloudCatalog> = {}): CloudCatalog {
  return catalog({
    provisioning: {
      location: {
        label: "Region",
        defaultId: "us-east-1",
        choices: [
          choice("us-east-1", "US East (N. Virginia)"),
          choice("eu-west-1", "Europe (Ireland)"),
        ],
      },
      image: {
        label: "AMI",
        defaultId: null,
        choices: [
          choice("ami-use1", "Ubuntu 24.04 (us-east-1)", ["us-east-1"]),
          choice("ami-euw1", "Ubuntu 24.04 (eu-west-1)", ["eu-west-1"]),
        ],
      },
      network: {
        label: "Subnet",
        defaultId: null,
        choices: [choice("subnet-euw1a", "eu-west-1a", ["eu-west-1"])],
      },
    },
    ...overrides,
  });
}

function open(info: CloudProviderInfo, read: CloudCatalog) {
  cloud.snapshot = { providers: [info], accounts: [account(info.id)], hosts: [] };
  client.getCatalog.mockResolvedValue(read);
  render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
  fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
}

const shown = (dimension: string) => screen.queryByTestId(`add-cloud-host-${dimension}`);
const createButton = () => screen.getByRole("button", { name: "Create and connect" });

async function create() {
  await waitFor(() => expect(createButton().getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(createButton());
  await waitFor(() => expect(client.createHost).toHaveBeenCalledTimes(1));
  return client.createHost.mock.calls[0]![0];
}

beforeEach(() => {
  client.createHost.mockResolvedValue({ hostId: "build" });
  client.listResources.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AddCloudHostDialog provisioning", () => {
  it("shows Boat nothing new and sends the request it always has", async () => {
    open(provider("boat", "Boat", NONE), catalog());
    await screen.findByText(/Default ·/);
    expect(shown("location")).toBeNull();
    expect(shown("image")).toBeNull();
    expect(shown("network")).toBeNull();
    expect(await create()).toEqual({
      accountId: "ca_0123456789",
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
    });
  });

  it("starts from the account's last choice and sends exactly what the controls show", async () => {
    const last = { location: "eu-west-1", image: "ami-euw1", network: "subnet-euw1a" };
    open(provider("acme.clouds.ec2", "Acme", EC2), ec2Catalog({ lastChoice: last }));
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    expect(shown("image")?.textContent).toBe("Ubuntu 24.04 (eu-west-1)");
    expect(shown("network")?.textContent).toBe("eu-west-1a");
    expect((await create()).provisioning).toEqual(last);
  });

  it("starts a first create from the provider's suggestion, leaving the optional subnet to it", async () => {
    open(provider("acme.clouds.ec2", "Acme", EC2), ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("US East (N. Virginia)"));
    expect(shown("image")?.textContent).toBe("Ubuntu 24.04 (us-east-1)");
    expect(shown("network")?.textContent).toBe("Chosen by Acme");
    expect((await create()).provisioning).toEqual({
      location: "us-east-1",
      image: "ami-use1",
      network: null,
    });
  });

  it("moves the image to one the new region offers", async () => {
    open(provider("acme.clouds.ec2", "Acme", EC2), ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("US East (N. Virginia)"));
    fireEvent.keyDown(shown("location")!, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "Europe (Ireland)" }));
    await waitFor(() => expect(shown("image")?.textContent).toBe("Ubuntu 24.04 (eu-west-1)"));
    expect((await create()).provisioning).toEqual({
      location: "eu-west-1",
      image: "ami-euw1",
      network: null,
    });
  });

  it("won't create when the region offers no image, and says so", async () => {
    const read = ec2Catalog();
    read.provisioning.image!.choices = [choice("ami-euw1", "Ubuntu 24.04", ["eu-west-1"])];
    open(provider("acme.clouds.ec2", "Acme", EC2), read);
    expect((await screen.findByTestId("add-cloud-host-provisioning-problem")).textContent).toBe(
      "Acme offers this account no AMI in US East (N. Virginia). Choose another region."
    );
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(createButton());
    expect(client.createHost).not.toHaveBeenCalled();
  });
});
