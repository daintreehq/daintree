import { describe, expect, it } from "vitest";

import { getMruProjects } from "../projectMru.js";
import type { Project } from "../../types/project.js";

function make(id: string, lastOpened: number, name = id): Project {
  return { id, path: `/repo/${id}`, name, emoji: "🌲", lastOpened };
}

describe("getMruProjects", () => {
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
