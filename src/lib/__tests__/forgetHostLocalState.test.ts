// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { forgetHostLocalState, installForgetHostLocalState } from "../forgetHostLocalState";
import { useCommandHistoryStore } from "@/store/commandHistoryStore";
import { useHostMetricsStore } from "@/store/hostMetricsStore";
import { useTwoPaneSplitStore } from "@/store/twoPaneSplitStore";
import { useUrlHistoryStore } from "@/store/urlHistoryStore";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import type { HostMetricsSummary } from "@shared/types/remoteHosts";
import { backupKeyFor } from "@/store/persistence/safeStorage";
import {
  _resetCrossHostFleetForTesting,
  armCrossHostTarget,
  getArmedCrossHostTargets,
} from "@/components/Fleet/crossHostFleet";
import {
  _resetHostProjectsForTesting,
  setHostProjectsLoader,
  useHostProjectLists,
  type HostProjectRef,
} from "@/components/Hosts/hostProjects";
import { useHostWorktreeListings } from "@/components/Hosts/hostWorktrees";
import { hostEnvDrafts, type HostEnvDraft } from "@/components/Settings/Hosts/hostEnvDrafts";

const LOCAL = "a".repeat(64);

function seed(): void {
  useCommandHistoryStore.setState({
    history: { "studio:p1": [], "studio-2:p1": [], [LOCAL]: [] },
  });
  useUrlHistoryStore.setState({ entries: { "studio:p1": [], [LOCAL]: [] } });
  useTwoPaneSplitStore.setState({
    ratioByWorktreeId: {
      "studio:wt": { ratio: 0.5, panels: ["a", "b"] },
      "studio-2:wt": { ratio: 0.4, panels: ["a", "b"] },
    },
  });
  localStorage.setItem("daintree_cmd_history_studio:p1", "[]");
  localStorage.setItem("daintree_quickrun_expanded_studio:p1", "true");
  localStorage.setItem("daintree_quickrun_autorestart_studio-2:p1", "true");
  localStorage.setItem(`daintree_quickrun_expanded_${LOCAL}`, "true");
  localStorage.setItem("daintree-sidebar-view:studio:p1", "{}");
  localStorage.setItem(backupKeyFor("daintree-sidebar-view:studio:p1"), "{}");
  localStorage.setItem("daintree-sidebar-view:studio-2:p1", "{}");
  localStorage.setItem(`daintree-sidebar-view:${LOCAL}`, "{}");
  localStorage.setItem("unrelated_studio:p1", "kept");
}

describe("forgetHostLocalState", () => {
  beforeEach(() => {
    localStorage.clear();
    seed();
  });

  it("drops the removed host's entries from every store and QuickRun key, and nothing else", () => {
    forgetHostLocalState("studio");

    expect(Object.keys(useCommandHistoryStore.getState().history).sort()).toEqual(
      [LOCAL, "studio-2:p1"].sort()
    );
    expect(Object.keys(useUrlHistoryStore.getState().entries)).toEqual([LOCAL]);
    expect(Object.keys(useTwoPaneSplitStore.getState().ratioByWorktreeId)).toEqual(["studio-2:wt"]);
    expect(localStorage.getItem("daintree_cmd_history_studio:p1")).toBeNull();
    expect(localStorage.getItem("daintree_quickrun_expanded_studio:p1")).toBeNull();
    expect(localStorage.getItem("daintree_quickrun_autorestart_studio-2:p1")).toBe("true");
    expect(localStorage.getItem(`daintree_quickrun_expanded_${LOCAL}`)).toBe("true");
    expect(localStorage.getItem("daintree-sidebar-view:studio:p1")).toBeNull();
    expect(localStorage.getItem(backupKeyFor("daintree-sidebar-view:studio:p1"))).toBeNull();
    expect(localStorage.getItem("daintree-sidebar-view:studio-2:p1")).toBe("{}");
    expect(localStorage.getItem(`daintree-sidebar-view:${LOCAL}`)).toBe("{}");
    expect(localStorage.getItem("unrelated_studio:p1")).toBe("kept");
  });

  it("scrubs entries only another view knew, from each stored copy and its backup", () => {
    // Nothing of the host in this view's memory, so no store writes over the
    // stored copies: what is left there is the scrub's work alone.
    useCommandHistoryStore.setState({ history: {} });
    useUrlHistoryStore.setState({ entries: {} });
    useTwoPaneSplitStore.setState({ ratioByWorktreeId: {} });
    const stores = [
      { name: useCommandHistoryStore.persist.getOptions().name!, field: "history" },
      { name: useUrlHistoryStore.persist.getOptions().name!, field: "entries" },
      { name: useTwoPaneSplitStore.persist.getOptions().name!, field: "ratioByWorktreeId" },
    ];
    const stored = (field: string) =>
      JSON.stringify({
        state: { [field]: { "studio:disk-only": 1, "studio-2:disk-only": 2 }, other: 1 },
        version: 3,
      });
    for (const { name, field } of stores) {
      localStorage.setItem(name, stored(field));
      localStorage.setItem(backupKeyFor(name), stored(field));
    }
    localStorage.setItem("daintree:host-build-noticed:studio\u00001.0\u0000abc", "1");
    localStorage.setItem("daintree:host-build-noticed:studio-2\u00001.0\u0000abc", "1");

    forgetHostLocalState("studio");

    for (const { name, field } of stores) {
      for (const key of [name, backupKeyFor(name)]) {
        expect(JSON.parse(localStorage.getItem(key)!)).toEqual({
          state: { [field]: { "studio-2:disk-only": 2 }, other: 1 },
          version: 3,
        });
      }
    }
    expect(localStorage.getItem("daintree:host-build-noticed:studio\u00001.0\u0000abc")).toBeNull();
    expect(localStorage.getItem("daintree:host-build-noticed:studio-2\u00001.0\u0000abc")).toBe(
      "1"
    );
  });

  it("leaves a store untouched when it holds nothing of the host", () => {
    const before = useUrlHistoryStore.getState().entries;
    forgetHostLocalState("elsewhere");
    expect(useUrlHistoryStore.getState().entries).toBe(before);
  });
});

describe("installForgetHostLocalState", () => {
  let listener: ((event: RemoteHostsEvent) => void) | null = null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    seed();
    vi.stubGlobal("electron", {
      remoteHosts: {
        onEvent: (callback: (event: RemoteHostsEvent) => void) => {
          listener = callback;
          return unsubscribe;
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("clears a host when main says it was removed, and ignores other events", () => {
    const dispose = installForgetHostLocalState();
    listener!({ type: "project-offer" });
    expect(useUrlHistoryStore.getState().entries).toHaveProperty("studio:p1");
    listener!({ type: "host-forgotten", hostId: "studio" });
    expect(useUrlHistoryStore.getState().entries).not.toHaveProperty("studio:p1");
    dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("forgetHostLocalState: what the host's id still holds in memory", () => {
  const HOSTS = ["studio", "studio-2"];
  const listWorktrees = vi.fn<(payload: { hostId: string }) => Promise<HostWorktreeEntry[]>>();
  const loadProjects = vi.fn<(hostId: string) => Promise<HostProjectRef[]>>();

  const project = (hostId: string): HostProjectRef => ({
    id: `${hostId}-app`,
    name: "app",
    path: "/srv/app",
  });
  const worktree = (hostId: string) =>
    ({ hostId, projectId: `${hostId}-app`, worktreeId: "wt", name: "main" }) as HostWorktreeEntry;
  const draft = (value: string): HostEnvDraft => ({
    rows: [{ id: "r1", key: "TOKEN", value }],
    base: { record: {}, revision: "r1" },
    movedUnder: false,
  });
  const summary = (hostId: string) => ({ hostId, sampledAt: 1 }) as HostMetricsSummary;

  function renderCatalogue() {
    return renderHook(() => ({
      projects: useHostProjectLists(HOSTS),
      worktrees: useHostWorktreeListings(HOSTS, true),
    }));
  }

  beforeEach(() => {
    localStorage.clear();
    _resetHostProjectsForTesting();
    _resetCrossHostFleetForTesting();
    useHostMetricsStore.getState().reset();
    hostEnvDrafts.clear();
    listWorktrees.mockReset().mockImplementation(async ({ hostId }) => [worktree(hostId)]);
    loadProjects.mockReset().mockImplementation(async (hostId) => [project(hostId)]);
    vi.stubGlobal("electron", { hostMetrics: { listWorktrees } });
    setHostProjectsLoader(loadProjects);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _resetHostProjectsForTesting();
    _resetCrossHostFleetForTesting();
    hostEnvDrafts.clear();
  });

  it("clears the host's drafts, fleet agents, lists and load history, and no other host's", async () => {
    const { result } = renderCatalogue();
    await waitFor(() => {
      expect(result.current.projects.size).toBe(2);
      expect(result.current.worktrees.size).toBe(2);
    });
    for (const hostId of HOSTS) {
      armCrossHostTarget({ hostId, hostName: hostId, terminalId: "t1", title: "Claude" });
      hostEnvDrafts.set(hostId, draft(hostId));
      useHostMetricsStore.getState().apply(summary(hostId));
    }

    act(() => forgetHostLocalState("studio"));

    expect([...result.current.projects.keys()]).toEqual(["studio-2"]);
    expect([...result.current.worktrees.keys()]).toEqual(["studio-2"]);
    expect(getArmedCrossHostTargets().map((t) => t.hostId)).toEqual(["studio-2"]);
    expect(hostEnvDrafts.get("studio")).toBeUndefined();
    expect(hostEnvDrafts.get("studio-2")).toEqual(draft("studio-2"));
    expect(hostEnvDrafts.firstUnsaved(() => true)).toBe("studio-2");
    expect([...useHostMetricsStore.getState().history.keys()]).toEqual(["studio-2"]);
  });

  it("drops lists the old machine was still answering with", async () => {
    let answerProjects!: () => void;
    let answerWorktrees!: () => void;
    loadProjects.mockImplementation(async (hostId) => {
      if (hostId === "studio") await new Promise<void>((resolve) => (answerProjects = resolve));
      return [project(hostId)];
    });
    listWorktrees.mockImplementation(async ({ hostId }) => {
      if (hostId === "studio") await new Promise<void>((resolve) => (answerWorktrees = resolve));
      return [worktree(hostId)];
    });
    const { result } = renderCatalogue();
    await waitFor(() => {
      expect([...result.current.projects.keys()]).toEqual(["studio-2"]);
      expect([...result.current.worktrees.keys()]).toEqual(["studio-2"]);
    });

    act(() => forgetHostLocalState("studio"));
    await act(async () => {
      answerProjects();
      answerWorktrees();
    });

    expect([...result.current.projects.keys()]).toEqual(["studio-2"]);
    expect([...result.current.worktrees.keys()]).toEqual(["studio-2"]);
  });
});
