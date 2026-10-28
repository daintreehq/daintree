import { describe, it, expect } from "vitest";
import { ContextMenuContributionSchema } from "../plugin.js";

const base = { actionId: "acme.plugin.action", label: "Do it" };

describe("ContextMenuContributionSchema location", () => {
  it("accepts every live location", () => {
    for (const location of ["worktree", "terminal", "file", "browser", "project"]) {
      expect(ContextMenuContributionSchema.safeParse({ ...base, location }).success).toBe(true);
    }
  });

  it("rejects a location with no consumer", () => {
    expect(ContextMenuContributionSchema.safeParse({ ...base, location: "panel" }).success).toBe(
      false
    );
  });
});

describe("ContextMenuContributionSchema file match", () => {
  const file = { ...base, location: "file" };

  it("accepts kind, extensions and paths on a file item", () => {
    expect(
      ContextMenuContributionSchema.safeParse({
        ...file,
        kind: "file",
        extensions: ["json"],
        paths: ["records/**"],
      }).success
    ).toBe(true);
    expect(ContextMenuContributionSchema.safeParse({ ...file, kind: "folder" }).success).toBe(true);
  });

  it.each([
    ["kind", "file"],
    ["extensions", ["json"]],
    ["paths", ["a/**"]],
  ])("rejects %s on a non-file location", (key, value) => {
    expect(
      ContextMenuContributionSchema.safeParse({ ...base, location: "worktree", [key]: value })
        .success
    ).toBe(false);
  });

  it("rejects extensions on a folder item", () => {
    expect(
      ContextMenuContributionSchema.safeParse({ ...file, kind: "folder", extensions: ["md"] })
        .success
    ).toBe(false);
  });

  it("rejects dotted or upper-case extensions and escaping paths", () => {
    expect(ContextMenuContributionSchema.safeParse({ ...file, extensions: [".md"] }).success).toBe(
      false
    );
    expect(ContextMenuContributionSchema.safeParse({ ...file, extensions: ["MD"] }).success).toBe(
      false
    );
    expect(ContextMenuContributionSchema.safeParse({ ...file, paths: ["../x"] }).success).toBe(
      false
    );
    expect(ContextMenuContributionSchema.safeParse({ ...file, kind: "directory" }).success).toBe(
      false
    );
  });
});
