import { describe, expect, it } from "vitest";

import { advanceMruIndex, getMruProjects } from "../projectMru";
import type { Project } from "@shared/types";

function make(id: string, lastOpened: number, name = id): Project {
  return { id, path: `/repo/${id}`, name, emoji: "🌲", lastOpened };
}

describe("getMruProjects", () => {
  it("returns empty array for empty input", () => {
    expect(getMruProjects([])).toEqual([]);
  });

  it("sorts by lastOpened descending", () => {
    const projects = [make("a", 100), make("b", 300), make("c", 200)];
    const sorted = getMruProjects(projects);
    expect(sorted.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by name ascending", () => {
    const projects = [make("a", 100, "Zebra"), make("b", 100, "Alpha"), make("c", 100, "Mango")];
    const sorted = getMruProjects(projects);
    expect(sorted.map((p) => p.name)).toEqual(["Alpha", "Mango", "Zebra"]);
  });

  it("treats missing lastOpened as 0", () => {
    const projects: Project[] = [
      { id: "a", path: "/a", name: "A", emoji: "🌲" } as unknown as Project,
      make("b", 50),
    ];
    const sorted = getMruProjects(projects);
    expect(sorted.map((p) => p.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input array", () => {
    const projects = [make("a", 100), make("b", 300)];
    const snapshot = projects.map((p) => p.id);
    getMruProjects(projects);
    expect(projects.map((p) => p.id)).toEqual(snapshot);
  });
});

describe("advanceMruIndex", () => {
  it("returns currentIndex when length < 2", () => {
    expect(advanceMruIndex(1, "older", 1)).toBe(1);
    expect(advanceMruIndex(1, "newer", 0)).toBe(1);
  });

  it("advances older from 1 to 2", () => {
    expect(advanceMruIndex(1, "older", 5)).toBe(2);
  });

  it("wraps older from last index back to 1", () => {
    expect(advanceMruIndex(4, "older", 5)).toBe(1);
  });

  it("advances newer from last toward 1", () => {
    expect(advanceMruIndex(4, "newer", 5)).toBe(3);
  });

  it("wraps newer from 1 to last index (skipping 0)", () => {
    expect(advanceMruIndex(1, "newer", 5)).toBe(4);
  });

  it("with length 2, older/newer cycle only between indices 1 and 1", () => {
    expect(advanceMruIndex(1, "older", 2)).toBe(1);
    expect(advanceMruIndex(1, "newer", 2)).toBe(1);
  });

  it("clamps sub-1 index back to 1 on older", () => {
    expect(advanceMruIndex(0, "older", 5)).toBe(1);
  });

  it("clamps above-range index on newer (list shrank mid-session)", () => {
    expect(advanceMruIndex(3, "newer", 2)).toBe(1);
  });

  it("wraps above-range index on older (list shrank mid-session)", () => {
    expect(advanceMruIndex(5, "older", 3)).toBe(1);
  });
});
