// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RemoteHostsEvent } from "@shared/types/ipc/remoteHosts";
import type { HostWorktreeEntry } from "@shared/types/ipc/hostMetrics";
import {
  _resetHostProjectsForTesting,
  useHostProjectLists,
  type HostProjectRef,
} from "../hostProjects";
import { useHostWorktreeListings } from "../hostWorktrees";
import { installHostProjectsLoader } from "../installHostProjectsLoader";

const HOSTS = ["studio", "studio-2"];
const listWorktrees = vi.fn<(payload: { hostId: string }) => Promise<HostWorktreeEntry[]>>();
const listHostProjects = vi.fn<(payload: { hostId: string }) => Promise<HostProjectRef[]>>();
let emit: ((event: RemoteHostsEvent) => void) | null = null;
let uninstall: (() => void) | null = null;

const project = (hostId: string): HostProjectRef => ({
  id: `${hostId}-app`,
  name: "app",
  path: "/srv/app",
});
const worktree = (hostId: string): HostWorktreeEntry => ({
  hostId,
  projectId: `${hostId}-app`,
  projectName: "app",
  worktreeId: "wt",
  name: "main",
  branch: "main",
  path: "/srv/app",
  isMainWorktree: true,
  modifiedCount: 0,
  lastActivityAt: null,
  observed: null,
});

function renderCatalogue() {
  return renderHook(() => ({
    projects: useHostProjectLists(HOSTS),
    worktrees: useHostWorktreeListings(HOSTS, true),
  }));
}

beforeEach(() => {
  _resetHostProjectsForTesting();
  listWorktrees.mockReset().mockImplementation(async ({ hostId }) => [worktree(hostId)]);
  listHostProjects.mockReset().mockImplementation(async ({ hostId }) => [project(hostId)]);
  vi.stubGlobal("electron", {
    hostMetrics: { listWorktrees },
    remoteHosts: {
      listHostProjects,
      onEvent: (callback: (event: RemoteHostsEvent) => void) => {
        emit = callback;
        return () => {
          emit = null;
        };
      },
    },
  });
  uninstall = installHostProjectsLoader();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  vi.unstubAllGlobals();
  _resetHostProjectsForTesting();
});

describe("a forgotten host's project and worktree lists", () => {
  it("go when the host is forgotten, though its id may stay listed, and no other host's do", async () => {
    const { result } = renderCatalogue();
    await waitFor(() => {
      expect(result.current.projects.size).toBe(2);
      expect(result.current.worktrees.size).toBe(2);
    });

    act(() => emit?.({ type: "host-forgotten", hostId: "studio" }));

    expect([...result.current.projects.keys()]).toEqual(["studio-2"]);
    expect([...result.current.worktrees.keys()]).toEqual(["studio-2"]);
  });

  it("drop the answers the old machine was still giving", async () => {
    let answerProjects!: () => void;
    let answerWorktrees!: () => void;
    listHostProjects.mockImplementation(async ({ hostId }) => {
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
    expect(answerProjects).toBeTypeOf("function");
    expect(answerWorktrees).toBeTypeOf("function");

    act(() => emit?.({ type: "host-forgotten", hostId: "studio" }));
    await act(async () => {
      answerProjects();
      answerWorktrees();
    });

    expect([...result.current.projects.keys()]).toEqual(["studio-2"]);
    expect([...result.current.worktrees.keys()]).toEqual(["studio-2"]);
  });
});
