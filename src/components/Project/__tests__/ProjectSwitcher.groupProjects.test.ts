import { describe, it, expect } from "vitest";
import type { Project, ProjectStats } from "@shared/types";
import { groupProjects } from "../projectGrouping";

function makeProject(overrides: Partial<Project> & Pick<Project, "id" | "path" | "name">): Project {
  return {
    id: overrides.id,
    path: overrides.path,
    name: overrides.name,
    emoji: overrides.emoji ?? "🌲",
    lastOpened: overrides.lastOpened ?? Date.now(),
    color: overrides.color,
    status: overrides.status,
    pinned: overrides.pinned,
  };
}

function makeStats(overrides: Partial<ProjectStats>): ProjectStats {
  return {
    processCount: overrides.processCount ?? 0,
    terminalCount: overrides.terminalCount ?? 0,
    estimatedMemoryMB: overrides.estimatedMemoryMB ?? 0,
    terminalTypes: overrides.terminalTypes ?? {},
    processIds: overrides.processIds ?? [],
  };
}

describe("ProjectSwitcher groupProjects", () => {
  it("places non-current projects with running terminals in Background (not Recent)", () => {
    const projectA = makeProject({ id: "a", path: "/a", name: "A", status: "closed" });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", status: "active" });

    const stats = new Map<string, ProjectStats>();
    stats.set(projectA.id, makeStats({ processCount: 2, terminalCount: 2 }));
    stats.set(projectB.id, makeStats({ processCount: 1, terminalCount: 1 }));

    const grouped = groupProjects([projectA, projectB], projectB.id, stats);

    expect(grouped.active.map((p) => p.id)).toEqual(["b"]);
    expect(grouped.background.map((p) => p.id)).toEqual(["a"]);
    expect(grouped.recent.map((p) => p.id)).toEqual([]);
  });

  it("treats status === 'active' as active only when currentProjectId is unknown", () => {
    const projectA = makeProject({ id: "a", path: "/a", name: "A", status: "active" });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", status: "background" });

    const groupedWithUnknown = groupProjects([projectA, projectB], null, new Map());
    expect(groupedWithUnknown.active.map((p) => p.id)).toEqual(["a"]);

    const groupedWithCurrent = groupProjects([projectA, projectB], projectB.id, new Map());
    expect(groupedWithCurrent.active.map((p) => p.id)).toEqual(["b"]);
  });

  it("places pinned non-active projects in the pinned group", () => {
    const projectA = makeProject({ id: "a", path: "/a", name: "A", pinned: true });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", status: "active" });
    const projectC = makeProject({ id: "c", path: "/c", name: "C" });

    const grouped = groupProjects([projectA, projectB, projectC], projectB.id, new Map());

    expect(grouped.pinned.map((p) => p.id)).toEqual(["a"]);
    expect(grouped.active.map((p) => p.id)).toEqual(["b"]);
    expect(grouped.recent.map((p) => p.id)).toEqual(["c"]);
  });

  it("keeps active project in active group even if pinned (no duplication)", () => {
    const projectA = makeProject({
      id: "a",
      path: "/a",
      name: "A",
      pinned: true,
      status: "active",
    });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", pinned: true });

    const grouped = groupProjects([projectA, projectB], projectA.id, new Map());

    expect(grouped.active.map((p) => p.id)).toEqual(["a"]);
    expect(grouped.pinned.map((p) => p.id)).toEqual(["b"]);

    // Verify no project appears in multiple groups
    const allIds = [
      ...grouped.pinned.map((p) => p.id),
      ...grouped.active.map((p) => p.id),
      ...grouped.background.map((p) => p.id),
      ...grouped.recent.map((p) => p.id),
    ];
    expect(allIds).toHaveLength(new Set(allIds).size);
  });

  it("places pinned projects with running processes in pinned (not background)", () => {
    const projectA = makeProject({
      id: "a",
      path: "/a",
      name: "A",
      pinned: true,
      status: "background",
    });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", status: "active" });

    const stats = new Map<string, ProjectStats>();
    stats.set(projectA.id, makeStats({ processCount: 3, terminalCount: 2 }));

    const grouped = groupProjects([projectA, projectB], projectB.id, stats);

    expect(grouped.pinned.map((p) => p.id)).toEqual(["a"]);
    expect(grouped.background.map((p) => p.id)).toEqual([]);
  });

  it("sorts pinned projects by lastOpened descending", () => {
    const projectA = makeProject({ id: "a", path: "/a", name: "A", pinned: true, lastOpened: 100 });
    const projectB = makeProject({ id: "b", path: "/b", name: "B", pinned: true, lastOpened: 300 });
    const projectC = makeProject({ id: "c", path: "/c", name: "C", pinned: true, lastOpened: 200 });

    const grouped = groupProjects([projectA, projectB, projectC], null, new Map());

    expect(grouped.pinned.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("returns empty pinned array when no projects are pinned", () => {
    const projectA = makeProject({ id: "a", path: "/a", name: "A" });

    const grouped = groupProjects([projectA], null, new Map());

    expect(grouped.pinned).toEqual([]);
  });
});
