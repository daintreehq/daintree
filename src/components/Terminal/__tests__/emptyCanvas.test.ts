import { describe, it, expect } from "vitest";
import type { Scratch } from "@shared/types/scratch";
import { resolveEmptyCanvas } from "../emptyCanvas";

const scratch: Scratch = {
  id: "scratch-1",
  path: "/scratches/scratch-1",
  name: "Scratch 2026-07-12 09:30",
  createdAt: 0,
  lastOpened: 0,
};

const project = { id: "project-1" };

describe("resolveEmptyCanvas", () => {
  it("hands an empty scratch the launcher, not the welcome screen", () => {
    // #11076: switching to a scratch nulls the project pointer, which used to
    // read as "no workspace" and offer to open a folder the user already had.
    const canvas = resolveEmptyCanvas(null, scratch);

    expect(canvas.kind).toBe("scratch");
    expect(canvas).toEqual({ kind: "scratch", scratch });
  });

  it("leaves a project's empty canvas to the grid's own context", () => {
    expect(resolveEmptyCanvas(project, null)).toEqual({ kind: "project" });
  });

  it("welcomes a user with no workspace at all", () => {
    expect(resolveEmptyCanvas(null, null)).toEqual({ kind: "welcome" });
  });

  it("prefers the project when both pointers are transiently set", () => {
    expect(resolveEmptyCanvas(project, scratch)).toEqual({ kind: "project" });
  });
});
