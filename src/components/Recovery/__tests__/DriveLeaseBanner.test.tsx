// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import type { DriveLeaseHolder } from "@shared/types/remoteHosts";

const { supported, notify } = vi.hoisted(() => ({
  supported: { value: true },
  notify: vi.fn(),
}));

vi.mock("@/lib/remoteHosts", () => ({ isRemoteHostsSupported: () => supported.value }));
vi.mock("@/lib/notify", () => ({ notify }));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { DriveLeaseBanner } from "../DriveLeaseBanner";
import {
  _resetDriveLeaseBannerForTesting,
  selectDriveLeaseBanner,
  useDriveLeaseSync,
} from "../driveLeaseState";
import { getDriveLeaseBannerCopy } from "../recoveryCopy";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import {
  _resetHostConnectionSyncForTesting,
  useHostConnectionSync,
} from "@/hooks/useHostConnection";
import {
  _resetTerminalInputGateForTesting,
  getTerminalInputBlock,
} from "@/services/terminal/inputGate";
import type { HostConnectionState } from "@shared/types/remoteHosts";

function holder(overrides: Partial<DriveLeaseHolder> = {}): DriveLeaseHolder {
  return {
    leaseId: 2,
    endpointId: "view-9",
    clientId: "client-2",
    clientName: "greg-mbp",
    isHostLocal: false,
    acquiredAt: 1,
    ...overrides,
  };
}

function view(overrides: Partial<DriveLeaseView> = {}): DriveLeaseView {
  return {
    projectId: "p1",
    holder: holder(),
    drivingHere: false,
    isHolderEndpoint: false,
    viewerIsHostLocal: true,
    ...overrides,
  };
}

let emit: ((event: DriveLeaseEvent) => void) | null = null;
const get = vi.fn<(payload: { projectId: string }) => Promise<DriveLeaseView>>();
const takeOver = vi.fn<(payload: { projectId: string }) => Promise<DriveLeaseView>>();
const isInUse = vi.fn<() => Promise<boolean>>();

// Mounted the way useGlobalBannerPriority mounts them: the connection sync owns
// the lease IPC and the banner mirrors what it applied.
function Harness() {
  useHostConnectionSync();
  useDriveLeaseSync();
  return <DriveLeaseBanner />;
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

beforeEach(() => {
  cleanup();
  _resetDriveLeaseBannerForTesting();
  _resetHostConnectionSyncForTesting();
  _resetTerminalInputGateForTesting();
  useHostConnectionStore.getState().reset();
  supported.value = true;
  notify.mockClear();
  get.mockReset();
  takeOver.mockReset();
  isInUse.mockReset();
  isInUse.mockResolvedValue(false);
  emit = null;
  window.__DAINTREE_INITIAL_PROJECT__ = { id: "p1" } as typeof window.__DAINTREE_INITIAL_PROJECT__;
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: {
      driveLease: {
        get,
        takeOver,
        onEvent: (cb: (event: DriveLeaseEvent) => void) => {
          emit = cb;
          return () => {
            emit = null;
          };
        },
      },
      remoteHosts: {
        isInUse,
        onEvent: () => () => {},
        getWindowHost: () => new Promise(() => {}),
        connect: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  cleanup();
  delete (window as { __DAINTREE_HOST_ID__?: unknown }).__DAINTREE_HOST_ID__;
  delete (window as { __DAINTREE_INITIAL_PROJECT__?: unknown }).__DAINTREE_INITIAL_PROJECT__;
});

describe("selectDriveLeaseBanner", () => {
  it("shows nothing while this view drives or nobody does", () => {
    expect(selectDriveLeaseBanner(null, false)).toBeNull();
    expect(selectDriveLeaseBanner(view({ holder: null, drivingHere: true }), true)).toBeNull();
    expect(selectDriveLeaseBanner(view({ drivingHere: true }), true)).toBeNull();
  });

  it("offers Take back on the host's own screen when a remote client drives", () => {
    expect(selectDriveLeaseBanner(view(), false)).toEqual({
      kind: "taken-from-host",
      projectId: "p1",
      driverName: "greg-mbp",
    });
  });

  it("offers Take over on a client that isn't driving", () => {
    expect(selectDriveLeaseBanner(view({ viewerIsHostLocal: false }), true)).toEqual({
      kind: "driven-elsewhere",
      projectId: "p1",
      driverName: "greg-mbp",
      driverIsHostScreen: false,
    });
  });
});

describe("DriveLeaseBanner", () => {
  it("renders nothing for a local view nobody else drives, and asks nothing up front", async () => {
    const { container } = render(<Harness />);
    await waitFor(() => expect(isInUse).toHaveBeenCalled());
    await act(async () => {});
    expect(container.textContent).toBe("");
    expect(get).not.toHaveBeenCalled();
  });

  it("hydrates a local view's banner from the gate's lookup once remote hosts are in use", async () => {
    isInUse.mockResolvedValue(true);
    get.mockResolvedValue(view());
    render(<Harness />);
    const copy = getDriveLeaseBannerCopy(
      { kind: "taken-from-host", driverName: "greg-mbp" },
      "studio-01"
    );
    expect(await screen.findByText(copy.title)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    expect(getTerminalInputBlock()).toMatchObject({
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
    });
  });

  it("shows a remote view's banner once the lookup retried on reconnect answers", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    useHostConnectionStore.setState({ hostId: "studio-01", hostName: "studio-01" });
    get.mockRejectedValueOnce(new Error("link down"));
    get.mockResolvedValue(view({ viewerIsHostLocal: false }));
    const { container } = render(<Harness />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(container.textContent).toBe("");

    const connected: HostConnectionState = {
      status: "connected",
      rttMs: 1,
      handshake: {
        version: "1.0.0",
        commit: "abc",
        protocolVersion: 1,
        platform: "linux",
        arch: "x64",
      },
    };
    act(() => useHostConnectionStore.setState({ connection: connected }));
    const copy = getDriveLeaseBannerCopy(
      { kind: "driven-elsewhere", driverName: "greg-mbp", driverIsHostScreen: false },
      "studio-01"
    );
    expect(await screen.findByText(copy.title)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("does nothing at all where Remote Hosts isn't supported", () => {
    supported.value = false;
    render(<Harness />);
    expect(emit).toBeNull();
  });

  it("tells the host's own screen who drives it, and takes it back", async () => {
    render(<Harness />);
    act(() => emit?.({ type: "changed", state: view() }));
    const copy = getDriveLeaseBannerCopy(
      { kind: "taken-from-host", driverName: "greg-mbp" },
      "studio-01"
    );
    expect(screen.getByText(copy.title)).toBeTruthy();

    expect(getTerminalInputBlock()).toMatchObject({ kind: "driven-elsewhere" });

    takeOver.mockResolvedValue(view({ holder: holder({ isHostLocal: true }), drivingHere: true }));
    fireEvent.click(screen.getByRole("button", { name: copy.actionLabel }));
    await waitFor(() => expect(takeOver).toHaveBeenCalledWith({ projectId: "p1" }));
    await waitFor(() => expect(screen.queryByText(copy.title)).toBeNull());
    expect(getTerminalInputBlock()).toBeNull();
  });

  it("tells a client that isn't driving which machine does, and takes over", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    useHostConnectionStore.setState({ hostId: "studio-01", hostName: "studio-01" });
    get.mockResolvedValue(view({ viewerIsHostLocal: false }));
    render(<Harness />);
    const copy = getDriveLeaseBannerCopy(
      { kind: "driven-elsewhere", driverName: "greg-mbp", driverIsHostScreen: false },
      "studio-01"
    );
    expect(await screen.findByText(copy.title)).toBeTruthy();
    expect(copy.title).toBe("studio-01 is being driven from greg-mbp");

    takeOver.mockRejectedValue(new Error("gone"));
    fireEvent.click(screen.getByRole("button", { name: copy.actionLabel }));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![0]).toMatchObject({ type: "error" });
  });

  it("ignores lease changes for other projects", () => {
    const { container } = render(<Harness />);
    act(() => emit?.({ type: "changed", state: view({ projectId: "other" }) }));
    expect(container.textContent).toBe("");
  });

  it("stays neutral: no accent fill, text or border (the shared focus ring aside)", () => {
    const { container } = render(<Harness />);
    act(() => emit?.({ type: "changed", state: view() }));
    for (const el of container.querySelectorAll("*")) {
      expect(el.getAttribute("class") ?? "").not.toMatch(/(^|\s|:)(bg|text|border)-[^\s]*accent/);
    }
  });
});
