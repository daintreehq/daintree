import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: true, getPath: () => "/nonexistent/daintree-cloud-init-test" },
}));
// The keychain is never touched before an account is connected; this keeps its store out of the test.
vi.mock("../CloudCredentialVault.js", () => ({ KeychainCloudCredentialVault: class {} }));

import { initCloudHosts } from "../initCloudHosts.js";
import {
  clearPluginCloudProviders,
  publishPluginCloudProviders,
  withdrawPluginCloudProviders,
} from "../../../services/plugin/pluginCloudProviders.js";
import type { CloudProviderContribution } from "../../../../shared/types/pluginCloudProvider.js";

afterEach(() => clearPluginCloudProviders());

function ec2(name = "EC2"): CloudProviderContribution {
  return {
    id: "ec2",
    name,
    description: "Machines on your AWS account.",
    apiUrl: "https://ec2.example.com",
    apiKeyUrl: "https://console.example.com/keys",
    dashboardUrl: "https://console.example.com/ec2",
    docsUrl: "https://docs.example.com",
    credentialFields: [
      { id: "key", label: "Key", secret: true, input: "single-line", required: true, help: null },
    ],
    capabilities: {
      persistence: {
        kept: "Its disk",
        lost: "Memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: false,
        stoppedStorageBilled: true,
      },
      typicalStartSeconds: 90,
      lifetime: { kind: "none" },
      sshTrust: "confirm-on-first-connect",
      transport: "direct",
      tunnel: null,
      provisioning: { location: "none", image: "none", network: "none", sshKey: "at-create" },
      deletion: true,
    },
  };
}

function pluginAccount(apiUrl = "https://ec2.example.com") {
  return {
    id: "ca_acmeplugin1",
    providerId: "acme.clouds.ec2",
    displayName: "Work",
    identity: null,
    scope: { kind: "personal", id: "personal", name: "Personal" },
    apiUrl,
    keyHint: null,
    credentialRevision: "rev-1",
    addedAt: 1,
    validation: { status: "valid", checkedAt: 1 },
    lastProvisioning: null,
  };
}

describe("initCloudHosts", () => {
  it("offers Google Cloud beside Boat, pinned to Google's own API in a packaged build", () => {
    let stored: unknown;
    const runtime = initCloudHosts({
      backend: {
        get: () => stored,
        set: (_key, value) => {
          stored = value;
        },
      },
      emit: vi.fn(),
    });
    try {
      const offered = runtime.cloudHosts.snapshot().providers.map((provider) => provider.name);
      expect(offered).toEqual(expect.arrayContaining(["Boat", "Google Cloud"]));
      expect(new URL(runtime.providers.apiUrlFor("gce")!).origin).toBe(
        "https://compute.googleapis.com"
      );
      // Nothing was asked of any provider, and nothing written, before an account exists.
      expect(stored).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it("names a plugin's provider on its accounts at startup and whenever it registers again (#17353)", () => {
    let stored: unknown = {
      version: 1,
      accounts: [pluginAccount(), pluginAccount("https://elsewhere.example.com")].map(
        (account, index) => ({ ...account, id: `ca_acmeplugin${index + 1}` })
      ),
      bindings: [],
    };
    const label = () =>
      (stored as { accounts: Array<{ id: string; pluginProvider?: unknown }> }).accounts.map(
        (account) => account.pluginProvider ?? null
      );
    // Already loaded when the cloud side starts: named straight away.
    publishPluginCloudProviders("acme.clouds", [ec2()], "Acme Clouds");
    const runtime = initCloudHosts({
      backend: {
        get: () => stored,
        set: (_key, value) => {
          stored = JSON.parse(JSON.stringify(value));
        },
      },
      emit: vi.fn(),
    });
    try {
      const first = {
        pluginName: "Acme Clouds",
        providerName: "EC2",
        dashboardUrl: "https://console.example.com/ec2",
      };
      // Only the account connected against the origin the provider registered at is spoken for.
      expect(label()).toEqual([first, null]);
      withdrawPluginCloudProviders("acme.clouds");
      expect(label()).toEqual([first, null]);
      publishPluginCloudProviders("acme.clouds", [ec2("EC2 Classic")], "Acme Clouds");
      expect(label()).toEqual([{ ...first, providerName: "EC2 Classic" }, null]);
    } finally {
      runtime.dispose();
    }
  });

  it("starts with a plugin's provider already loaded even when its label can't be written", () => {
    const stored = { version: 1, accounts: [pluginAccount()], bindings: [] };
    publishPluginCloudProviders("acme.clouds", [ec2()], "Acme Clouds");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = initCloudHosts({
      backend: {
        get: () => JSON.parse(JSON.stringify(stored)),
        set: () => {
          throw new Error("disk full");
        },
      },
      emit: vi.fn(),
    });
    try {
      expect(runtime.providers.has("acme.clouds.ec2")).toBe(true);
      expect(runtime.cloudHosts.snapshot().accounts).toEqual([
        expect.objectContaining({ id: "ca_acmeplugin1", providerUnavailable: null }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't keep what acme.clouds.ec2 is called"),
        expect.any(Error)
      );
    } finally {
      warn.mockRestore();
      runtime.dispose();
    }
  });
});
