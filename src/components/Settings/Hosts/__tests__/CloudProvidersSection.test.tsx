// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("@/clients/cloudHostsClient", () => ({
  cloudHostsClient: { validateAccount: vi.fn(), removeAccount: vi.fn() },
}));

import { CloudProvidersSection } from "../CloudProvidersSection";

/** A provider an installed plugin contributes. */
const PLUGIN = provider({ name: "Droplets" });

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
  it("connects straight to Daintree's own provider, never offering a plugin's", () => {
    cloud.snapshot = { providers: [PLUGIN, BOAT_PROVIDER], accounts: [account()], hosts: [] };
    render(<CloudProvidersSection />);
    // One provider to connect is a button, not a menu naming the plugin's too.
    const connect = screen.getByTestId("cloud-connect-account");
    expect(connect.getAttribute("aria-haspopup")).toBeNull();
    fireEvent.click(connect);
    expect(screen.getByText("Connect Boat account")).toBeTruthy();
    expect(screen.queryByText("Connect Droplets account")).toBeNull();
  });

  it("offers no Connect when only a plugin's provider is there", () => {
    cloud.snapshot = { providers: [PLUGIN], accounts: [], hosts: [] };
    render(<CloudProvidersSection />);
    expect(screen.queryByTestId("cloud-connect-account")).toBeNull();
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
