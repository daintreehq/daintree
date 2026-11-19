import type { CloudLifetimeModel, CloudProviderInfo } from "@shared/types/cloudHosts";

/**
 * Boat as `BoatProvider.info()` declares it; `boat.test.ts` pins the
 * declaration's stop billing and deletion so these stay honest.
 */
export const BOAT_PROVIDER: CloudProviderInfo = {
  id: "boat",
  name: "Boat",
  description: "On-demand Ubuntu machines that stop when idle and resume with their disk.",
  apiKeyUrl: "https://boat.dev/dashboard?tab=api-keys",
  dashboardUrl: "https://boat.dev/dashboard",
  docsUrl: "https://docs.boat.dev",
  credentialFields: [],
  capabilities: {
    persistence: {
      kept: "Files in its home folder",
      lost: "/tmp, caches and memory",
      retentionDays: 14,
      saveRetryBilled: false,
      stoppedComputeBilled: false,
      stoppedStorageBilled: false,
    },
    typicalStartSeconds: 60,
    lifetime: { kind: "renewable" },
    sshTrust: "pinned-from-api",
    transport: "direct",
    tunnel: null,
    provisioning: { location: "none", image: "none", network: "none", sshKey: "after-create" },
    deletion: true,
  },
  unsupportedReason: null,
  hostIdleStop: true,
};

/**
 * A provider shaped like the one the declarations exist for: a plugin's, so
 * its hosts have no way to stop a machine once idle, and a stopped machine
 * still bills.
 */
export function provider(
  overrides: {
    stoppedComputeBilled?: boolean;
    stoppedStorageBilled?: boolean;
    stoppedBilling?: string;
    deletion?: boolean;
    name?: string;
    lifetime?: CloudLifetimeModel;
    hostIdleStop?: boolean;
    sleepsWhenHostIdle?: boolean;
  } = {}
): CloudProviderInfo {
  const name = overrides.name ?? "Acme";
  return {
    ...BOAT_PROVIDER,
    id: "acme.droplets.droplets",
    name,
    dashboardUrl: "https://cloud.example.com/droplets",
    capabilities: {
      ...BOAT_PROVIDER.capabilities,
      persistence: {
        kept: "Files on its disk",
        lost: "caches and memory",
        retentionDays: null,
        saveRetryBilled: false,
        stoppedComputeBilled: overrides.stoppedComputeBilled ?? true,
        stoppedStorageBilled: overrides.stoppedStorageBilled ?? false,
        ...(overrides.stoppedBilling !== undefined
          ? { stoppedBilling: overrides.stoppedBilling }
          : {}),
      },
      lifetime: overrides.lifetime ?? BOAT_PROVIDER.capabilities.lifetime,
      deletion: overrides.deletion ?? true,
    },
    hostIdleStop: overrides.hostIdleStop ?? false,
    ...(overrides.sleepsWhenHostIdle ? { sleepsWhenHostIdle: true } : {}),
  };
}
