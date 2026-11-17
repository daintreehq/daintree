import { describe, expect, it } from "vitest";
import type {
  CloudCatalog,
  CloudProviderInfo,
  CloudProvisioningChoice,
} from "@shared/types/cloudHosts";
import { startingSelection } from "../cloudProvisioningChoices";

const choice = (id: string, extra: Partial<CloudProvisioningChoice> = {}) => ({
  id,
  label: id,
  description: null,
  available: true,
  reason: null,
  locations: null,
  ...extra,
});

const provider = {
  name: "Acme",
  capabilities: {
    provisioning: {
      location: "required",
      image: "optional",
      network: "none",
      sshKey: "at-create",
    },
  },
} as unknown as CloudProviderInfo;

function catalog(): CloudCatalog {
  return {
    provisioning: {
      location: {
        label: "Region",
        defaultId: "nyc1",
        choices: [choice("nyc1"), choice("sfo3"), choice("lon1", { available: false })],
      },
      image: { label: "Image", defaultId: "ubuntu", choices: [choice("ubuntu"), choice("debian")] },
      network: null,
    },
  } as unknown as CloudCatalog;
}

describe("startingSelection", () => {
  it("passes over a remembered region that can't be used any more", () => {
    expect(
      startingSelection(provider, catalog(), [{ location: "lon1", image: "debian", network: null }])
    ).toEqual({ location: "nyc1", image: "debian", network: null });
  });

  it("keeps an optional dimension the person left to the provider", () => {
    expect(
      startingSelection(provider, catalog(), [{ location: "sfo3", image: null, network: null }])
    ).toEqual({ location: "sfo3", image: null, network: null });
  });

  it("prefers this dialog's picks over the account's last choice", () => {
    expect(
      startingSelection(provider, catalog(), [
        { location: "sfo3", image: "ubuntu", network: null },
        { location: "nyc1", image: "debian", network: null },
      ])
    ).toEqual({ location: "sfo3", image: "ubuntu", network: null });
  });

  it("never names a dimension the provider doesn't take", () => {
    expect(
      startingSelection(provider, catalog(), [{ location: "nyc1", image: null, network: "vpc" }])
        .network
    ).toBeNull();
  });
});
