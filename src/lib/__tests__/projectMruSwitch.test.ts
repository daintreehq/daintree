import { describe, expect, it } from "vitest";

import type { Project } from "@shared/types";
import { getProjectMruSwitchTarget } from "../projectMruSwitch";

function make(id: string, lastOpened: number, name = id): Project {
  return {
    id,
    path: `/repo/${id}`,
    name,
    emoji: "🌲",
    lastOpened,
  } as Project;
}

describe("getProjectMruSwitchTarget", () => {
  it("targets the MRU head for 'older' when no current project is set (scratch active)", () => {
    // Supplied out of MRU order: "b" is the freshest, so it's the project that
    // was active immediately before the scratch took over (#11085).
    const projects = [make("a", 100), make("b", 200)];
    expect(getProjectMruSwitchTarget(projects, null, "older")?.id).toBe("b");
    expect(getProjectMruSwitchTarget(projects, undefined, "older")?.id).toBe("b");
  });

  it("targets the MRU tail for 'newer' when no current project is set", () => {
    const projects = [make("a", 100), make("b", 200)];
    expect(getProjectMruSwitchTarget(projects, null, "newer")?.id).toBe("a");
    expect(getProjectMruSwitchTarget(projects, undefined, "newer")?.id).toBe("a");
  });

  it("returns the sole project in both directions when no current project is set", () => {
    const projects = [make("a", 100)];
    expect(getProjectMruSwitchTarget(projects, null, "older")?.id).toBe("a");
    expect(getProjectMruSwitchTarget(projects, null, "newer")?.id).toBe("a");
  });

  it("returns null when no current project is set and no projects exist", () => {
    expect(getProjectMruSwitchTarget([], null, "older")).toBeNull();
    expect(getProjectMruSwitchTarget([], null, "newer")).toBeNull();
  });

  it("returns null when the current project is not in the list", () => {
    // A stale id is inconsistent state, not the deliberate "no anchor" that a
    // null id means — it must stay a no-op rather than firing a surprise switch.
    const projects = [make("a", 100), make("b", 200)];
    expect(getProjectMruSwitchTarget(projects, "ghost", "older")).toBeNull();
    expect(getProjectMruSwitchTarget(projects, "ghost", "newer")).toBeNull();
  });

  it("returns null when only the current project exists", () => {
    const projects = [make("a", 100)];
    expect(getProjectMruSwitchTarget(projects, "a", "older")).toBeNull();
    expect(getProjectMruSwitchTarget(projects, "a", "newer")).toBeNull();
  });

  it("returns the top non-current MRU entry for 'older'", () => {
    // active is "a" (lastOpened: 300); the most-recent OTHER project is "b".
    const projects = [make("a", 300), make("b", 200), make("c", 100)];
    const target = getProjectMruSwitchTarget(projects, "a", "older");
    expect(target?.id).toBe("b");
  });

  it("returns the bottom non-current MRU entry for 'newer'", () => {
    const projects = [make("a", 300), make("b", 200), make("c", 100)];
    const target = getProjectMruSwitchTarget(projects, "a", "newer");
    expect(target?.id).toBe("c");
  });

  it("'older' selects the bumped previous project after a switch (Alt+Tab toggle)", () => {
    // Simulates the post-switch state after setCurrentProject A→B: A was
    // bumped to (now - 1), B to now. From B, 'older' must land on A again,
    // not on the alphabetically-first stale project.
    const now = 1_000_000;
    const projects = [
      make("a", now - 1, "Alpha"),
      make("b", now, "Bravo"),
      make("c", now - 50_000, "Charlie"),
    ];
    expect(getProjectMruSwitchTarget(projects, "b", "older")?.id).toBe("a");
  });

  it("breaks ties by name when lastOpened is equal", () => {
    // Two projects share lastOpened; the name-sort tiebreak picks Alpha
    // (matches getMruProjects behavior).
    const projects = [make("a", 100, "Alpha"), make("b", 100, "Bravo"), make("c", 50, "Charlie")];
    expect(getProjectMruSwitchTarget(projects, "c", "older")?.id).toBe("a");
  });
});
