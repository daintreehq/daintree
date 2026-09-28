// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { HostProjectSummary } from "@shared/types/ipc/remoteHosts";

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

vi.mock("@/hooks", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useEscapeStack: () => {}, useOverlayState: () => {} };
});
vi.mock("@/hooks/useAnimatedPresence", () => ({
  useAnimatedPresence: ({ isOpen }: { isOpen: boolean }) => ({
    isVisible: isOpen,
    shouldRender: isOpen,
  }),
}));
vi.mock("@/store", () => ({ usePortalStore: () => ({ isOpen: false, width: 0 }) }));
vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});
vi.mock("@/components/Hosts/hostList", () => ({
  useHostList: () => ({
    hosts: [{ descriptor: { id: "h1", name: "studio-01" }, connection: {}, summary: null }],
    localSummary: null,
  }),
  getHostListSnapshot: () => ({ hosts: [], localSummary: null }),
}));
vi.mock("@/utils/logger", () => ({
  logError: vi.fn(),
  logDebug: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
}));

import { HostProjectPicker } from "../HostProjectPicker";

const listHostProjects = vi.fn<(payload: { hostId: string }) => Promise<HostProjectSummary[]>>();
const switchWindowHost = vi.fn(() => Promise.resolve({ outcome: "switched" }));

beforeEach(() => {
  listHostProjects.mockReset();
  switchWindowHost.mockClear();
  Object.defineProperty(window, "electron", {
    configurable: true,
    writable: true,
    value: { remoteHosts: { listHostProjects, switchWindowHost } },
  });
});

afterEach(() => cleanup());

async function renderPicker(onClose = vi.fn()) {
  render(<HostProjectPicker hostId="h1" onClose={onClose} />);
  await act(async () => {
    await Promise.resolve();
  });
  return onClose;
}

describe("HostProjectPicker", () => {
  it("lists the host's projects under its name and switches the window to the one picked", async () => {
    listHostProjects.mockResolvedValue([
      { id: "p1", name: "App", path: "/srv/app" },
      { id: "p2", name: "Site", path: "/srv/site" },
    ]);
    const onClose = await renderPicker();
    expect(listHostProjects).toHaveBeenCalledWith({ hostId: "h1" });
    expect(screen.getByText("Projects on studio-01")).toBeTruthy();
    fireEvent.click(await screen.findByText("Site"));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({
        hostId: "h1",
        newWindow: false,
        projectId: "p2",
      })
    );
  });

  it("says a host has no projects and offers its project list in a new window", async () => {
    listHostProjects.mockResolvedValue([]);
    await renderPicker();
    expect(await screen.findByText("studio-01 has no projects yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open studio-01 in a new window" }));
    await waitFor(() =>
      expect(switchWindowHost).toHaveBeenCalledWith({ hostId: "h1", newWindow: true })
    );
  });

  it("says so when the host can't be listed", async () => {
    listHostProjects.mockRejectedValue(new Error("link down"));
    await renderPicker();
    expect(await screen.findByText("Couldn't list the projects on studio-01.")).toBeTruthy();
  });
});
