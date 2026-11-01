// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DriveLeaseEvent, DriveLeaseView } from "@shared/types/ipc/driveLease";
import type { DriveLeaseHolder } from "@shared/types/remoteHosts";

const { supported, notify } = vi.hoisted(() => ({
  supported: { value: true },
  notify: vi.fn(),
}));

vi.mock("@/lib/remoteHosts", () => ({
  isRemoteShellSupported: () => supported.value,
  isRemoteHostSupported: () => supported.value,
  isEitherRemoteRoleSupported: () => supported.value,
}));
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
import { getDriveLeaseBannerCopy, type ControlFacts } from "../recoveryCopy";
import { setTakeControlPending } from "../takeControlPending";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useHostConnectionStore } from "@/store/hostConnectionStore";
import { useAnnouncerStore } from "@/store/accessibilityAnnouncerStore";
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

/** The facts the banner names, for a view whose project the store hasn't named. */
function facts(overrides: Partial<ControlFacts> = {}): ControlFacts {
  return {
    holder: "greg-mbp",
    holderIsHostScreen: false,
    project: "this project",
    host: null,
    ...overrides,
  };
}

/** The banner's one action, whose accessible name leads with its visible label. */
const TAKE_CONTROL = { name: /^Take control/ };

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

// Mounted the way the app mounts them: the connection sync owns the lease IPC
// and the banner mirrors what it applied.
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

  it("offers control on the host's own screen when a remote client drives", () => {
    expect(selectDriveLeaseBanner(view(), false)).toEqual({
      kind: "taken-from-host",
      projectId: "p1",
      driverName: "greg-mbp",
    });
  });

  it("offers control on a client that isn't driving", () => {
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
    const copy = getDriveLeaseBannerCopy(facts());
    expect(await screen.findByText(copy.title)).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    expect(getTerminalInputBlock()).toMatchObject({
      kind: "driven-elsewhere",
      driverName: "greg-mbp",
    });
  });

  it("shows a remote view's banner when it couldn't claim the project and the lookup retried on reconnect answers", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    useHostConnectionStore.setState({ hostId: "studio-01", hostName: "studio-01" });
    // The view's claim on open is refused both times, so it falls back to who drives.
    takeOver.mockRejectedValue(new Error("refused"));
    // Down at open: the claim's read and its fallback lookup both fail.
    get.mockRejectedValueOnce(new Error("link down")).mockRejectedValueOnce(new Error("link down"));
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
    const copy = getDriveLeaseBannerCopy(facts({ host: "studio-01" }));
    expect(await screen.findByText(copy.title)).toBeTruthy();
    // Claim and fallback at open (both down), then the claim on reconnect, which
    // finds another machine driving and leaves it to the banner's Take control.
    expect(get).toHaveBeenCalledTimes(3);
    expect(takeOver).not.toHaveBeenCalled();
  });

  it("does nothing at all where Remote Hosts isn't supported", () => {
    supported.value = false;
    render(<Harness />);
    expect(emit).toBeNull();
  });

  it("tells the host's own screen who has control, and takes it", async () => {
    render(<Harness />);
    act(() => emit?.({ type: "changed", state: view() }));
    const copy = getDriveLeaseBannerCopy(facts());
    expect(screen.getByText(copy.title)).toBeTruthy();

    expect(getTerminalInputBlock()).toMatchObject({ kind: "driven-elsewhere" });

    takeOver.mockResolvedValue(view({ holder: holder({ isHostLocal: true }), drivingHere: true }));
    fireEvent.click(screen.getByRole("button", TAKE_CONTROL));
    await waitFor(() => expect(takeOver).toHaveBeenCalledWith({ projectId: "p1" }));
    await waitFor(() => expect(screen.queryByText(copy.title)).toBeNull());
    expect(getTerminalInputBlock()).toBeNull();
  });

  // The busy button says what it's busy doing, so the consequence stays where
  // it is instead of giving way to a progress line.
  it("keeps Take control readable and the consequence in place while a take-over is in flight (#15304)", () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      act(() => emit?.({ type: "changed", state: view() }));
      const copy = getDriveLeaseBannerCopy(facts());
      const button = screen.getByRole("button", TAKE_CONTROL);
      // Opted in before it's busy: the slot is there idle, holding the width.
      const slot = button.querySelector('[data-slot="button-spinner-slot"]');
      expect(slot).toBeTruthy();
      act(() => setTakeControlPending("p1", true));
      act(() => {
        vi.advanceTimersByTime(UI_DOHERTY_THRESHOLD);
      });
      expect(screen.getByRole("button", TAKE_CONTROL)).toBe(button);
      expect(button.getAttribute("aria-busy")).toBe("true");
      expect(button.getAttribute("aria-disabled")).toBe("true");
      const content = button.querySelector('[data-slot="button-content"]')!;
      expect(content.className).not.toContain("opacity-0");
      expect(content.textContent).toBe("Take control");
      expect(button.querySelector('[data-slot="button-spinner-slot"]')).toBe(slot);
      expect(slot!.querySelector("svg")).toBeTruthy();
      expect(screen.getByText(copy.description)).toBeTruthy();
    } finally {
      cleanup();
      setTakeControlPending("p1", false);
      vi.useRealTimers();
    }
  });

  it("tells a client that isn't driving which machine has control, and what taking it does", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "studio-01" };
    useHostConnectionStore.setState({ hostId: "studio-01", hostName: "studio-01" });
    get.mockResolvedValue(view({ viewerIsHostLocal: false }));
    render(<Harness />);
    const copy = getDriveLeaseBannerCopy(facts({ host: "studio-01" }));
    expect(await screen.findByText(copy.title)).toBeTruthy();
    // Where it lives in the title; who has it, and what taking it does to them, beside the action.
    expect(copy.title).toContain("on studio-01");
    expect(copy.description).toContain("greg-mbp has control.");
    expect(copy.description).toContain("read-only on greg-mbp");
    expect(screen.getByRole("button", TAKE_CONTROL).getAttribute("aria-label")).toContain(
      "read-only on greg-mbp"
    );

    takeOver.mockRejectedValue(new Error("gone"));
    fireEvent.click(screen.getByRole("button", TAKE_CONTROL));
    await waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    expect(notify.mock.calls[0]![0]).toMatchObject({ type: "error" });
  });

  it("says a controller that has gone is away, counts down to the handover, and goes back to live when it returns (#13937)", () => {
    vi.useFakeTimers();
    const announce = vi.fn();
    const realAnnounce = useAnnouncerStore.getState().announce;
    useAnnouncerStore.setState({ announce });
    try {
      render(<Harness />);
      act(() => emit?.({ type: "changed", state: view() }));
      const live = getDriveLeaseBannerCopy(facts());
      expect(screen.getByText(live.description)).toBeTruthy();
      announce.mockClear();

      act(() => emit?.({ type: "changed", state: view({ holderAwayMs: 15_000 }) }));
      expect(
        screen.getByText(/^greg-mbp is away\. Control passes on in 15s unless it comes back\./)
      ).toBeTruthy();
      expect(screen.getByRole("button", TAKE_CONTROL)).toBeTruthy();
      expect(getTerminalInputBlock()).toMatchObject({ driverAway: true });

      act(() => {
        vi.advanceTimersByTime(4_000);
      });
      expect(screen.getByText(/Control passes on in 11s unless it comes back\./)).toBeTruthy();
      // Said once on going away, not once a second.
      expect(announce.mock.calls.map(([message]) => message)).toEqual(["greg-mbp is away"]);

      act(() => emit?.({ type: "changed", state: view() }));
      expect(screen.getByText(live.description)).toBeTruthy();
      expect(screen.queryByText(/is away/)).toBeNull();
      expect(getTerminalInputBlock()).toMatchObject({ driverAway: false });
      expect(announce.mock.calls.map(([message]) => message)).toEqual([
        "greg-mbp is away",
        "greg-mbp is back",
      ]);
    } finally {
      useAnnouncerStore.setState({ announce: realAnnounce });
      vi.useRealTimers();
    }
  });

  it("says a controller already away when the view first hears of it is away, not in control", () => {
    const announce = vi.fn();
    const realAnnounce = useAnnouncerStore.getState().announce;
    useAnnouncerStore.setState({ announce });
    try {
      render(<Harness />);
      act(() => emit?.({ type: "changed", state: view({ holderAwayMs: 45_000 }) }));
      expect(screen.getByText(/^greg-mbp is away\./)).toBeTruthy();
      expect(announce.mock.calls.map(([message]) => message)).toEqual(["greg-mbp is away"]);
    } finally {
      useAnnouncerStore.setState({ announce: realAnnounce });
    }
  });

  it("keeps the live wording for a host that doesn't say whether its controller is away", () => {
    render(<Harness />);
    act(() => emit?.({ type: "changed", state: view() }));
    expect(screen.getByText(/^greg-mbp has control\./)).toBeTruthy();
    expect(screen.queryByText(/is away/)).toBeNull();
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
