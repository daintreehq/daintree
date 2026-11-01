// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostListEntry, HostMetricsSummary } from "@shared/types/remoteHosts";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
  }
});

const { hostList } = vi.hoisted(() => ({
  hostList: {
    value: { hosts: [] as HostListEntry[], localSummary: null as HostMetricsSummary | null },
  },
}));

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});
vi.mock("@/hooks/useOverlayState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useOverlayState")>()),
  useOverlayState: () => {},
}));
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/portalStore", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => hostList.value,
  useHostFigures: () => hostList.value,
  getHostListSnapshot: () => hostList.value,
}));
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isMac: () => true,
  isWindows: () => false,
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostSwitcherPalette } from "../HostSwitcherPalette";
import { usePaletteStore } from "@/store/paletteStore";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  consumeDeferredPaletteFocusRestore,
  consumePaletteFocusRestoreSuppression,
} from "@/components/ui/paletteFocusRestore";

const CONNECTED: HostListEntry["connection"] = {
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

function summary(hostId: string, overrides: Partial<HostMetricsSummary> = {}): HostMetricsSummary {
  return {
    hostId,
    sampledAt: 1,
    platform: "linux",
    cpuPercent: 42.4,
    memoryPressure: "normal",
    memoryUsedBytes: null,
    memoryTotalBytes: null,
    swapUsedBytes: null,
    swapTotalBytes: null,
    thermal: null,
    cpuPressure: null,
    agentsObserved: { working: 2, waiting: 1, idle: 0 },
    agentAttention: { waiting: 1, blocked: 0, idle: 0 },
    projectCount: 3,
    worktreeCount: null,
    driver: null,
    agentClis: [],
    ...overrides,
  };
}

function host(
  id: string,
  name: string,
  connection: HostListEntry["connection"],
  extra: Partial<HostListEntry> = {}
): HostListEntry {
  return {
    descriptor: {
      id,
      name,
      connection: { kind: "ssh", target: name },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection,
    summary: null,
    ...extra,
  };
}

const switchWindowHost = vi.fn(() => Promise.resolve({ outcome: "switched" }));

beforeEach(() => {
  switchWindowHost.mockClear();
  hostList.value = { hosts: [], localSummary: null };
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { remoteHosts: { switchWindowHost } },
  });
  usePaletteStore.setState({ activePaletteId: null });
  consumePaletteFocusRestoreSuppression();
  consumeDeferredPaletteFocusRestore();
});

afterEach(() => {
  cleanup();
  delete window.__DAINTREE_HOST_ID__;
});

function openPalette() {
  render(<HostSwitcherPalette />, { wrapper: TooltipProvider });
  act(() => usePaletteStore.getState().openPalette("host-switcher"));
}

function row(hostId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-host-id="${hostId}"]`);
  if (!el) throw new Error(`no row for ${hostId}`);
  return el;
}

describe("HostSwitcherPalette", () => {
  it("renders nothing until the palette is opened", () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    render(<HostSwitcherPalette />, { wrapper: TooltipProvider });
    expect(document.querySelector("[data-host-id]")).toBeNull();
  });

  it("lists this machine first, then each host with its state, projects, observed agents and load", () => {
    hostList.value = {
      hosts: [
        host("h1", "studio-01", CONNECTED, {
          summary: summary("h1"),
        }),
      ],
      localSummary: null,
    };
    openPalette();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-host-id]")];
    expect(rows.map((el) => el.dataset.hostId)).toEqual(["local", "h1"]);
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    const text = row("h1").textContent ?? "";
    expect(text).toContain("studio-01");
    expect(text).toContain("3 projects");
    expect(text).toContain("Agents: 1 waiting, 2 working (observed)");
    expect(text).toContain("42% CPU");
    expect(text).toContain("normal memory pressure");
  });

  it("reads a newer host's load as busy cores and memory in use, marking only high pressure", () => {
    const GB = 1024 ** 3;
    const capacity = {
      cpuPercent: 50,
      cpuLogicalCoreCount: 14,
      memoryUsedBytes: 20.1 * GB,
      memoryTotalBytes: 36 * GB,
    };
    hostList.value = {
      hosts: [
        host("h1", "studio-01", CONNECTED, {
          summary: summary("h1", { ...capacity, memoryPressure: "normal" }),
        }),
        host("h2", "build-east", CONNECTED, {
          summary: summary("h2", { ...capacity, memoryPressure: "warn" }),
        }),
      ],
      localSummary: null,
    };
    openPalette();
    const calm = row("h1");
    expect(calm.textContent).toContain("7 of 14 cores busy");
    expect(calm.textContent).toContain("20.1 / 36 GB memory in use, normal pressure");
    expect(calm.querySelector("[data-pressure-steps]")).toBeNull();
    const pressed = row("h2");
    expect(pressed.textContent).toContain("20.1 / 36 GB memory in use, high pressure");
    expect(pressed.querySelector("[data-pressure-steps]")).not.toBeNull();
  });

  it("marks critical memory pressure beside capacity, and shows capacity when pressure is unread", () => {
    const capacity = {
      cpuLogicalCoreCount: 8,
      memoryUsedBytes: 6 * 1024 ** 3,
      memoryTotalBytes: 8 * 1024 ** 3,
    };
    hostList.value = {
      hosts: [
        host("h1", "studio-01", CONNECTED, {
          summary: summary("h1", { ...capacity, memoryPressure: "critical" }),
        }),
        host("h2", "build-east", CONNECTED, {
          summary: summary("h2", { ...capacity, memoryPressure: null }),
        }),
      ],
      localSummary: null,
    };
    openPalette();
    const critical = row("h1");
    expect(critical.textContent).toContain("6 / 8 GB memory in use, critical pressure");
    expect(critical.querySelector("[data-pressure-steps]")).not.toBeNull();
    const unread = row("h2");
    expect(unread.textContent).toContain("6 / 8 GB memory in use");
    expect(unread.textContent).not.toContain("pressure");
    expect(unread.querySelector("[data-pressure-steps]")).toBeNull();
  });

  it("says when an unreachable host was last seen and shows no stale load", () => {
    const lastSeenAt = Date.now() - 5 * 60_000;
    hostList.value = {
      hosts: [
        host(
          "h1",
          "studio-01",
          { status: "unreachable", lastSeenAt, detail: null },
          {
            summary: summary("h1"),
          }
        ),
      ],
      localSummary: null,
    };
    openPalette();
    const text = row("h1").textContent ?? "";
    expect(text).toContain("Unreachable");
    expect(text).toMatch(/last seen/i);
    expect(text).not.toContain("CPU");
  });

  it("filters by name as the query is typed", () => {
    hostList.value = {
      hosts: [
        host("h1", "studio-01", { status: "disconnected" }),
        host("h2", "build-east", { status: "disconnected" }),
      ],
      localSummary: null,
    };
    openPalette();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "build" } });
    const ids = [...document.querySelectorAll<HTMLElement>("[data-host-id]")].map(
      (el) => el.dataset.hostId
    );
    expect(ids).toEqual(["h2"]);
  });

  it("switches the window to the picked host and closes", async () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    fireEvent.click(row("h1"));
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false })
    );
  });

  it("opens the host in a new window on Cmd-click", async () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    fireEvent.click(row("h1"), { metaKey: true });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
    );
  });

  it("only closes when the current host is picked", () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    fireEvent.click(row("local"));
    expect(usePaletteStore.getState().activePaletteId).toBeNull();
    expect(switchWindowHost).not.toHaveBeenCalled();
  });

  it("opens on the first host this window isn't on, so Enter goes there", async () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    const search = screen.getByRole("combobox");
    expect(row("h1").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("to connect and switch")).toBeTruthy();
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false })
    );
  });

  it("opens on this machine from a remote window, and switches with the arrow keys", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    hostList.value = {
      hosts: [host("h1", "studio-01", CONNECTED), host("h2", "studio-02", CONNECTED)],
      localSummary: null,
    };
    openPalette();
    expect(row("local").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h2", newWindow: false })
    );
  });

  it("moves to another host once the host list arrives after opening", () => {
    const { rerender } = render(<HostSwitcherPalette />, { wrapper: TooltipProvider });
    act(() => usePaletteStore.getState().openPalette("host-switcher"));
    expect(row("local").getAttribute("aria-selected")).toBe("true");
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    rerender(<HostSwitcherPalette />);
    expect(row("h1").getAttribute("aria-selected")).toBe("true");
  });

  it("leaves the cursor where the user put it when hosts arrive after opening", () => {
    hostList.value = { hosts: [], localSummary: null };
    const { rerender } = render(<HostSwitcherPalette />, { wrapper: TooltipProvider });
    act(() => usePaletteStore.getState().openPalette("host-switcher"));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    rerender(<HostSwitcherPalette />);
    expect(row("local").getAttribute("aria-selected")).toBe("true");
  });

  it("starts each opening on its first other host, wherever the last one ended", () => {
    hostList.value = {
      hosts: [
        host("h1", "studio-01", { status: "disconnected" }),
        host("h2", "studio-02", { status: "disconnected" }),
      ],
      localSummary: null,
    };
    openPalette();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(row("h2").getAttribute("aria-selected")).toBe("true");
    // Another palette takes over without this one's close running.
    act(() => usePaletteStore.getState().openPalette("quick-switcher"));
    act(() => usePaletteStore.getState().openPalette("host-switcher"));
    expect(row("h1").getAttribute("aria-selected")).toBe("true");
  });

  it("opens the selected host in a new window on Cmd+Enter", async () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
    );
  });

  it("reconnects the host this window is on when its link is down", async () => {
    window.__DAINTREE_HOST_ID__ = { id: "h1" };
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    fireEvent.click(row("h1"));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: false })
    );
  });

  it("says a host's link state once", () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    openPalette();
    expect((row("h1").textContent ?? "").match(/Not connected/g)).toHaveLength(1);
  });

  // A switch that lands hands the keyboard on (the host's view, or its project
  // list), so the palette doesn't take it back on close; one that fails or is
  // cancelled leaves the window where it was, and the keyboard goes back too.
  it("gives focus back only when the window stayed where it was", async () => {
    hostList.value = {
      hosts: [host("h1", "studio-01", { status: "disconnected" })],
      localSummary: null,
    };
    switchWindowHost.mockResolvedValueOnce({ outcome: "switched" });
    openPalette();
    fireEvent.click(row("h1"));
    const landed = vi.fn();
    consumeDeferredPaletteFocusRestore()!(landed);
    await waitFor(() => expect(switchWindowHost).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(landed).not.toHaveBeenCalled();

    switchWindowHost.mockResolvedValueOnce({ outcome: "superseded" });
    act(() => usePaletteStore.getState().openPalette("host-switcher"));
    fireEvent.click(row("h1"));
    const stayed = vi.fn();
    consumeDeferredPaletteFocusRestore()!(stayed);
    await waitFor(() => expect(stayed).toHaveBeenCalledTimes(1));

    // Picking where the window already is just closes, and restores as usual.
    act(() => usePaletteStore.getState().openPalette("host-switcher"));
    fireEvent.click(row("local"));
    expect(consumeDeferredPaletteFocusRestore()).toBeNull();
  });
});
