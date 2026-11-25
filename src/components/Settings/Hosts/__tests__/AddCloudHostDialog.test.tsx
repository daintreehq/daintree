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
  CloudResourceSummary,
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
import { takeFirstConnect } from "../hostCopySettingsRequests";

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
        stoppedStorageBilled: false,
      },
      typicalStartSeconds: null,
      lifetime: { kind: "renewable" },
      sshTrust: "pinned-from-api",
      transport: "direct",
      tunnel: null,
      provisioning,
      deletion: true,
    },
    unsupportedReason: null,
  };
}

function account(
  providerId: string,
  id = "ca_0123456789",
  displayName = "Personal"
): CloudAccountSummary {
  return {
    id,
    providerId,
    providerUnavailable: null,
    displayName,
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

/** Ireland is the suggestion, though not the first region listed. */
function ec2Catalog(overrides: Partial<CloudCatalog> = {}): CloudCatalog {
  return catalog({
    provisioning: {
      location: {
        label: "Region",
        defaultId: "eu-west-1",
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
          {
            ...choice("ami-euw1-debian", "Debian 12 (eu-west-1)", ["eu-west-1"]),
            description: "Debian 12 bookworm, arm64",
          },
        ],
      },
      network: {
        label: "Subnet",
        defaultId: null,
        choices: [
          choice("subnet-use1a", "us-east-1a", ["us-east-1"]),
          choice("subnet-euw1a", "eu-west-1a", ["eu-west-1"]),
        ],
      },
    },
    ...overrides,
  });
}

const ACME = () => provider("acme.clouds.ec2", "Acme", EC2);

function open(
  info: CloudProviderInfo,
  read: CloudCatalog,
  onReady: (host: { hostId: string; name: string }) => void = () => {}
) {
  cloud.snapshot = { providers: [info], accounts: [account(info.id)], hosts: [] };
  client.getCatalog.mockResolvedValue(read);
  render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={onReady} />);
  fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
}

const shown = (dimension: string) => screen.queryByTestId(`add-cloud-host-${dimension}`);
const createButton = () => screen.getByRole("button", { name: "Create and connect" });

async function choose(trigger: HTMLElement, option: string) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function create() {
  await waitFor(() => expect(createButton().getAttribute("aria-disabled")).toBeNull());
  fireEvent.click(createButton());
  await waitFor(() => expect(client.createHost).toHaveBeenCalledTimes(1));
  return client.createHost.mock.calls[0]![0];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
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
    // Even a catalog listing regions shows none for a provider that takes none.
    const read = ec2Catalog();
    open(provider("boat", "Boat", NONE), read);
    await screen.findByText(/Default ·/);
    expect(shown("location")).toBeNull();
    expect(shown("image")).toBeNull();
    expect(shown("network")).toBeNull();
    expect(await create()).toEqual({
      accountId: "ca_0123456789",
      name: "build",
      machineType: "default",
      lifetimeHours: 2,
      mcpServerOnConnect: true,
    });
  });

  it("starts from the account's last choice, under the provider's names, and sends what it shows", async () => {
    const last = { location: "us-east-1", image: "ami-use1", network: "subnet-use1a" };
    open(ACME(), ec2Catalog({ lastChoice: last }));
    const region = await screen.findByRole("combobox", { name: "Region" });
    await waitFor(() => expect(region.textContent).toBe("US East (N. Virginia)"));
    expect(screen.getByRole("combobox", { name: "AMI" }).textContent).toBe(
      "Ubuntu 24.04 (us-east-1)"
    );
    expect(screen.getByRole("combobox", { name: "Subnet" }).textContent).toBe("us-east-1a");
    expect((await create()).provisioning).toEqual(last);
  });

  it("starts a first create from the provider's suggestion, leaving the optional subnet to it", async () => {
    open(ACME(), ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    expect(shown("image")?.textContent).toBe("Ubuntu 24.04 (eu-west-1)");
    // A subnet could be chosen here; none is until someone does.
    expect(shown("network")?.textContent).toBe("Chosen by Acme");
    expect((await create()).provisioning).toEqual({
      location: "eu-west-1",
      image: "ami-euw1",
      network: null,
    });
  });

  it("sends the image and subnet picked", async () => {
    open(ACME(), ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    const described = () =>
      (shown("image")!.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean);
    expect(described()).toEqual([]);
    await choose(shown("image")!, "Debian 12 (eu-west-1)");
    await waitFor(() => expect(described()).toEqual(["Debian 12 bookworm, arm64"]));
    await choose(shown("network")!, "eu-west-1a");
    await waitFor(() => expect(shown("network")?.textContent).toBe("eu-west-1a"));
    expect(shown("image")?.textContent).toBe("Debian 12 (eu-west-1)");
    expect((await create()).provisioning).toEqual({
      location: "eu-west-1",
      image: "ami-euw1-debian",
      network: "subnet-euw1a",
    });
  });

  it("moves the image and subnet with the region, and hands a subnet back to the provider", async () => {
    open(ACME(), ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    await choose(shown("network")!, "eu-west-1a");
    await choose(shown("location")!, "US East (N. Virginia)");
    await waitFor(() => expect(shown("image")?.textContent).toBe("Ubuntu 24.04 (us-east-1)"));
    expect(shown("network")?.textContent).toBe("Chosen by Acme");
    await choose(shown("network")!, "us-east-1a");
    await waitFor(() => expect(shown("network")?.textContent).toBe("us-east-1a"));
    await choose(shown("network")!, "Chosen by Acme");
    await waitFor(() => expect(shown("network")?.textContent).toBe("Chosen by Acme"));
    expect((await create()).provisioning).toEqual({
      location: "us-east-1",
      image: "ami-use1",
      network: null,
    });
  });

  it("keeps one account's picks and catalog away from another's", async () => {
    const first = deferred<CloudCatalog>();
    const second = deferred<CloudCatalog>();
    cloud.snapshot = {
      providers: [ACME()],
      accounts: [account(ACME().id), account(ACME().id, "ca_abcdefghij", "Team")],
      hosts: [],
    };
    client.getCatalog.mockImplementation((id: string) =>
      id === "ca_0123456789" ? first.promise : second.promise
    );
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    first.resolve(ec2Catalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    await choose(shown("location")!, "US East (N. Virginia)");
    await waitFor(() => expect(shown("location")?.textContent).toBe("US East (N. Virginia)"));

    await choose(screen.getAllByRole("combobox")[0]!, "Team");
    await waitFor(() => expect(shown("location")).toBeNull());
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    second.resolve(ec2Catalog({ accountId: "ca_abcdefghij" }));
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe (Ireland)"));
    const sent = await create();
    expect(sent.accountId).toBe("ca_abcdefghij");
    expect(sent.provisioning).toEqual({ location: "eu-west-1", image: "ami-euw1", network: null });
  });

  it("won't create when the region offers no image, and says so", async () => {
    const read = ec2Catalog();
    read.provisioning.location!.defaultId = "us-east-1";
    read.provisioning.image!.choices = [choice("ami-euw1", "Ubuntu 24.04", ["eu-west-1"])];
    open(ACME(), read);
    expect((await screen.findByTestId("add-cloud-host-provisioning-problem")).textContent).toBe(
      "Acme offers this account no AMI in US East (N. Virginia). Choose another region."
    );
    expect(shown("image")?.textContent).toBe("Nothing to choose");
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(createButton());
    expect(client.createHost).not.toHaveBeenCalled();
  });
});

describe("AddCloudHostDialog connecting an account", () => {
  const allowed = (info: CloudProviderInfo, granted: boolean): CloudProviderInfo => ({
    ...info,
    plugin: {
      pluginId: "acme.clouds",
      pluginName: "Acme Clouds",
      fingerprint: "fp-1",
      granted,
      providerNames: ["Acme"],
    },
  });

  it("offers Connect for every provider this machine can use, a plugin's included", () => {
    cloud.snapshot = {
      providers: [provider("boat", "Boat", NONE), allowed(ACME(), false)],
      accounts: [],
      hosts: [],
    };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(screen.getByRole("button", { name: "Connect Boat account" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Acme account" }));
    // A plugin's provider asks its consent before any credentials are entered.
    expect(screen.getByTestId("cloud-provider-consent-dialog").textContent).toContain(
      "Acme Clouds"
    );
  });

  it("makes no machine from an account whose plugin isn't allowed now", () => {
    cloud.snapshot = {
      providers: [allowed(ACME(), false)],
      accounts: [
        {
          ...account("acme.clouds.ec2"),
          providerUnavailable:
            "Its cloud provider comes from the Acme Clouds plugin, which changed what it asks for or does since you allowed it.",
        },
      ],
      hosts: [],
    };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(screen.queryByTestId("add-cloud-host-name")).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Acme account" })).toBeTruthy();
    expect(client.getCatalog).not.toHaveBeenCalled();
  });
});

// The Copy settings offer is armed as the host is recorded, not on handover: closing the
// dialog while the machine boots doesn't stop setup, and the host's first connection,
// wherever it happens, still finds the offer (#18186).
describe("AddCloudHostDialog arming the Copy settings offer", () => {
  it("arms it for a machine it creates, once the create answers, and keeps it after closing", async () => {
    const answer = deferred<{ hostId: string }>();
    client.createHost.mockReturnValue(answer.promise);
    const onReady = vi.fn();
    open(provider("boat", "Boat", NONE), catalog(), onReady);
    await create();
    expect(takeFirstConnect("made")).toBe(false);

    answer.resolve({ hostId: "made" });
    await screen.findByTestId("add-cloud-host-progress");
    // Closed while the machine is still coming up: setup never handed over here.
    cleanup();
    expect(onReady).not.toHaveBeenCalled();
    expect(takeFirstConnect("made")).toBe(true);
    expect(takeFirstConnect("made")).toBe(false);
  });

  it("arms the host it adds from the account, under the id the add answers with", async () => {
    const machine: CloudResourceSummary = {
      resourceId: "vm_1",
      name: "old",
      machine: "running",
      rawState: "running",
      machineType: null,
      vcpu: 4,
      memoryGB: 8,
      createdAt: null,
      stoppedAt: null,
      dataExpired: false,
      boundHostId: null,
      restricted: false,
      asleep: false,
    };
    client.listResources.mockResolvedValue([machine]);
    const answer = deferred<{ hostId: string }>();
    client.importHost.mockReturnValue(answer.promise);
    open(provider("boat", "Boat", NONE), catalog());
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    fireEvent.click(await screen.findByRole("radio", { name: /^old/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(client.importHost).toHaveBeenCalledTimes(1));
    expect(takeFirstConnect("host-old")).toBe(false);

    answer.resolve({ hostId: "host-old" });
    await screen.findByTestId("add-cloud-host-progress");
    expect(takeFirstConnect("old")).toBe(false);
    expect(takeFirstConnect("vm_1")).toBe(false);
    expect(takeFirstConnect("host-old")).toBe(true);
  });
});

describe("AddCloudHostDialog MCP server (#18187)", () => {
  const machine: CloudResourceSummary = {
    resourceId: "vm_1",
    name: "old",
    machine: "running",
    rawState: "running",
    machineType: null,
    vcpu: 4,
    memoryGB: 8,
    createdAt: null,
    stoppedAt: null,
    dataExpired: false,
    boundHostId: null,
    restricted: false,
    asleep: false,
  };
  const mcpBox = () => screen.getByRole("checkbox", { name: "Turn on its MCP server" });
  const checked = () => mcpBox().getAttribute("aria-checked");

  it("asks for a new machine's MCP server by default, and sends a no once unticked", async () => {
    open(provider("boat", "Boat", NONE), catalog());
    await screen.findByText(/Default ·/);
    expect(checked()).toBe("true");
    fireEvent.click(mcpBox());
    expect(checked()).toBe("false");
    expect(await create()).toMatchObject({ mcpServerOnConnect: false });
  });

  it("leaves an existing machine's server alone unless ticked, whatever was chosen for a new one", async () => {
    client.listResources.mockResolvedValue([machine]);
    client.importHost.mockResolvedValue({ hostId: "host-old" });
    open(provider("boat", "Boat", NONE), catalog());
    await screen.findByText(/Default ·/);
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    fireEvent.click(await screen.findByRole("radio", { name: /^old/ }));
    expect(checked()).toBe("false");

    // A tick for the existing machine doesn't reach back to the new one, nor the new one's here.
    fireEvent.click(mcpBox());
    fireEvent.click(screen.getByRole("radio", { name: "New machine" }));
    expect(checked()).toBe("true");
    fireEvent.click(mcpBox());
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    // The list is read again on the way back; the machine chosen stays chosen.
    await screen.findByRole("radio", { name: /^old/ });
    expect(checked()).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(client.importHost).toHaveBeenCalledTimes(1));
    expect(client.importHost.mock.calls[0]![0]).toEqual({
      accountId: "ca_0123456789",
      resourceId: "vm_1",
      name: "build",
      mcpServerOnConnect: true,
    });
  });

  it("sends an existing machine's default as a no", async () => {
    client.listResources.mockResolvedValue([machine]);
    client.importHost.mockResolvedValue({ hostId: "host-old" });
    open(provider("boat", "Boat", NONE), catalog());
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    fireEvent.click(await screen.findByRole("radio", { name: /^old/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(client.importHost).toHaveBeenCalledTimes(1));
    expect(client.importHost.mock.calls[0]![0]).toMatchObject({ mcpServerOnConnect: false });
  });
});
