// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  CloudAccountSummary,
  CloudCatalog,
  CloudHostStatus,
  CloudHostsSnapshot,
  CloudProviderInfo,
  CloudProvisioning,
  CloudProvisioningChoice,
  CloudResourceSummary,
} from "@shared/types/cloudHosts";

const { cloud, client, openExternal } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  openExternal: vi.fn(async (_url: string) => {}),
  client: {
    getCatalog: vi.fn(),
    findTunnel: vi.fn(),
    createHost: vi.fn(),
    listResources: vi.fn(),
    startHost: vi.fn(),
    refreshHost: vi.fn(),
    retryCreate: vi.fn(),
    importHost: vi.fn(),
    chooseOffer: vi.fn(),
    cancelOrder: vi.fn(),
    refreshOffers: vi.fn(),
  },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));
vi.mock("@/clients/systemClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/clients/systemClient")>();
  return { ...actual, systemClient: { ...actual.systemClient, openExternal } };
});

const placement = vi.hoisted(() => ({
  current: { ready: false } as
    { ready: true; cwd: string; worktreeId: string | undefined } | { ready: false },
}));
vi.mock("@/hooks/terminal/useHomeTerminalPlacement", () => ({
  useHomeTerminalPlacement: () => placement.current,
}));

import { AddCloudHostDialog } from "../AddCloudHostDialog";
import { takeFirstConnect } from "../hostCopySettingsRequests";
import { InstallCommandHandoffContext } from "@/hooks/terminal/installCommandHandoffContext";
import { DELETE_ONLY_PROVIDER } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

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

async function choose(trigger: HTMLElement, option: string | RegExp) {
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

describe("AddCloudHostDialog sizes tied to a region (#18189)", () => {
  /** Agent 37's shape: a region when the person picks one, and sizes some regions don't run. */
  const REGION_ONLY: CloudProvisioning = {
    location: "optional",
    image: "none",
    network: "none",
    sshKey: "at-create",
  };
  const A37 = () => provider("agent37", "Agent 37", REGION_ONLY);
  const size = (id: string, label: string, locations: string[] | null, extra = {}) => ({
    id,
    label,
    vcpu: 2,
    memoryGB: 4,
    hourlyDollars: 0.01,
    available: true,
    reason: null,
    locations,
    ...extra,
  });
  function regionCatalog(overrides: Partial<CloudCatalog> = {}): CloudCatalog {
    return catalog({
      machineTypes: [
        size("2x4", "Small", ["us"]),
        size("vm-2x4", "VM small", null),
        // Tied to the US as well, so the account's own reason has to win over the region's.
        size("vm-8x64", "VM huge", ["us"], { available: false, reason: "too big for this wallet" }),
      ],
      provisioning: {
        location: {
          label: "Region",
          defaultId: "us",
          choices: [choice("us", "United States"), choice("eu", "Europe")],
        },
        image: null,
        network: null,
      },
      ...overrides,
    });
  }
  const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
  const reasonOf = (input: HTMLInputElement) =>
    document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent;

  it("starts on the US with its first size, and keeps the size shown when the region moves", async () => {
    open(A37(), regionCatalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("United States"));
    expect(radio(/^Small/).checked).toBe(true);
    // Never swapped for another size at another price behind the person's back.
    await choose(shown("location")!, "Europe");
    await waitFor(() => expect(radio(/^Small/).disabled).toBe(true));
    expect(radio(/^Small/).checked).toBe(true);
    expect(reasonOf(radio(/^Small/))).toBe("Not offered in Europe");
    expect(screen.queryByTestId("add-cloud-host-review")).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    // The account's own reason stands wherever it runs.
    expect(reasonOf(radio(/^VM huge/))).toBe("Too big for this wallet");
    fireEvent.click(radio(/^VM small/));
    const sent = await create();
    expect(sent).toMatchObject({
      machineType: "vm-2x4",
      provisioning: { location: "eu", image: null, network: null },
    });
  });

  it("keeps a size the person picked when the region moves under it, and won't create it there", async () => {
    open(A37(), regionCatalog());
    await waitFor(() => expect(shown("location")?.textContent).toBe("United States"));
    fireEvent.click(radio(/^VM small/));
    fireEvent.click(radio(/^Small/));
    await choose(shown("location")!, "Europe");
    await waitFor(() => expect(radio(/^Small/).disabled).toBe(true));
    expect(radio(/^Small/).checked).toBe(true);
    expect(screen.queryByTestId("add-cloud-host-review")).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(createButton());
    expect(client.createHost).not.toHaveBeenCalled();

    // Left to the provider, a size tied to a region still needs one named.
    await choose(shown("location")!, "Chosen by Agent 37");
    await waitFor(() => expect(reasonOf(radio(/^Small/))).toBe("Choose United States to use it"));
    fireEvent.click(radio(/^VM small/));
    expect((await create()).provisioning).toEqual({ location: null, image: null, network: null });
  });

  it("starts an account last used in Europe on the first size Europe runs", async () => {
    open(A37(), regionCatalog({ lastChoice: { location: "eu", image: null, network: null } }));
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe"));
    expect(radio(/^VM small/).checked).toBe(true);
    expect(radio(/^Small/).checked).toBe(false);
    expect(await create()).toMatchObject({
      machineType: "vm-2x4",
      provisioning: { location: "eu", image: null, network: null },
    });
  });

  it("keeps each account's region with its size across a visit to another account", async () => {
    cloud.snapshot = {
      providers: [A37()],
      accounts: [account("agent37"), account("agent37", "ca_abcdefghij", "Team")],
      hosts: [],
    };
    client.getCatalog.mockImplementation(async (accountId: string) => regionCatalog({ accountId }));
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await waitFor(() => expect(shown("location")?.textContent).toBe("United States"));
    await choose(shown("location")!, "Europe");
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe"));
    fireEvent.click(radio(/^VM small/));
    await choose(screen.getAllByRole("combobox")[0]!, "Team");
    await waitFor(() => expect(shown("location")?.textContent).toBe("United States"));
    await choose(shown("location")!, "Chosen by Agent 37");
    await waitFor(() => expect(shown("location")?.textContent).toBe("Chosen by Agent 37"));
    await choose(screen.getAllByRole("combobox")[0]!, "Personal");
    await waitFor(() => expect(shown("location")?.textContent).toBe("Europe"));
    expect(radio(/^VM small/).checked).toBe(true);
    expect(await create()).toMatchObject({
      accountId: "ca_0123456789",
      machineType: "vm-2x4",
      provisioning: { location: "eu", image: null, network: null },
    });
  });

  it("keeps the size shown when the region moves after a picked size left the catalog", async () => {
    cloud.snapshot = {
      providers: [A37()],
      accounts: [account("agent37"), account("agent37", "ca_abcdefghij", "Team")],
      hosts: [],
    };
    let reads = 0;
    client.getCatalog.mockImplementation(async (accountId: string) => {
      const read = regionCatalog({ accountId });
      // The second read of the first account no longer offers the size picked from the first.
      if (accountId === "ca_0123456789" && reads++ > 0) {
        read.machineTypes = read.machineTypes.filter((type) => type.id !== "vm-2x4");
      }
      return read;
    });
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await waitFor(() => expect(radio(/^Small/).checked).toBe(true));
    fireEvent.click(radio(/^VM small/));
    await choose(screen.getAllByRole("combobox")[0]!, "Team");
    await waitFor(() => expect(radio(/^VM small/)).toBeTruthy());
    await choose(screen.getAllByRole("combobox")[0]!, "Personal");
    await waitFor(() => expect(screen.queryByRole("radio", { name: /^VM small/ })).toBeNull());
    expect(radio(/^Small/).checked).toBe(true);
    await choose(shown("location")!, "Europe");
    await waitFor(() => expect(radio(/^Small/).disabled).toBe(true));
    expect(radio(/^Small/).checked).toBe(true);
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps each account's size when the person moves between accounts", async () => {
    cloud.snapshot = {
      providers: [A37()],
      accounts: [account("agent37"), account("agent37", "ca_abcdefghij", "Team")],
      hosts: [],
    };
    client.getCatalog.mockImplementation(async (accountId: string) => regionCatalog({ accountId }));
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await waitFor(() => expect(radio(/^Small/).checked).toBe(true));
    fireEvent.click(radio(/^VM small/));
    await choose(screen.getAllByRole("combobox")[0]!, "Team");
    await waitFor(() => expect(radio(/^Small/).checked).toBe(true));
    // A pick on the second account leaves the first account's alone.
    fireEvent.click(radio(/^VM small/));
    fireEvent.click(radio(/^Small/));
    await choose(screen.getAllByRole("combobox")[0]!, "Personal");
    await waitFor(() => expect(radio(/^VM small/).checked).toBe(true));
    expect(await create()).toMatchObject({ accountId: "ca_0123456789", machineType: "vm-2x4" });
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
    // What it turns on is said with it.
    const describedBy = mcpBox().getAttribute("aria-describedby") ?? "";
    const description = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    expect(description).toContain("127.0.0.1");
    expect(description).toContain("Settings → Integrations → MCP server");
    fireEvent.click(mcpBox());
    expect(checked()).toBe("false");
    expect(await create()).toMatchObject({ mcpServerOnConnect: false });
  });

  it("can't be changed while the machine is being created", async () => {
    const answer = deferred<{ hostId: string }>();
    client.createHost.mockReturnValue(answer.promise);
    open(provider("boat", "Boat", NONE), catalog());
    await create();
    expect(mcpBox().hasAttribute("disabled")).toBe(true);
    answer.resolve({ hostId: "build" });
    await screen.findByTestId("add-cloud-host-progress");
  });

  it("leaves an existing machine's server alone unless ticked, whatever was chosen for a new one", async () => {
    client.listResources.mockResolvedValue([machine]);
    client.importHost.mockResolvedValue({ hostId: "host-old" });
    open(provider("boat", "Boat", NONE), catalog());
    await screen.findByText(/Default ·/);
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    const old = await screen.findByRole("radio", { name: /^old/ });
    // Nothing to ask about until a machine is chosen.
    expect(screen.queryByRole("checkbox", { name: "Turn on its MCP server" })).toBeNull();
    fireEvent.click(old);
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
    fireEvent.click(screen.getByRole("radio", { name: "New machine" }));
    expect(checked()).toBe("false");
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
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

/** Agent 37's shape: reached only through its own command, which the person installs. */
function tunnelled(id = "agent37", name = "Agent 37", command = "agent37"): CloudProviderInfo {
  const info = provider(id, name, NONE);
  return {
    ...info,
    capabilities: {
      ...info.capabilities,
      sshTrust: "provider-tunnel",
      transport: "provider-command",
      tunnel: { command, args: ["tunnel", "%h"], installUrl: `https://${id}.example/cli` },
    },
  };
}

const tunnelNote = (state: string) => screen.queryByTestId(`add-cloud-host-tunnel-${state}`);

describe("AddCloudHostDialog finding the tunnel's command (#18180)", () => {
  it("won't create until the command is found here, offering Get and Check again", async () => {
    const first = deferred<{ command: string; found: boolean }>();
    client.findTunnel.mockReturnValueOnce(first.promise);
    open(tunnelled(), catalog());
    await screen.findByText(/Default ·/);
    expect(client.findTunnel).toHaveBeenCalledWith("agent37");
    expect(tunnelNote("checking")?.textContent).toBe("Looking for agent37 on this device…");
    expect(createButton().getAttribute("aria-disabled")).toBe("true");

    first.resolve({ command: "agent37", found: false });
    const missing = await screen.findByTestId("add-cloud-host-tunnel-missing");
    expect(missing.textContent).toContain("isn't installed on this device");
    expect(missing.textContent).toContain("sign in to it");
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(createButton());
    expect(client.createHost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Get agent37" }));
    expect(openExternal).toHaveBeenCalledWith("https://agent37.example/cli");

    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: true });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect((await screen.findByTestId("add-cloud-host-tunnel-found")).textContent).toContain(
      "has to be signed in"
    );
    expect(tunnelNote("missing")).toBeNull();
    expect(client.findTunnel).toHaveBeenCalledTimes(2);
    expect((await create()).accountId).toBe("ca_0123456789");
  });

  it("says a lookup that failed, rather than asking for an install, and looks again", async () => {
    client.findTunnel.mockRejectedValueOnce(
      Object.assign(new Error("slow"), {
        name: "AppError",
        code: "INTERNAL",
        userMessage: "Daintree couldn't finish looking for agent37 on this device's PATH.",
      })
    );
    open(tunnelled(), catalog());
    expect((await screen.findByTestId("add-cloud-host-tunnel-failed")).textContent).toContain(
      "couldn't finish looking for agent37"
    );
    expect(screen.queryByRole("button", { name: "Get agent37" })).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: true });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByTestId("add-cloud-host-tunnel-found");
    await create();
  });

  it("keeps an answer about one provider's command away from another's", async () => {
    const acme = tunnelled("acme.clouds.tunnel", "Acme", "acme");
    const slow = deferred<{ command: string; found: boolean }>();
    client.findTunnel.mockImplementation((id: string) =>
      id === "agent37" ? slow.promise : Promise.resolve({ command: "acme", found: false })
    );
    cloud.snapshot = {
      providers: [tunnelled(), acme],
      accounts: [account("agent37"), account(acme.id, "ca_abcdefghij", "Team")],
      hosts: [],
    };
    // Each account's own sizes, so only the tunnel answer can hold Create back.
    client.getCatalog.mockImplementation(async (id: string) => catalog({ accountId: id }));
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await choose(screen.getAllByRole("combobox")[0]!, /^Team/);
    await screen.findByTestId("add-cloud-host-tunnel-missing");
    // Agent 37's answer lands after the switch: it says nothing of acme.
    slow.resolve({ command: "agent37", found: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tunnelNote("missing")?.textContent).toContain("acme command");
    expect(tunnelNote("found")).toBeNull();
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("looks again after a create main refused, keeping main's words", async () => {
    client.findTunnel.mockResolvedValue({ command: "agent37", found: true });
    client.createHost.mockRejectedValueOnce(
      Object.assign(new Error("refused"), {
        name: "AppError",
        code: "VALIDATION",
        userMessage:
          "Agent 37 machines are reached through its agent37 command, which isn't installed.",
      })
    );
    open(tunnelled(), catalog());
    await screen.findByTestId("add-cloud-host-tunnel-found");
    client.findTunnel.mockResolvedValue({ command: "agent37", found: false });
    await create();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "reached through its agent37 command"
    );
    await screen.findByTestId("add-cloud-host-tunnel-missing");
    expect(client.findTunnel).toHaveBeenCalledTimes(2);
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("asks again, rather than trusting an earlier answer, on coming back to a provider", async () => {
    const acme = tunnelled("acme.clouds.tunnel", "Acme", "acme");
    const again = deferred<{ command: string; found: boolean }>();
    client.findTunnel
      .mockResolvedValueOnce({ command: "agent37", found: true })
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(again.promise);
    cloud.snapshot = {
      providers: [tunnelled(), acme],
      accounts: [account("agent37"), account(acme.id, "ca_abcdefghij", "Team")],
      hosts: [],
    };
    client.getCatalog.mockImplementation(async (id: string) => catalog({ accountId: id }));
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await screen.findByTestId("add-cloud-host-tunnel-found");
    await choose(screen.getAllByRole("combobox")[0]!, /^Team/);
    await screen.findByTestId("add-cloud-host-tunnel-checking");
    await choose(screen.getAllByRole("combobox")[0]!, /^Personal/);
    await waitFor(() => expect(client.findTunnel).toHaveBeenCalledTimes(3));
    // Agent 37 was found a moment ago; that says nothing of now.
    expect(tunnelNote("checking")).toBeTruthy();
    expect(tunnelNote("found")).toBeNull();
    await screen.findByText(/Default ·/);
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    again.resolve({ command: "agent37", found: true });
    await screen.findByTestId("add-cloud-host-tunnel-found");
    await waitFor(() => expect(createButton().getAttribute("aria-disabled")).toBeNull());
  });

  it("asks again for another account on the same provider", async () => {
    const again = deferred<{ command: string; found: boolean }>();
    client.findTunnel
      .mockResolvedValueOnce({ command: "agent37", found: true })
      .mockReturnValueOnce(again.promise);
    cloud.snapshot = {
      providers: [tunnelled()],
      accounts: [account("agent37"), account("agent37", "ca_abcdefghij", "Team")],
      hosts: [],
    };
    client.getCatalog.mockImplementation(async (id: string) => catalog({ accountId: id }));
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await screen.findByTestId("add-cloud-host-tunnel-found");
    await choose(screen.getAllByRole("combobox")[0]!, "Team");
    await screen.findByTestId("add-cloud-host-tunnel-checking");
    expect(client.findTunnel).toHaveBeenCalledTimes(2);
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("says the provider changed when main answers about another declaration", async () => {
    client.findTunnel.mockResolvedValueOnce({ command: "agent37-next", found: true });
    open(tunnelled(), catalog());
    expect((await screen.findByTestId("add-cloud-host-tunnel-failed")).textContent).toContain(
      "Agent 37 changed while Daintree looked for agent37"
    );
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    cleanup();
    client.findTunnel.mockResolvedValueOnce(null);
    open(tunnelled(), catalog());
    await screen.findByTestId("add-cloud-host-tunnel-failed");
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Check again in place, busy, while it looks", async () => {
    const again = deferred<{ command: string; found: boolean }>();
    client.findTunnel
      .mockResolvedValueOnce({ command: "agent37", found: false })
      .mockReturnValueOnce(again.promise);
    open(tunnelled(), catalog());
    await screen.findByTestId("add-cloud-host-tunnel-missing");
    expect(screen.getByTestId("add-cloud-host-tunnel").getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(client.findTunnel).toHaveBeenCalledTimes(2));
    const button = screen.getByRole("button", { name: "Check again" });
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(createButton().getAttribute("aria-disabled")).toBe("true");
    again.resolve({ command: "agent37", found: false });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Check again" }).getAttribute("aria-busy")
      ).toBeNull()
    );
    expect(tunnelNote("missing")).toBeTruthy();
  });

  it("looks for nothing on a provider reached directly", async () => {
    open(provider("boat", "Boat", NONE), catalog());
    await create();
    expect(client.findTunnel).not.toHaveBeenCalled();
    expect(tunnelNote("checking")).toBeNull();
  });

  it("looks for nothing while adding an existing machine, and again on coming back", async () => {
    client.findTunnel.mockResolvedValue({ command: "agent37", found: true });
    open(tunnelled(), catalog());
    await screen.findByTestId("add-cloud-host-tunnel-found");
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    await screen.findByText(/has no machines yet/);
    expect(tunnelNote("found")).toBeNull();
    expect(client.findTunnel).toHaveBeenCalledTimes(1);
    const again = deferred<{ command: string; found: boolean }>();
    client.findTunnel.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole("radio", { name: "New machine" }));
    await screen.findByTestId("add-cloud-host-tunnel-checking");
    expect(tunnelNote("found")).toBeNull();
    expect(client.findTunnel).toHaveBeenCalledTimes(2);
    again.resolve({ command: "agent37", found: true });
    await screen.findByTestId("add-cloud-host-tunnel-found");
  });
});

describe("AddCloudHostDialog showing the tunnel's setup lines (#18181)", () => {
  const declared = () => {
    const info = tunnelled();
    info.capabilities.tunnel = {
      ...info.capabilities.tunnel!,
      installCommand: "npm install -g agent37",
      signInCommand: "agent37 ssh setup",
    };
    return info;
  };

  afterEach(() => {
    placement.current = { ready: false };
  });

  it("offers both lines where the command is missing, and the sign-in line once it's found", async () => {
    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: false });
    open(declared(), catalog());
    const missing = await screen.findByTestId("add-cloud-host-tunnel-missing");
    expect(missing.textContent).toContain("Install agent37 on this device");
    expect(missing.textContent).toContain("npm install -g agent37");
    expect(missing.textContent).toContain("Then sign in to agent37 on this device");
    expect(missing.textContent).toContain("agent37 ssh setup");
    // The install line stands in for the page; Check again stays.
    expect(screen.queryByRole("button", { name: "Get agent37" })).toBeNull();
    // No grid to open a terminal in: copy only.
    expect(screen.queryByLabelText("Open command in a new terminal")).toBeNull();
    expect(screen.getAllByLabelText("Copy command to clipboard")).toHaveLength(2);

    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: true });
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByTestId("add-cloud-host-tunnel-found");
    expect(screen.queryByTestId("tunnel-install-command")).toBeNull();
    const signIn = screen.getByTestId("tunnel-sign-in-command");
    expect(signIn.textContent).toContain("Sign in to agent37 on this device");
    expect(signIn.textContent).toContain("agent37 ssh setup");
    expect(signIn.textContent).not.toContain("npm install");
  });

  it("hands a line to a terminal only through Settings closing over the grid", async () => {
    placement.current = { ready: true, cwd: "/home/u", worktreeId: "wt" };
    const order: string[] = [];
    const handoff = vi.fn((_open: () => void) => order.push("handoff"));
    const onClose = vi.fn(() => order.push("dismissed"));
    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: false });
    cloud.snapshot = { providers: [declared()], accounts: [account("agent37")], hosts: [] };
    client.getCatalog.mockResolvedValue(catalog());
    render(
      <InstallCommandHandoffContext.Provider value={handoff}>
        <AddCloudHostDialog isOpen onClose={onClose} onReady={() => {}} />
      </InstallCommandHandoffContext.Provider>
    );
    const install = await screen.findByTestId("tunnel-install-command");
    fireEvent.click(within(install).getByLabelText("Open command in a new terminal"));
    // Out of the way first, so a close Settings holds shows why, and nothing starts meanwhile.
    expect(order).toEqual(["dismissed", "handoff"]);
    expect(handoff.mock.calls[0]![0]).toEqual(expect.any(Function));
  });

  it("stays copy-only without a Settings close to hand off to", async () => {
    placement.current = { ready: true, cwd: "/home/u", worktreeId: "wt" };
    client.findTunnel.mockResolvedValueOnce({ command: "agent37", found: false });
    open(declared(), catalog());
    await screen.findByTestId("tunnel-install-command");
    // A dialog covers the grid, so a terminal opened behind it couldn't be typed into.
    expect(screen.queryByLabelText("Open command in a new terminal")).toBeNull();
  });

  it("names the setup lines once the machine's create was refused for the missing command", async () => {
    client.findTunnel.mockResolvedValue({ command: "agent37", found: true });
    cloud.snapshot = { providers: [declared()], accounts: [account("agent37")], hosts: [] };
    client.getCatalog.mockResolvedValue(catalog());
    // A fresh element each time, so a rerender reads the snapshot again.
    const dialog = () => <AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />;
    const view = render(dialog());
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await create();
    await screen.findByTestId("add-cloud-host-progress");
    const message =
      "Agent 37 machines are reached through its agent37 command, which isn't installed on this device.";
    const refused: CloudHostStatus = {
      hostId: "build",
      providerId: "agent37",
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
      lifetime: { kind: "idle-sleep", idleSeconds: 900 },
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      operation: null,
      lastError: { code: "ssh-tunnel-command-missing", message, at: 1 },
      observedAt: null,
      lastEndpoint: null,
      hostKeyFingerprint: null,
      hostKeyReview: null,
      keptRunningAt: null,
      asleep: false,
    };
    cloud.snapshot = { ...cloud.snapshot, hosts: [refused] };
    view.rerender(dialog());
    expect(screen.getByText(message)).toBeTruthy();
    expect(screen.getByTestId("tunnel-install-command").textContent).toContain(
      "npm install -g agent37"
    );
    expect(screen.getByTestId("tunnel-sign-in-command").textContent).toContain("agent37 ssh setup");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();

    // Refused for another reason: nothing about the command.
    cloud.snapshot = {
      ...cloud.snapshot,
      hosts: [{ ...refused, lastError: { code: "refused", message: "No capacity.", at: 2 } }],
    };
    view.rerender(dialog());
    expect(screen.getByText("No capacity.")).toBeTruthy();
    expect(screen.queryByTestId("tunnel-setup-commands")).toBeNull();
  });
});

describe("AddCloudHostDialog on an offer-based provider (#18231)", () => {
  const AKASH = (): CloudProviderInfo => ({
    ...provider("akash", "Akash", NONE),
    createMode: "offers",
  });
  const sizes = () =>
    catalog({
      machineTypes: [
        {
          id: "akash-4c-16g",
          label: "Small",
          vcpu: 4,
          memoryGB: 16,
          // A rate in the catalog is still no price: only an offer is.
          hourlyDollars: 0.05,
          available: true,
          reason: null,
        },
        {
          id: "akash-32c-128g",
          label: "Huge",
          vcpu: 32,
          memoryGB: 128,
          hourlyDollars: null,
          available: false,
          reason: "no bidder has run this size lately",
        },
      ],
    });
  const offerOf = (id: string, name: string, hourlyDollars: number) => ({
    id,
    hourlyDollars,
    bidder: { id: `akash1${id}`, name, region: "eu-west" },
    choosable: true as const,
    reason: null,
  });
  const order = (id = "dseq-1") => ({
    kind: "awaiting-offer" as const,
    order: { id },
    waitingSince: Date.now(),
    offers: [offerOf("a", "Europlots", 0.036), offerOf("b", "Hurricane", 0.05)],
    offersReadAt: Date.now(),
  });
  function hostStatus(overrides: Partial<CloudHostStatus> = {}): CloudHostStatus {
    return {
      hostId: "h-123",
      providerId: "akash",
      providerUnavailable: null,
      accountId: "ca_0123456789",
      accountName: "Personal",
      resourceId: null,
      machineName: "build-host",
      ownership: "created-by-daintree",
      createdFor: null,
      worktreeCleanup: null,
      provisioning: null,
      machine: "not-created",
      rawState: null,
      machineType: "akash-4c-16g",
      vcpu: 4,
      memoryGB: 16,
      hourlyDollars: null,
      lifetime: { kind: "none" },
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      operation: null,
      pendingCreate: order(),
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
  const getOffers = () => screen.getByRole("button", { name: "Get offers" });
  const describedBy = (input: HTMLElement) =>
    document.getElementById(input.getAttribute("aria-describedby") ?? "")?.textContent ?? null;

  /** Ordered from the dialog, under an id that differs from the name it was given. */
  async function ordered(onClose = vi.fn(), onReady = vi.fn()) {
    client.createHost.mockResolvedValue({ hostId: "h-123" });
    cloud.snapshot = { providers: [AKASH()], accounts: [account("akash")], hosts: [] };
    client.getCatalog.mockResolvedValue(sizes());
    // A fresh element each time, so a rerender reads the snapshot again.
    const dialog = () => <AddCloudHostDialog isOpen onClose={onClose} onReady={onReady} />;
    const view = render(dialog());
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), {
      target: { value: "build-host" },
    });
    await waitFor(() => expect(getOffers().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(getOffers());
    await screen.findByTestId("add-cloud-host-progress");
    const show = (statuses: CloudHostStatus[], accounts = cloud.snapshot.accounts) => {
      cloud.snapshot = { ...cloud.snapshot, accounts, hosts: statuses };
      view.rerender(dialog());
    };
    return { show, onClose, onReady };
  }

  it("prices no size before the order, says where the price comes from, and asks for offers", async () => {
    cloud.snapshot = { providers: [AKASH()], accounts: [account("akash")], hosts: [] };
    client.getCatalog.mockResolvedValue(sizes());
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    const small = await screen.findByRole("radio", { name: "Small · 4 vCPU · 16 GB" });
    expect(describedBy(small)).toBeNull();
    expect(small.closest("fieldset")!.textContent).not.toContain("$");
    expect(screen.getByTestId("add-cloud-host-offer-pricing").textContent).toContain(
      "Akash's bidders quote one in their offers"
    );
    // A size that can't be ordered still says why, and still can't be picked.
    const huge = screen.getByRole("radio", { name: "Huge · 32 vCPU · 128 GB" }) as HTMLInputElement;
    expect(huge.disabled).toBe(true);
    expect(describedBy(huge)).toBe("No bidder has run this size lately");
    const review = screen.getByTestId("add-cloud-host-review").textContent ?? "";
    expect(review).not.toContain("$");
    expect(review).toContain("at the price of the offer you lease");
    expect(screen.queryByRole("button", { name: "Create and connect" })).toBeNull();
    await waitFor(() => expect(getOffers().getAttribute("aria-disabled")).toBeNull());
    fireEvent.click(getOffers());
    await waitFor(() => expect(client.createHost).toHaveBeenCalledTimes(1));
    expect(client.createHost.mock.calls[0]![0]).toMatchObject({
      accountId: "ca_0123456789",
      name: "build",
      machineType: "akash-4c-16g",
    });
  });

  it("keeps a list price and Create and connect for a provider that creates at once", async () => {
    open(provider("boat", "Boat", NONE), sizes());
    const small = await screen.findByRole("radio", { name: "Small · 4 vCPU · 16 GB" });
    expect(describedBy(small)).toBe("$0.050 an hour while running");
    expect(screen.getByTestId("add-cloud-host-review").textContent).toContain(
      "about $0.050 an hour while it runs"
    );
    expect(screen.queryByTestId("add-cloud-host-offer-pricing")).toBeNull();
    expect(screen.queryByRole("button", { name: "Get offers" })).toBeNull();
    expect(await create()).toMatchObject({ name: "build", machineType: "akash-4c-16g" });
  });

  it("shows the order's offers ahead of progress or a past error, and leases the one picked", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    const { show } = await ordered();
    show([
      hostStatus({
        // Pending with a create under way, and with an error from before: the choice wins.
        operation: { id: "op", kind: "creating", startedAt: 1, stage: "Asking Akash" },
        lastError: { code: "refused", message: "The last order was closed.", at: 1 },
      }),
    ]);
    expect(screen.getByTestId("add-cloud-host-offers")).toBeTruthy();
    expect(screen.queryByTestId("add-cloud-host-progress")).toBeNull();
    // A failed create's Retry would place another order beside this one.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByText("The last order was closed.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Hurricane" }));
    fireEvent.click(screen.getByRole("button", { name: "Lease offer" }));
    await waitFor(() =>
      expect(client.chooseOffer).toHaveBeenCalledWith("h-123", "dseq-1", "b", 0.05)
    );
    expect(client.chooseOffer).toHaveBeenCalledTimes(1);
  });

  it("keeps the order in view when its account drops out of the form's list", async () => {
    const { show } = await ordered();
    show(
      [hostStatus({ providerUnavailable: "Akash isn't available in this version of Daintree." })],
      [{ ...account("akash"), providerUnavailable: "Akash is gone" }]
    );
    expect(screen.getByTestId("add-cloud-host-offers")).toBeTruthy();
    expect(screen.getByText("Akash isn't available in this version of Daintree.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect .* account/ })).toBeNull();
  });

  it("starts a new order's choice afresh", async () => {
    const { show } = await ordered();
    show([hostStatus()]);
    fireEvent.click(screen.getByRole("radio", { name: "Europlots" }));
    show([hostStatus({ pendingCreate: order("dseq-2") })]);
    expect((screen.getByRole("radio", { name: "Europlots" }) as HTMLInputElement).checked).toBe(
      false
    );
    client.chooseOffer.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("radio", { name: "Europlots" }));
    fireEvent.click(screen.getByRole("button", { name: "Lease offer" }));
    await waitFor(() =>
      expect(client.chooseOffer).toHaveBeenCalledWith("h-123", "dseq-2", "a", 0.036)
    );
  });

  it("leaves the order open, and says where to find it by name, when closed mid-choice", async () => {
    const { show, onClose } = await ordered();
    show([hostStatus()]);
    expect(screen.getByTestId("add-cloud-host-offers").textContent).toContain(
      "choose an offer later in Settings → Hosts → build-host"
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(client.cancelOrder).not.toHaveBeenCalled();
  });

  it("says so when the host it was following is removed, rather than showing progress", async () => {
    const { show } = await ordered();
    // Not yet in the snapshot right after the order: that's progress, not a removal.
    expect(screen.queryByTestId("add-cloud-host-gone")).toBeNull();
    show([hostStatus()]);
    show([]);
    expect(screen.getByTestId("add-cloud-host-gone").textContent).toBe(
      "build-host is no longer in your host list."
    );
    expect(screen.queryByTestId("add-cloud-host-progress")).toBeNull();
    expect(screen.getByRole("button", { name: "Close" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("hands over to setup once, only after the leased machine runs with nothing under way", async () => {
    client.chooseOffer.mockResolvedValue(undefined);
    const { show, onReady } = await ordered();
    show([hostStatus()]);
    fireEvent.click(screen.getByRole("radio", { name: "Europlots" }));
    fireEvent.click(screen.getByRole("button", { name: "Lease offer" }));
    await waitFor(() => expect(client.chooseOffer).toHaveBeenCalledTimes(1));
    // Whatever else the snapshot says, a choice still waiting holds setup back.
    show([hostStatus({ resourceId: "dseq-1", machine: "running" })]);
    expect(onReady).not.toHaveBeenCalled();

    show([
      hostStatus({
        pendingCreate: null,
        resourceId: "dseq-1",
        machine: "running",
        operation: { id: "op", kind: "creating", startedAt: 1, stage: "Waiting for Akash" },
      }),
    ]);
    expect(screen.getByTestId("add-cloud-host-progress").textContent).toContain(
      "Waiting for Akash"
    );
    expect(screen.queryByTestId("add-cloud-host-offers")).toBeNull();
    expect(onReady).not.toHaveBeenCalled();

    show([hostStatus({ pendingCreate: null, resourceId: "dseq-1", machine: "starting" })]);
    expect(onReady).not.toHaveBeenCalled();
    // Running, but leased on terms nobody chose: the failure stays in view, and setup waits.
    const swapped = "The provider replaced its offer as it was leased.";
    show([
      hostStatus({
        pendingCreate: null,
        resourceId: "dseq-1",
        machine: "running",
        lastError: { code: "failed", message: swapped, at: 1 },
      }),
    ]);
    expect(screen.getByText(swapped)).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    show([hostStatus({ pendingCreate: null, resourceId: "dseq-1", machine: "running" })]);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({ hostId: "h-123", name: "build-host" });
    show([hostStatus({ pendingCreate: null, resourceId: "dseq-1", machine: "stopped" })]);
    show([hostStatus({ pendingCreate: null, resourceId: "dseq-1", machine: "running" })]);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe("AddCloudHostDialog on a provider that has no stop (#18229)", () => {
  const connectText = () => screen.getByText(/^Connect a cloud provider account first/).textContent;

  it("says an account creates and deletes machines, starting and stopping them only where a provider can", () => {
    cloud.snapshot = { providers: [DELETE_ONLY_PROVIDER], accounts: [], hosts: [] };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(connectText()).toContain("to create and delete machines;");
    cleanup();

    cloud.snapshot = {
      providers: [DELETE_ONLY_PROVIDER, provider("boat", "Boat", NONE)],
      accounts: [],
      hosts: [],
    };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(connectText()).toContain(
      "to create and delete machines, and to start and stop them where their provider can;"
    );
    cleanup();

    // One that stops but can't delete: delete is promised only where all of them can.
    const keeper = provider("keeper", "Keeper", NONE);
    cloud.snapshot = {
      providers: [
        DELETE_ONLY_PROVIDER,
        { ...keeper, capabilities: { ...keeper.capabilities, deletion: false } },
      ],
      accounts: [],
      hosts: [],
    };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(connectText()).toContain(
      "to create machines, and to start and stop them where their provider can;"
    );
    cleanup();

    // Every other list reads as it did.
    cloud.snapshot = { providers: [provider("boat", "Boat", NONE)], accounts: [], hosts: [] };
    render(<AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />);
    expect(connectText()).toContain("to create, start, stop and delete machines;");
  });

  it("says a new machine runs, and bills, until it's deleted, and what deleting it loses", async () => {
    open(DELETE_ONLY_PROVIDER, catalog());
    expect((await screen.findByTestId("add-cloud-host-lifetime-note")).textContent).toBe(
      "Leasy has no stop: a machine runs, and bills, until it's deleted."
    );
    const review = (await screen.findByTestId("add-cloud-host-review")).textContent ?? "";
    expect(review).toContain(
      "It runs, and bills, until it's deleted. Deleting it loses everything on it, its disk included."
    );
    expect(review).not.toMatch(/Stopping|kept for|at least 0 days|until you stop it/);
  });
  it("says the same in the review of an offer-based create", async () => {
    open({ ...DELETE_ONLY_PROVIDER, createMode: "offers" }, catalog());
    const review = (await screen.findByTestId("add-cloud-host-review")).textContent ?? "";
    expect(review).toContain("at the price of the offer you lease");
    expect(review).toContain(
      "It runs, and bills, until it's deleted. Deleting it loses everything on it, its disk included."
    );
    expect(screen.getByRole("button", { name: "Get offers" })).toBeTruthy();
  });

  it("adds an existing machine with its end said, and offers no Start once it's added", async () => {
    client.listResources.mockResolvedValue([
      {
        resourceId: "lease-9",
        name: "old",
        machine: "stopped",
        rawState: "closed",
        machineType: null,
        vcpu: 4,
        memoryGB: 8,
        createdAt: null,
        stoppedAt: null,
        dataExpired: false,
        boundHostId: null,
        restricted: false,
        asleep: false,
      } satisfies CloudResourceSummary,
    ]);
    client.importHost.mockResolvedValue({ hostId: "host-old" });
    cloud.snapshot = {
      providers: [DELETE_ONLY_PROVIDER],
      accounts: [account(DELETE_ONLY_PROVIDER.id)],
      hosts: [],
    };
    client.getCatalog.mockResolvedValue(catalog());
    const dialog = () => <AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />;
    const view = render(dialog());
    fireEvent.click(screen.getByRole("radio", { name: "Existing machine" }));
    fireEvent.click(await screen.findByRole("radio", { name: /^old/ }));
    expect(screen.getByTestId("add-cloud-host-import-note").textContent).toBe(
      "Adding it doesn't change it. Leasy has no stop: a machine runs, and bills, until it's deleted. Deleting it loses everything on it, its disk included."
    );
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
    await waitFor(() => expect(client.importHost).toHaveBeenCalledTimes(1));

    cloud.snapshot = {
      ...cloud.snapshot,
      hosts: [
        {
          hostId: "host-old",
          providerId: DELETE_ONLY_PROVIDER.id,
          providerUnavailable: null,
          accountId: "ca_0123456789",
          accountName: "Personal",
          resourceId: "lease-9",
          machineName: "old",
          ownership: "imported",
          createdFor: null,
          worktreeCleanup: null,
          provisioning: null,
          machine: "stopped",
          rawState: "closed",
          machineType: null,
          vcpu: 4,
          memoryGB: 8,
          hourlyDollars: 0.05,
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
        },
      ],
    };
    view.rerender(dialog());
    await waitFor(() =>
      expect(screen.getByTestId("add-cloud-host-progress").textContent).toBe(
        "It's in your host list. Its machine reports stopped, and machines on Leasy can't be started again. Deleting it loses everything on it, its disk included."
      )
    );
    expect(screen.queryByRole("button", { name: "Start machine" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Leave / })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(client.startHost).not.toHaveBeenCalled();
  });

  it("offers no Start for its machine once added, even after a failed create", async () => {
    const leasyStatus = (overrides: Partial<CloudHostStatus>): CloudHostStatus => ({
      hostId: "build",
      providerId: DELETE_ONLY_PROVIDER.id,
      providerUnavailable: null,
      accountId: "ca_0123456789",
      accountName: "Personal",
      resourceId: "lease-1",
      machineName: "build",
      ownership: "created-by-daintree",
      createdFor: null,
      worktreeCleanup: null,
      provisioning: null,
      machine: "error",
      rawState: "error",
      machineType: "default",
      vcpu: 2,
      memoryGB: 4,
      hourlyDollars: 0.05,
      lifetime: { kind: "none" },
      autoStopAt: null,
      lifetimeSeconds: null,
      stoppedAt: null,
      stop: null,
      lastSnapshotAt: null,
      dataExpired: false,
      operation: null,
      lastError: { code: "refused", message: "The container exited.", at: 1 },
      observedAt: Date.now(),
      lastEndpoint: null,
      hostKeyFingerprint: null,
      hostKeyReview: null,
      keptRunningAt: null,
      asleep: false,
      ...overrides,
    });
    cloud.snapshot = {
      providers: [DELETE_ONLY_PROVIDER],
      accounts: [account(DELETE_ONLY_PROVIDER.id)],
      hosts: [],
    };
    client.getCatalog.mockResolvedValue(catalog());
    const dialog = () => <AddCloudHostDialog isOpen onClose={() => {}} onReady={() => {}} />;
    const view = render(dialog());
    fireEvent.change(screen.getByTestId("add-cloud-host-name"), { target: { value: "build" } });
    await create();
    cloud.snapshot = { ...cloud.snapshot, hosts: [leasyStatus({})] };
    view.rerender(dialog());
    expect(await screen.findByText("The container exited.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start machine" })).toBeNull();

    cloud.snapshot = {
      ...cloud.snapshot,
      hosts: [leasyStatus({ machine: "stopped", lastError: null })],
    };
    view.rerender(dialog());
    // Settled, not coming up: no progress that would never end.
    expect(screen.getByTestId("add-cloud-host-progress").textContent).toContain(
      "can't be started again"
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start machine" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Leave / })).toBeNull();
    expect(client.startHost).not.toHaveBeenCalled();
  });
});
