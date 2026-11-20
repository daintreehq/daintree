// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  CloudAccountSummary,
  CloudHostStatus,
  CloudHostsSnapshot,
} from "@shared/types/cloudHosts";
import { BOAT_PROVIDER, provider } from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

const { cloud } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({
    snapshot: cloud.snapshot,
    loaded: true,
    loadError: null,
    refresh: vi.fn(),
  }),
}));
const { client } = vi.hoisted(() => ({
  client: { validateAccount: vi.fn(), removeAccount: vi.fn(), allowAccountProvider: vi.fn() },
}));
vi.mock("@/clients/cloudHostsClient", () => ({ cloudHostsClient: client }));
vi.mock("@/clients/systemClient", () => ({ systemClient: { openExternal: vi.fn() } }));

import { systemClient } from "@/clients/systemClient";
import { CloudProvidersSection } from "../CloudProvidersSection";

/** A provider an installed plugin contributes, as its plugin is declared now. */
function pluginProvider(granted: boolean, fingerprint = "fp-1") {
  return {
    ...provider({ name: "Droplets" }),
    plugin: {
      pluginId: "acme.droplets",
      pluginName: "Acme Droplets",
      fingerprint,
      granted,
      providerNames: ["Droplets"],
    },
  };
}
const PLUGIN = pluginProvider(true);

function account(overrides: Partial<CloudAccountSummary> = {}): CloudAccountSummary {
  return {
    id: "ca_0123456789",
    providerId: PLUGIN.id,
    providerUnavailable: null,
    displayName: "Team droplets",
    identity: null,
    billingScope: { kind: "personal", id: "personal", name: "Personal" },
    validation: { status: "valid", checkedAt: 1 },
    hostCount: 0,
    addedAt: 1,
    keyHint: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CloudProvidersSection", () => {
  it("offers a plugin's provider for a new account, asking its consent first", () => {
    cloud.snapshot = { providers: [pluginProvider(false)], accounts: [], hosts: [] };
    render(<CloudProvidersSection />);
    fireEvent.click(screen.getByTestId("cloud-connect-account"));
    const consent = screen.getByTestId("cloud-provider-consent-dialog");
    expect(consent.textContent).toContain("Acme Droplets");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull();
    expect(screen.queryByTestId("connect-cloud-account-dialog")).toBeNull();
  });

  it("offers a choice of providers, a plugin's among them, once there are several", () => {
    cloud.snapshot = { providers: [PLUGIN, BOAT_PROVIDER], accounts: [account()], hosts: [] };
    render(<CloudProvidersSection />);
    expect(screen.getByTestId("cloud-connect-account").getAttribute("aria-haspopup")).toBe("menu");
  });

  it("lets the person review a paused account's plugin, and allows exactly what it declares now", async () => {
    client.allowAccountProvider.mockResolvedValue(account());
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2")],
      accounts: [
        account({
          providerUnavailable:
            "Its cloud provider comes from the Acme Droplets plugin, which changed what it asks for or does since you allowed it.",
        }),
      ],
      hosts: [],
    };
    render(<CloudProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review access for Team droplets" }));
    expect(screen.getByTestId("cloud-provider-consent-dialog").textContent).toContain(
      "stay paused until you allow it"
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull());
    expect(client.allowAccountProvider).toHaveBeenCalledWith("ca_0123456789", "fp-2");
  });

  it("keeps the review open with what went wrong, and lets it be tried again", async () => {
    client.allowAccountProvider
      .mockRejectedValueOnce(
        Object.assign(new Error("changed"), {
          name: "AppError",
          code: "PERMISSION",
          userMessage: "The Acme Droplets plugin changed what its cloud providers ask for or do.",
        })
      )
      .mockResolvedValueOnce(account());
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2")],
      accounts: [account({ providerUnavailable: "Paused" })],
      hosts: [],
    };
    render(<CloudProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review access for Team droplets" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() =>
      expect(screen.getByTestId("cloud-provider-consent-dialog").textContent).toContain(
        "changed what its cloud providers ask for"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    await waitFor(() => expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull());
    expect(client.allowAccountProvider).toHaveBeenCalledTimes(2);
  });

  it("leaves a later review alone when an earlier Allow answers", async () => {
    let answer: (value: CloudAccountSummary) => void = () => {};
    client.allowAccountProvider.mockImplementationOnce(
      () => new Promise<CloudAccountSummary>((resolve) => (answer = resolve))
    );
    const other = {
      ...pluginProvider(false, "fp-9"),
      id: "acme.boxes.boxes",
      name: "Boxes",
      plugin: {
        ...pluginProvider(false, "fp-9").plugin,
        pluginId: "acme.boxes",
        pluginName: "Acme Boxes",
      },
    };
    const boxes = account({
      id: "ca_boxes00001",
      providerId: other.id,
      displayName: "Boxes",
      providerUnavailable: "Paused",
    });
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2"), other],
      accounts: [account({ providerUnavailable: "Paused" }), boxes],
      hosts: [],
    };
    const { rerender } = render(<CloudProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review access for Team droplets" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
    // Allowed, as another window sees it, before this one's answer arrives.
    cloud.snapshot = {
      providers: [pluginProvider(true, "fp-2"), other],
      accounts: [account(), boxes],
      hosts: [],
    };
    rerender(<CloudProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review access for Boxes" }));
    expect(screen.getByTestId("cloud-provider-consent-dialog").textContent).toContain("Acme Boxes");
    answer(account());
    await waitFor(() => expect(client.allowAccountProvider).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("cloud-provider-consent-dialog").textContent).toContain("Acme Boxes");
  });

  it("ends a review once its account is gone", () => {
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2")],
      accounts: [account({ providerUnavailable: "Paused" })],
      hosts: [],
    };
    const { rerender } = render(<CloudProvidersSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review access for Team droplets" }));
    expect(screen.getByTestId("cloud-provider-consent-dialog")).toBeTruthy();
    // Removed in another window.
    cloud.snapshot = { providers: [pluginProvider(false, "fp-2")], accounts: [], hosts: [] };
    rerender(<CloudProvidersSection />);
    expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull();
    // Back again, the review doesn't reopen unasked.
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2")],
      accounts: [account({ providerUnavailable: "Paused" })],
      hosts: [],
    };
    rerender(<CloudProvidersSection />);
    expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull();
  });

  it("offers no review for an account whose plugin is allowed", () => {
    cloud.snapshot = { providers: [PLUGIN], accounts: [account()], hosts: [] };
    render(<CloudProvidersSection />);
    expect(screen.queryByRole("button", { name: /Review access/ })).toBeNull();
  });

  it("says on the account why its provider can't be used", () => {
    cloud.snapshot = {
      providers: [BOAT_PROVIDER],
      accounts: [
        account({
          providerUnavailable:
            "Its cloud provider comes from the acme.droplets plugin, which is turned off. Turn it on in Settings → Plugins.",
        }),
      ],
      hosts: [],
    };
    render(<CloudProvidersSection />);
    expect(screen.getByRole("alert").textContent).toContain(
      "acme.droplets plugin, which is turned off"
    );
  });

  it("names a gone plugin's provider, lists its machines as last seen, and links its console (#17353)", () => {
    const now = Date.now();
    const host = (overrides: Partial<CloudHostStatus>) =>
      ({
        hostId: "host-1",
        providerId: PLUGIN.id,
        providerUnavailable:
          "Its cloud provider comes from the acme.droplets plugin, which isn't installed.",
        accountId: "ca_0123456789",
        machineName: "build",
        machine: "running",
        operation: null,
        dataExpired: false,
        asleep: false,
        lastError: null,
        observedAt: now - 2 * 60 * 60_000,
        ...overrides,
      }) as CloudHostStatus;
    cloud.snapshot = {
      providers: [BOAT_PROVIDER],
      accounts: [
        account({
          providerUnavailable:
            "Its cloud provider comes from the acme.droplets plugin, which isn't installed.",
          pluginProvider: {
            pluginName: "Acme Droplets",
            providerName: "Droplets",
            dashboardUrl: "https://cloud.example.com/droplets",
          },
          hostCount: 2,
        }),
      ],
      hosts: [
        host({}),
        host({ hostId: "host-2", machineName: "spare", machine: "stopped", observedAt: null }),
        // Another account's machine is never listed under this one.
        host({ hostId: "host-3", accountId: "ca_9999999999", machineName: "theirs" }),
      ],
    };
    render(<CloudProvidersSection />);
    expect(screen.getByText(/Droplets from the Acme Droplets plugin/)).toBeTruthy();
    const machines = screen.getByRole("list", { name: "Machines on Team droplets" });
    const rows = [...machines.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/build.*Running.*Last checked/);
    expect(rows[1]).toMatch(/spare.*Stopped.*Never checked/);
    // Nothing can check credentials without the provider: its console can still show the machines.
    expect(screen.queryByRole("button", { name: "Check Team droplets" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Droplets console" }));
    expect(systemClient.openExternal).toHaveBeenCalledWith("https://cloud.example.com/droplets");
  });

  it("reads what the provider last said, and offers neither Check nor a console it doesn't know", () => {
    const unavailable =
      "Its cloud provider comes from the acme.droplets plugin, which is turned off.";
    cloud.snapshot = {
      providers: [BOAT_PROVIDER],
      accounts: [account({ providerUnavailable: unavailable, hostCount: 2 })],
      hosts: [
        {
          hostId: "host-1",
          providerId: PLUGIN.id,
          providerUnavailable: unavailable,
          accountId: "ca_0123456789",
          machineName: "build",
          machine: "running",
          // A stop this device was in the middle of: not something the provider said.
          operation: { id: "op-1", kind: "stopping", startedAt: 1, stage: "Stopping" },
          dataExpired: false,
          asleep: false,
          lastError: null,
          observedAt: 0,
        } as CloudHostStatus,
      ],
    };
    render(<CloudProvidersSection />);
    // No label kept: the provider goes by its id.
    expect(screen.getByText(new RegExp(PLUGIN.id.replace(/\./g, "\\.")))).toBeTruthy();
    const row = screen.getByRole("list", { name: "Machines on Team droplets" }).textContent;
    expect(row).toMatch(/build.*Running.*Check time unknown/);
    expect(screen.queryByRole("button", { name: "Check Team droplets" })).toBeNull();
    expect(screen.queryByRole("button", { name: /console/ })).toBeNull();
  });

  it("treats an account paused for review as its provider still there, not gone", () => {
    cloud.snapshot = {
      providers: [pluginProvider(false, "fp-2")],
      accounts: [
        account({
          providerUnavailable: "Paused",
          pluginProvider: {
            pluginName: "Acme Droplets",
            providerName: "Droplets",
            dashboardUrl: "https://cloud.example.com/droplets",
          },
          hostCount: 1,
        }),
      ],
      hosts: [{ hostId: "host-1", accountId: "ca_0123456789" } as CloudHostStatus],
    };
    render(<CloudProvidersSection />);
    expect(screen.getByRole("button", { name: "Review access for Team droplets" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check Team droplets" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Machines on Team droplets" })).toBeNull();
    expect(screen.queryByRole("button", { name: /console/ })).toBeNull();
  });

  it("lists no machines and links no console while the provider is there", () => {
    cloud.snapshot = {
      providers: [PLUGIN],
      accounts: [
        account({
          pluginProvider: {
            pluginName: "Acme Droplets",
            providerName: "Droplets",
            dashboardUrl: "https://cloud.example.com/droplets",
          },
          hostCount: 1,
        }),
      ],
      hosts: [{ hostId: "host-1", accountId: "ca_0123456789" } as CloudHostStatus],
    };
    render(<CloudProvidersSection />);
    expect(screen.queryByRole("list", { name: "Machines on Team droplets" })).toBeNull();
    expect(screen.queryByRole("button", { name: /console/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Check Team droplets" })).toBeTruthy();
  });
});
