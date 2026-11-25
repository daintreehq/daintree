// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";
import type { HostConnection, HostConnectionState, HostListEntry } from "@shared/types/remoteHosts";

const { client, cloud } = vi.hoisted(() => ({
  client: {
    update: vi.fn(async (payload: unknown) => payload),
    connect: vi.fn(async () => undefined),
    connectAndSettle: vi.fn(async () => ({ status: "disconnected" })),
    disconnect: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
    checkAgentForwarding: vi.fn(async () => ({ localAgent: true })),
    listClipboardGrants: vi.fn(async () => []),
    listPluginViewConsents: vi.fn(async () => []),
    resetClipboardGrants: vi.fn(async () => undefined),
  },
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
}));

vi.mock("@/clients/remoteHostsClient", () => ({ remoteHostsClient: client }));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("../HostPluginsSection", () => ({ HostPluginsSection: () => null }));
vi.mock("../HostSettingsSection", () => ({ HostSettingsSection: () => null }));
vi.mock("../HostSessionsSection", () => ({ HostSessionsSection: () => null }));
vi.mock("../CloudMachineSection", () => ({ CloudMachineSection: () => null }));
vi.mock("../HostCopySettingsSection", () => ({
  HostCopySettingsSection: (props: {
    connected: boolean;
    offered?: boolean;
    mayHaveSettings?: boolean;
  }) => (
    <div
      data-testid="copy-settings"
      data-connected={String(props.connected)}
      data-offered={String(props.offered === true)}
      data-may-have-settings={String(props.mayHaveSettings === true)}
    />
  ),
}));

import { HostDetail } from "../HostDetail";
import { awaitFirstConnect, takeFirstConnect } from "../hostCopySettingsRequests";

const HANDSHAKE = {
  version: "1",
  commit: "c",
  protocolVersion: 1,
  platform: "linux",
  arch: "x64",
} as const;
const CONNECTED: HostConnectionState = { status: "connected", rttMs: null, handshake: HANDSHAKE };
const CONNECTING: HostConnectionState = { status: "connecting", attempt: 1 };
const OFFLINE: HostConnectionState = { status: "disconnected" };
const CLOUD: HostConnection = { kind: "cloud", bindingId: "cb_a37cloud1" };

function entry(
  id: string,
  connection: HostConnectionState,
  kind: HostConnection = CLOUD
): HostListEntry {
  const seen = connection.status === "connected";
  return {
    descriptor: {
      id,
      name: id,
      connection: kind,
      platform: "linux",
      arch: "x64",
      lastHandshake: seen ? HANDSHAKE : null,
      lastSeenAt: seen ? 1 : null,
      addedAt: 0,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: null,
  };
}

function cloudStatus(hostId: string, ownership: CloudHostStatus["ownership"]): CloudHostStatus {
  return {
    hostId,
    providerId: "boat",
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: `bx_${hostId}`,
    machineName: hostId,
    ownership,
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "running",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
    lifetime: { kind: "renewable" },
    autoStopAt: null,
    lifetimeSeconds: null,
    stoppedAt: null,
    stop: null,
    lastSnapshotAt: null,
    dataExpired: false,
    operation: null,
    lastError: null,
    observedAt: 1,
    lastEndpoint: null,
    hostKeyFingerprint: null,
    hostKeyReview: null,
    keptRunningAt: null,
    asleep: false,
  };
}

const copySection = () => screen.getByTestId("copy-settings").dataset;

afterEach(() => {
  cleanup();
  cloud.snapshot = { providers: [], accounts: [], hosts: [] };
  // A failed test can leave its host armed; the module outlives each test.
  for (const id of ["late", "other"]) takeFirstConnect(id);
});

describe("HostDetail's Copy settings offer for a cloud host (#18186)", () => {
  it("doesn't claim an imported machine starts from defaults", () => {
    cloud.snapshot = {
      ...cloud.snapshot,
      hosts: [cloudStatus("made", "created-by-daintree"), cloudStatus("old", "imported")],
    };
    render(<HostDetail entry={entry("old", CONNECTED)} onBack={() => {}} offerCopySettings />);
    expect(copySection().offered).toBe("true");
    expect(copySection().mayHaveSettings).toBe("true");
  });

  it("says a machine Daintree created starts from defaults, once its status says so", () => {
    // Opened from the offer before the cloud snapshot has the host: no claim yet.
    const { rerender } = render(
      <HostDetail entry={entry("made", CONNECTED)} onBack={() => {}} offerCopySettings />
    );
    expect(copySection().mayHaveSettings).toBe("true");

    cloud.snapshot = { ...cloud.snapshot, hosts: [cloudStatus("made", "created-by-daintree")] };
    rerender(<HostDetail entry={entry("made", CONNECTED)} onBack={() => {}} offerCopySettings />);
    expect(copySection().offered).toBe("true");
    expect(copySection().mayHaveSettings).toBe("false");
  });

  it("keeps the defaults wording for a host added over ssh", () => {
    render(
      <HostDetail
        entry={entry("studio", CONNECTED, { kind: "ssh", target: "greg@studio" })}
        onBack={() => {}}
        offerCopySettings
      />
    );
    expect(copySection().offered).toBe("true");
    expect(copySection().mayHaveSettings).toBe("false");
  });

  it("offers it once, when an armed cloud host first shows as connected after setup closed", () => {
    cloud.snapshot = {
      ...cloud.snapshot,
      hosts: [cloudStatus("late", "created-by-daintree"), cloudStatus("other", "imported")],
    };
    awaitFirstConnect("late");

    // Another host connecting takes nothing of this one's.
    const other = render(<HostDetail entry={entry("other", CONNECTED)} onBack={() => {}} />);
    expect(copySection().offered).toBe("false");
    other.unmount();

    const { rerender, unmount } = render(
      <HostDetail entry={entry("late", OFFLINE)} onBack={() => {}} />
    );
    expect(copySection().offered).toBe("false");
    rerender(<HostDetail entry={entry("late", CONNECTING)} onBack={() => {}} />);
    expect(copySection().offered).toBe("false");

    rerender(<HostDetail entry={entry("late", CONNECTED)} onBack={() => {}} />);
    expect(copySection().connected).toBe("true");
    expect(copySection().offered).toBe("true");
    expect(copySection().mayHaveSettings).toBe("false");

    // Opened again later, still connected: the offer was the first connection's.
    unmount();
    render(<HostDetail entry={entry("late", CONNECTED)} onBack={() => {}} />);
    expect(copySection().offered).toBe("false");
  });
});
