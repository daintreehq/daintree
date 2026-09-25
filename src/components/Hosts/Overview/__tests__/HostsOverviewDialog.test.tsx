// @vitest-environment jsdom
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE } from "./fixtures";

const h = vi.hoisted(() => ({
  hosts: [] as unknown[],
  paritySummary: vi.fn(),
}));

vi.mock("../../hostList", () => ({
  useHostList: () => ({ hosts: h.hosts, localSummary: null }),
}));
vi.mock("@/store/hostMetricsStore", () => ({
  useHostMetricsStore: (select: (state: { history: Map<string, never[]> }) => unknown) =>
    select({ history: new Map() }),
}));
vi.mock("@/store/projectStore", () => ({
  useProjectStore: (select: (state: { openCloneRepoDialog: () => void }) => unknown) =>
    select({ openCloneRepoDialog: () => {} }),
}));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("../../hostSwitching", () => ({ switchToHost: vi.fn() }));
vi.mock("../../PortsView", () => ({ PortsView: () => null }));
vi.mock("../HostFleetTargets", () => ({ HostFleetTargets: () => null }));
vi.mock("../HostCard", () => ({
  HostCard: ({ row, children }: { row: { hostId: string }; children?: ReactNode }) => (
    <div data-testid={`card-${row.hostId}`}>{children}</div>
  ),
}));
vi.mock("../../PluginParitySummary", () => ({
  PluginParitySummary: (props: { hostId: string; connected: boolean }) => {
    h.paritySummary(props);
    return <span data-testid={`parity-${props.hostId}`}>{String(props.connected)}</span>;
  },
}));
vi.mock("@/components/ui/AppDialog", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const AppDialog = Object.assign(Pass, {
    Header: Pass,
    Title: Pass,
    CloseButton: () => null,
    BodyScroll: Pass,
  });
  return { AppDialog };
});

import { HostsOverviewDialog } from "../HostsOverviewDialog";

function entry(id: string, connection: HostListEntry["connection"]): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      sshTarget: id,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 1,
      notificationsEnabled: false,
    },
    connection,
    summary: null,
  };
}

describe("HostsOverviewDialog plugin parity", () => {
  beforeEach(() => {
    h.paritySummary.mockClear();
    h.hosts = [];
  });

  it("puts a plugin summary on each host card, comparing only while the host is connected", () => {
    h.hosts = [
      entry("studio-01", { status: "connected", rttMs: 12, handshake: HANDSHAKE }),
      entry("studio-02", { status: "unreachable", lastSeenAt: null, detail: null }),
    ];
    render(<HostsOverviewDialog onClose={() => {}} />);
    expect(screen.getByTestId("parity-studio-01").textContent).toBe("true");
    expect(screen.getByTestId("parity-studio-02").textContent).toBe("false");
    // This machine has nothing to compare with itself.
    expect(screen.getByTestId("parity-local").textContent).toBe("false");
    expect(h.paritySummary).toHaveBeenCalledWith({ hostId: "studio-01", connected: true });
  });
});
