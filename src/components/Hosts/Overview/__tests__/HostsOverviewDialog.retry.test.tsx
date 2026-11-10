// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HANDSHAKE } from "./fixtures";

// The real card and the real per-host listing: only the dialog's other
// sections and its host feed are stood in for.
const h = vi.hoisted(() => ({ hosts: [] as unknown[] }));

vi.mock("../../hostList", () => ({
  useHostList: () => ({ hosts: h.hosts, localSummary: null }),
  useHostFigures: () => ({ hosts: h.hosts, localSummary: null }),
  hasRemoteHosts: () => true,
}));
vi.mock("../useOverviewConnections", () => ({ useOverviewConnections: () => {} }));
vi.mock("@/hooks/useHostConnection", () => ({ getViewHostId: () => null }));
vi.mock("../../hostSwitching", () => ({ switchToHost: vi.fn(), isNewWindowClick: () => false }));
vi.mock("../../PortsView", () => ({ PortsView: () => null }));
vi.mock("../HostFleetTargets", () => ({ HostFleetTargets: () => null }));
vi.mock("../../PluginParitySummary", () => ({ PluginParitySummary: () => null }));
vi.mock("@/components/Project/ProcessesDialog", () => ({ ProcessesDialog: () => null }));
vi.mock("../HostAddProjectDialog", () => ({ HostAddProjectDialog: () => null }));
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

import {
  _resetHostProjectsForTesting,
  setHostProjectsLoader,
  type HostProjectRef,
} from "../../hostProjects";
import { HostsOverviewDialog } from "../HostsOverviewDialog";

function connected(id: string): HostListEntry {
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

/** Each ask of each host, answered when the test says. */
function deferredLoader() {
  const asks: Array<{
    hostId: string;
    resolve: (projects: HostProjectRef[]) => void;
    reject: (error: Error) => void;
  }> = [];
  setHostProjectsLoader(
    (hostId) =>
      new Promise<HostProjectRef[]>((resolve, reject) => asks.push({ hostId, resolve, reject }))
  );
  return asks;
}

describe("HostsOverviewDialog project Retry", () => {
  beforeEach(() => {
    _resetHostProjectsForTesting();
    h.hosts = [connected("studio-01")];
  });
  afterEach(() => _resetHostProjectsForTesting());

  it("asks only the failed host again and swaps its failure for the list, the overview staying open", async () => {
    const asks = deferredLoader();
    const onClose = vi.fn();
    render(<HostsOverviewDialog onClose={onClose} />, { wrapper: TooltipProvider });
    expect(asks.map((ask) => ask.hostId).sort()).toEqual(["local", "studio-01"]);

    await act(async () => {
      asks.find((ask) => ask.hostId === "local")!.resolve([]);
      asks.find((ask) => ask.hostId === "studio-01")!.reject(new Error("timed out"));
    });
    const card = screen.getByRole("article", { name: "studio-01" });
    expect(card.textContent).toContain("Couldn't load projects on studio-01");

    fireEvent.click(screen.getByRole("button", { name: "Retry listing projects on studio-01" }));
    expect(asks.map((ask) => ask.hostId).slice(2)).toEqual(["studio-01"]);
    expect(card.textContent).toContain("Listing projects on studio-01…");
    expect(
      screen.queryByRole("button", { name: "Retry listing projects on studio-01" })
    ).toBeNull();

    await act(async () => {
      asks[2]!.resolve([{ id: "s1", name: "api", path: "/home/g/api" }]);
    });
    expect(screen.getByRole("button", { name: "Open api on studio-01" })).toBeTruthy();
    expect(card.textContent).not.toContain("Couldn't load");
    expect(asks).toHaveLength(3);
    expect(onClose).not.toHaveBeenCalled();
  });
});
