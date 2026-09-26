// @vitest-environment jsdom
import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE } from "./fixtures";

const h = vi.hoisted(() => ({
  hosts: [] as unknown[],
  paritySummary: vi.fn(),
  projects: new Map<string, Array<{ id: string; name: string; path: string }>>(),
  listed: [] as string[][],
  switchToHost: vi.fn(),
}));

vi.mock("../../hostList", () => ({
  useHostList: () => ({ hosts: h.hosts, localSummary: null }),
}));
vi.mock("@/store/hostMetricsStore", () => ({
  useHostMetricsStore: (select: (state: { history: Map<string, never[]> }) => unknown) =>
    select({ history: new Map() }),
}));
vi.mock("../../hostProjects", () => ({
  useHostProjectLists: (ids: string[]) => {
    h.listed.push([...ids]);
    return new Map(ids.flatMap((id) => (h.projects.has(id) ? [[id, h.projects.get(id)!]] : [])));
  },
}));
vi.mock("../HostAddProjectDialog", () => ({
  HostAddProjectDialog: (props: {
    hostId: string;
    hostName: string;
    onOpened: (result: { hostId: string; projectId: string }) => void;
  }) => (
    <div data-testid="add-project-dialog" data-host-id={props.hostId}>
      <button
        type="button"
        onClick={() => props.onOpened({ hostId: props.hostId, projectId: "cloned-1" })}
      >
        finish clone
      </button>
    </div>
  ),
}));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("../../hostSwitching", () => ({ switchToHost: h.switchToHost }));
vi.mock("../../PortsView", () => ({ PortsView: () => null }));
vi.mock("../HostFleetTargets", () => ({ HostFleetTargets: () => null }));
vi.mock("../HostCard", () => ({
  HostCard: ({
    row,
    children,
    projects,
    onOpenProject,
  }: {
    row: { hostId: string };
    children?: ReactNode;
    projects?: Array<{ id: string; name: string }>;
    onOpenProject?: (projectId: string, newWindow: boolean) => void;
  }) => (
    <div data-testid={`card-${row.hostId}`}>
      {projects?.map((project) => (
        <button key={project.id} type="button" onClick={() => onOpenProject?.(project.id, false)}>
          {`${row.hostId}/${project.name}`}
        </button>
      ))}
      {children}
    </div>
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
      connection: { kind: "ssh", target: id },
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

describe("HostsOverviewDialog projects", () => {
  beforeEach(() => {
    h.hosts = [
      entry("studio-01", { status: "connected", rttMs: 12, handshake: HANDSHAKE }),
      entry("studio-02", { status: "unreachable", lastSeenAt: null, detail: null }),
    ];
    h.projects = new Map([
      ["local", [{ id: "l1", name: "notes", path: "/Users/g/notes" }]],
      ["studio-01", [{ id: "s1", name: "api", path: "/home/g/api" }]],
    ]);
    h.listed = [];
    h.switchToHost.mockClear();
  });

  it("lists each reachable host's projects on its card, and opens one on its host", () => {
    const onClose = vi.fn();
    render(<HostsOverviewDialog onClose={onClose} />);
    // A host whose link is down isn't asked.
    expect(h.listed.at(-1)).toEqual(["local", "studio-01"]);
    expect(screen.getByText("local/notes")).toBeTruthy();
    fireEvent.click(screen.getByText("studio-01/api"));
    expect(h.switchToHost).toHaveBeenCalledWith("studio-01", false, "s1");
    expect(onClose).toHaveBeenCalled();
  });

  it("offers Add project… on every reachable host, each cloning onto that host", () => {
    const onClose = vi.fn();
    render(<HostsOverviewDialog onClose={onClose} />);
    expect(screen.getByRole("button", { name: /^Add a project on This / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a project on studio-02" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add a project on studio-01" }));
    const dialog = screen.getByTestId("add-project-dialog");
    expect(dialog.getAttribute("data-host-id")).toBe("studio-01");
    fireEvent.click(screen.getByText("finish clone"));
    expect(h.switchToHost).toHaveBeenCalledWith("studio-01", false, "cloned-1");
  });
});
