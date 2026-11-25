// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostListEntry } from "@shared/types/remoteHosts";
import type { CloudHostStatus, CloudHostsSnapshot } from "@shared/types/cloudHosts";

const { cloud, machines } = vi.hoisted(() => ({
  cloud: { snapshot: { providers: [], accounts: [], hosts: [] } as CloudHostsSnapshot },
  machines: {
    start: vi.fn(),
    check: vi.fn(),
    confirmStart: vi.fn(),
    requestStop: vi.fn(),
  },
}));

vi.mock("react-dom", async () => {
  const actual = await vi.importActual<typeof import("react-dom")>("react-dom");
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => true,
  isRemoteHostSupported: () => true,
  isEitherRemoteRoleSupported: () => true,
  remoteConnectionKind: () => "ssh",
}));
vi.mock("@/services/ActionService", () => ({
  actionService: { dispatch: vi.fn(async () => ({ ok: true })), has: () => false },
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("@/components/Hosts/cloud/cloudHostsState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/Hosts/cloud/cloudHostsState")>()),
  useCloudHosts: () => ({ snapshot: cloud.snapshot, loaded: true, loadError: null }),
}));
vi.mock("@/components/Hosts/cloud/useCloudMachineActions", () => ({
  useCloudMachineActions: () => ({
    ...machines,
    errorFor: () => null,
    isPending: () => false,
    dialogs: null,
  }),
}));

import { TooltipProvider } from "@/components/ui/tooltip";
import { HostChip } from "../HostChip";
import { _resetHostListForTesting } from "../hostList";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { _resetDriveLeaseBannerForTesting } from "@/components/Recovery/driveLeaseState";
import {
  BOAT_PROVIDER,
  DELETE_ONLY_PROVIDER,
} from "@/components/Hosts/cloud/__tests__/cloudProviderFixtures";

function host(id: string): HostListEntry {
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
    // Down but not away, so its row says what opening it does.
    connection: { status: "disconnected" },
    summary: null,
  };
}

function machine(hostId: string, providerId: string, state: CloudHostStatus["machine"]) {
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
    machine: state,
    rawState: state,
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
  } satisfies CloudHostStatus;
}

const list = vi.fn<() => Promise<HostListEntry[]>>();
const switchWindowHost = vi.fn(() => Promise.resolve());

beforeEach(() => {
  _resetHostListForTesting();
  _resetDriveLeaseBannerForTesting();
  useHostConnectionStore.getState().reset();
  Object.values(machines).forEach((spy) => spy.mockClear());
  switchWindowHost.mockClear();
  list.mockResolvedValue([host("lease-box"), host("boat-box")]);
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      remoteHosts: { list, switchWindowHost, onEvent: () => () => {} },
      update: { checkForUpdates: vi.fn(() => Promise.resolve()) },
    },
  });
});

afterEach(cleanup);

async function openWith(state: CloudHostStatus["machine"]) {
  cloud.snapshot = {
    providers: [DELETE_ONLY_PROVIDER, BOAT_PROVIDER],
    accounts: [],
    hosts: [
      machine("lease-box", DELETE_ONLY_PROVIDER.id, state),
      machine("boat-box", BOAT_PROVIDER.id, state),
    ],
  };
  render(
    <TooltipProvider>
      <HostChip />
    </TooltipProvider>
  );
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.keyDown(await screen.findByTestId("host-chip"), { key: "Enter" });
  return screen.findByRole("menu");
}

async function openCloudMachines() {
  const trigger = screen.getByTestId("host-chip-cloud-machines");
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  await waitFor(() =>
    expect(document.querySelector("[data-cloud-machine-host-id='lease-box']")).not.toBeNull()
  );
}

const cloudItem = (hostId: string) =>
  document.querySelector<HTMLElement>(`[data-cloud-machine-host-id='${hostId}']`)!;

describe("HostChip for a machine whose provider has no stop (#18229)", () => {
  it("goes to a stopped one as it is, asking for no start, while a Boat one still asks", async () => {
    const menu = await openWith("stopped");
    const lease = menu.querySelector<HTMLElement>("[data-host-id='lease-box']")!;
    expect(lease.textContent).not.toContain("Opening it starts the machine");
    expect(menu.querySelector("[data-host-id='boat-box']")!.textContent).toContain(
      "Opening it starts the machine"
    );
    fireEvent.click(lease);
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "lease-box", newWindow: false })
    );
    expect(machines.confirmStart).not.toHaveBeenCalled();

    const again = await (async () => {
      fireEvent.keyDown(screen.getByTestId("host-chip"), { key: "Enter" });
      return screen.findByRole("menu");
    })();
    fireEvent.click(again.querySelector("[data-host-id='boat-box']")!);
    expect(machines.confirmStart).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: "boat-box" })
    );
  });

  it("lists it under Cloud machines with no Stop or Start, beside a Boat machine that has them", async () => {
    await openWith("running");
    await openCloudMachines();
    const lease = cloudItem("lease-box");
    expect(lease.textContent).toMatch(/^lease-box/);
    expect(lease.textContent).not.toMatch(/\b(Stop|Start) lease-box/);
    expect(lease.textContent).toContain("runs until deleted");
    expect(lease.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(lease);
    expect(machines.requestStop).not.toHaveBeenCalled();
    expect(machines.start).not.toHaveBeenCalled();
    expect(cloudItem("boat-box").textContent).toContain("Stop boat-box");
  });

  it("offers no Start for one that reports stopped", async () => {
    await openWith("stopped");
    await openCloudMachines();
    expect(cloudItem("lease-box").textContent).not.toContain("Start lease-box");
    expect(cloudItem("boat-box").textContent).toContain("Start boat-box");
  });
});
