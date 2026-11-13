// @vitest-environment jsdom
import type { ReactNode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE } from "./fixtures";

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

const h = vi.hoisted(() => ({ hosts: [] as unknown[] }));

// The real AppDialog: only the app-wide plumbing around it and the host data are stubbed.
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
vi.mock("@/store/paletteStore", () => {
  const usePaletteStore = (selector?: (s: { activePaletteId: null }) => unknown) =>
    selector ? selector({ activePaletteId: null }) : { activePaletteId: null };
  usePaletteStore.getState = () => ({ activePaletteId: null });
  return { usePaletteStore };
});

vi.mock("../../hostList", () => ({
  useHostFigures: () => ({ hosts: h.hosts, localSummary: null }),
}));
vi.mock("@/store/hostMetricsStore", () => ({
  useHostMetricsStore: (select: (state: { history: Map<string, never[]> }) => unknown) =>
    select({ history: new Map() }),
}));
vi.mock("../../hostProjects", () => ({
  useHostProjectLists: () => new Map(),
  retryHostProjects: vi.fn(),
}));
vi.mock("../useOverviewConnections", () => ({ useOverviewConnections: () => {} }));
vi.mock("../HostAddProjectDialog", () => ({ HostAddProjectDialog: () => null }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("../../hostSwitching", () => ({ switchToHost: vi.fn() }));
vi.mock("@/components/Project/ProcessesDialog", () => ({ ProcessesDialog: () => null }));
vi.mock("../../PluginParitySummary", () => ({ PluginParitySummary: () => null }));
vi.mock("../../PortsView", () => ({ PortsView: () => null }));
vi.mock("../HostFleetTargets", () => ({ HostFleetTargets: () => null }));
vi.mock("../HostCard", () => ({
  HostCard: ({ row, children }: { row: { hostId: string }; children?: ReactNode }) => (
    <div data-testid={`card-${row.hostId}`}>{children}</div>
  ),
}));

import { HostsOverviewDialog } from "../HostsOverviewDialog";

function entry(id: string): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      connection: { kind: "ssh", target: id },
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
      assistantControlEnabled: false,
    },
    connection: { status: "connected", rttMs: 12, handshake: HANDSHAKE },
    summary: null,
  };
}

afterEach(() => cleanup());

describe("HostsOverviewDialog initial focus", () => {
  it("lands on a content control, not the header close button", async () => {
    h.hosts = [entry("studio-01")];
    render(<HostsOverviewDialog onClose={() => {}} />);
    const close = screen.getByRole("button", { name: /close/i });
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active).not.toBe(document.body);
      expect(screen.getByRole("dialog").contains(active)).toBe(true);
    });
    expect(document.activeElement).not.toBe(close);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toBe(
      "Add project on This machine"
    );
  });
});
