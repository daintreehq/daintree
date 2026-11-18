// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudAccountSummary, CloudHostsSnapshot } from "@shared/types/cloudHosts";
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
    await waitFor(() =>
      expect(screen.queryByTestId("cloud-provider-consent-dialog")).toBeNull()
    );
    expect(client.allowAccountProvider).toHaveBeenCalledWith("ca_0123456789", "fp-2");
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
});
