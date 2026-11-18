import { describe, expect, it } from "vitest";
import type {
  CloudCatalog,
  CloudProviderInfo,
  CloudProvisioningChoice,
} from "@shared/types/cloudHosts";
import { startingSelection } from "../cloudProvisioningChoices";

const choice = (
  id: string,
  extra: Partial<CloudProvisioningChoice> = {}
): CloudProvisioningChoice => ({
  id,
  label: id,
  description: null,
  available: true,
  reason: null,
  locations: null,
  ...extra,
});

/** A region it always needs, an image it takes when asked, and no network at all. */
const provider: CloudProviderInfo = {
  id: "acme.clouds.droplets",
  name: "Acme",
  description: "",
  apiKeyUrl: "",
  dashboardUrl: "",
  docsUrl: "",
  credentialFields: [],
  capabilities: {
    persistence: {
      kept: "Files",
      lost: "memory",
      retentionDays: null,
      saveRetryBilled: false,
      stoppedComputeBilled: false,
      stoppedStorageBilled: false,
    },
    typicalStartSeconds: null,
    lifetime: { kind: "none" },
    sshTrust: "confirm-on-first-connect",
    transport: "direct",
    tunnel: null,
    provisioning: { location: "required", image: "optional", network: "none", sshKey: "at-create" },
    deletion: true,
  },
  unsupportedReason: null,
};

function catalog(): CloudCatalog {
  return {
    accountId: "ca_0123456789",
    machineTypes: [],
    provisioning: {
      location: {
        label: "Region",
        defaultId: "nyc1",
        choices: [choice("sfo3"), choice("nyc1"), choice("lon1", { available: false })],
      },
      image: { label: "Image", defaultId: "ubuntu", choices: [choice("debian"), choice("ubuntu")] },
      // Offered, though the provider says a create takes no network.
      network: { label: "VPC", defaultId: "vpc-1", choices: [choice("vpc-1")] },
    },
    lastChoice: null,
    canStart: true,
    includedHoursRemaining: null,
    startsRemaining: null,
    savedSnapshotDayDollars: null,
    fetchedAt: 1,
  };
}

describe("startingSelection", () => {
  it("starts from the provider's suggestions, optional ones included, never the first listed", () => {
    expect(startingSelection(provider, catalog(), [])).toEqual({
      location: "nyc1",
      image: "ubuntu",
      network: null,
    });
  });

  it("passes over a remembered region that can't be used, or isn't offered any more", () => {
    for (const location of ["lon1", "ams3"]) {
      expect(
        startingSelection(provider, catalog(), [{ location, image: "debian", network: null }])
      ).toEqual({ location: "nyc1", image: "debian", network: null });
    }
  });

  it("keeps an optional dimension the person left to the provider", () => {
    expect(
      startingSelection(provider, catalog(), [{ location: "sfo3", image: null, network: null }])
    ).toEqual({ location: "sfo3", image: null, network: null });
  });

  it("prefers this dialog's picks over the account's last choice", () => {
    expect(
      startingSelection(provider, catalog(), [
        { location: "sfo3", image: "debian", network: null },
        { location: "nyc1", image: "ubuntu", network: null },
      ])
    ).toEqual({ location: "sfo3", image: "debian", network: null });
  });

  it("never names a dimension the provider doesn't take, whatever the catalog lists", () => {
    expect(
      startingSelection(provider, catalog(), [{ location: "nyc1", image: null, network: "vpc-1" }])
        .network
    ).toBeNull();
  });
});
