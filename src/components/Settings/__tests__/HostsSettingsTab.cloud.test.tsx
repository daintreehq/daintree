// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  BOAT_PROVIDER,
  DELETE_ONLY_PROVIDER,
} from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

const { cloud } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/components/Hosts/cloud/useCloudMachineActions", () => ({
  useCloudMachineActions: () => ({
    errorFor: () => null,
    isPending: () => false,
    start: vi.fn(),
    check: vi.fn(),
    confirmStart: vi.fn(),
    requestStop: vi.fn(),
    dialogs: null,
  }),
}));

import HostsSettingsTab from "../Hosts/HostsSettingsTab";

function entry(id: string): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: `greg@${id}` },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: { status: "unreachable", lastSeenAt: null, detail: null },
    summary: null,
  };
}

function machine(hostId: string, providerId: string, overrides: Partial<CloudHostStatus> = {}) {
  return {
    hostId,
    providerId,
    providerUnavailable: null,
    accountId: "ca_0123456789",
    accountName: "Personal",
    resourceId: `${hostId}-res`,
    machineName: hostId,
    ownership: "created-by-daintree",
    createdFor: null,
    worktreeCleanup: null,
    provisioning: null,
    machine: "running",
    rawState: "ready",
    machineType: "default",
    vcpu: 4,
    memoryGB: 8,
    hourlyDollars: 0.036,
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
    ...overrides,
  } satisfies CloudHostStatus;
}

beforeEach(() => {
  useRemoteHostsStore.getState().reset();
  Object.defineProperty(window, "electron", {
    value: {
      remoteHosts: {
        list: vi.fn(async () => [entry("lease-box"), entry("boat-box")]),
        forget: vi.fn(async () => {}),
        update: vi.fn(async () => ({})),
        connect: vi.fn(async () => ({ status: "connecting", attempt: 1 })),
        discover: vi.fn(async () => []),
        listClipboardGrants: vi.fn(async () => []),
        listPluginViewConsents: vi.fn(async () => []),
        resetClipboardGrants: vi.fn(async () => {}),
        onEvent: vi.fn(() => () => {}),
      },
      hostMode: {
        getStatus: vi.fn(async () => ({
          supported: true,
          enabled: false,
          startAtLogin: false,
          socketPath: "/run/user/501/daintree/host.sock",
          listening: false,
          attachedClients: [],
          rows: [],
        })),
        onEvent: vi.fn(() => () => {}),
      },
      deviceAnswer: {
        getStatus: vi.fn(async () => ({
          enabled: false,
          listening: false,
          port: 7421,
          tailnetHost: null,
          sshTarget: "greg@studio",
          error: null,
          pairing: null,
          devices: [],
          recentAnswers: [],
        })),
        onEvent: vi.fn(() => () => {}),
      },
    },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "electron");
});

async function showRows(state: CloudHostStatus["machine"]) {
  cloud.snapshot = {
    providers: [DELETE_ONLY_PROVIDER, BOAT_PROVIDER],
    accounts: [],
    hosts: [
      machine("lease-box", DELETE_ONLY_PROVIDER.id, { machine: state }),
      machine("boat-box", BOAT_PROVIDER.id, { machine: state }),
    ],
  };
  render(
    <TooltipProvider>
      <HostsSettingsTab />
    </TooltipProvider>
  );
  await screen.findByText("lease-box");
}

/** A host's row: the widest element around its Details button that doesn't take in the other host. */
function rowOf(hostId: string, other: string): HTMLElement {
  let row = document.querySelector<HTMLElement>(`[data-host-details='${hostId}']`)!;
  while (row.parentElement && !row.parentElement.textContent?.includes(other)) {
    row = row.parentElement;
  }
  return row;
}

describe("HostsSettingsTab rows for a machine whose provider has no stop (#18229)", () => {
  it("offers no Stop on its row while it runs, beside a Boat row that still does", async () => {
    await showRows("running");
    expect(screen.queryByRole("button", { name: "Stop lease-box" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop boat-box" })).toBeTruthy();
    expect(rowOf("lease-box", "boat-box").textContent).toContain("Leasy");
    expect(rowOf("lease-box", "boat-box").textContent).toContain("runs until deleted");
    expect(rowOf("boat-box", "lease-box").textContent).not.toContain("runs until deleted");
  });

  it("offers no Start on its row while it reports stopped or an error", async () => {
    await showRows("stopped");
    expect(screen.queryByRole("button", { name: "Start lease-box" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start boat-box" })).toBeTruthy();
    // No start price for a machine that can't be started; Boat's stays.
    expect(rowOf("lease-box", "boat-box").textContent).not.toContain("when started");
    expect(rowOf("boat-box", "lease-box").textContent).toContain("$0.036/h when started");
    cleanup();
    await showRows("error");
    expect(screen.queryByRole("button", { name: "Start lease-box" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start boat-box" })).toBeTruthy();
  });
});
