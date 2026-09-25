// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListEntry } from "@shared/types/remoteHosts";
import { HANDSHAKE, makeSummary } from "./fixtures";

const { hostList, dispatch } = vi.hoisted(() => ({
  hostList: { hosts: [] as HostListEntry[], localSummary: null as unknown },
  dispatch: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../hostList", () => ({
  useHostList: () => hostList,
  hasRemoteHosts: (state: { hosts: unknown[] }) => state.hosts.length > 0,
}));
vi.mock("@/services/ActionService", () => ({ actionService: { dispatch } }));
vi.mock("../hostMetricsFeed", () => ({ startHostMetricsFeed: () => () => {} }));

import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { WorktreePlacementRow } from "../WorktreePlacementRow";

function entry(id: string, cpuPercent: number, connected = true): HostListEntry {
  return {
    descriptor: {
      id,
      name: id,
      sshTarget: id,
      platform: "linux",
      arch: "x64",
      lastHandshake: null,
      lastSeenAt: null,
      addedAt: 0,
      notificationsEnabled: false,
    },
    connection: connected
      ? { status: "connected", rttMs: 5, handshake: HANDSHAKE }
      : { status: "disconnected" },
    summary: makeSummary({
      hostId: id,
      cpuPercent,
      agentsObserved: { working: 0, waiting: 0, idle: 0 },
    }),
  };
}

beforeEach(() => {
  dispatch.mockClear();
  useHostMetricsStore.getState().reset();
  hostList.hosts = [entry("studio-01", 70), entry("studio-02", 5), entry("away", 0, false)];
  useHostMetricsStore.getState().apply(
    makeSummary({
      hostId: "local",
      cpuPercent: 40,
      agentsObserved: { working: 0, waiting: 0, idle: 0 },
    })
  );
});

describe("WorktreePlacementRow", () => {
  it("always names the least-loaded reachable host while keeping this window's host chosen", () => {
    const onElsewhereChange = vi.fn();
    render(
      <WorktreePlacementRow
        projectId="p1"
        onLeave={() => {}}
        onElsewhereChange={onElsewhereChange}
      />
    );
    expect(screen.getByTestId("worktree-placement-suggestion").textContent).toBe(
      "Least loaded: studio-02 · CPU 5% · memory normal · 0 working (observed)"
    );
    expect(screen.queryByTestId("worktree-placement-continue")).toBeNull();
    expect(onElsewhereChange).toHaveBeenLastCalledWith(false);
  });

  it("lets the user take the suggestion and hands the project over to that host", async () => {
    const onLeave = vi.fn();
    const onElsewhereChange = vi.fn();
    render(
      <WorktreePlacementRow
        projectId="p1"
        onLeave={onLeave}
        onElsewhereChange={onElsewhereChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Use studio-02" }));
    expect(onElsewhereChange).toHaveBeenLastCalledWith(true);
    await act(async () => {
      fireEvent.click(screen.getByTestId("worktree-placement-continue"));
    });
    expect(onLeave).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(
      "project.openOnHost",
      { hostId: "studio-02", projectId: "p1" },
      { source: "user" }
    );
  });

  it("renders nothing until another host exists", () => {
    hostList.hosts = [];
    const { container } = render(<WorktreePlacementRow projectId="p1" onLeave={() => {}} />);
    expect(container.textContent).toBe("");
  });
});
