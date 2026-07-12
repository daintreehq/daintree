import { describe, it, expect } from "vitest";
import { activeWorkspaceIdentity, branchChipState } from "../workspaceIdentity";

const project = { name: "daintree" };
const scratch = { name: "Spike: retry queue" };

describe("activeWorkspaceIdentity", () => {
  it("reports the project when one is open", () => {
    const identity = activeWorkspaceIdentity(project, null);
    expect(identity.kind).toBe("project");
    expect(identity.name).toBe(project.name);
    expect(identity.ariaLabel).toContain(project.name);
  });

  it("falls back to the scratch when no project is open", () => {
    const identity = activeWorkspaceIdentity(null, scratch);
    expect(identity.kind).toBe("scratch");
    expect(identity.name).toBe(scratch.name);
    expect(identity.ariaLabel).toContain(scratch.name);
  });

  it("distinguishes a scratch from a project in the accessible label", () => {
    const projectLabel = activeWorkspaceIdentity({ name: "shared" }, null).ariaLabel;
    const scratchLabel = activeWorkspaceIdentity(null, { name: "shared" }).ariaLabel;
    expect(scratchLabel).not.toBe(projectLabel);
    expect(scratchLabel).toMatch(/scratch/i);
    expect(projectLabel).not.toMatch(/scratch/i);
  });

  it("lets a project win over a stale scratch pointer", () => {
    const identity = activeWorkspaceIdentity(project, scratch);
    expect(identity.kind).toBe("project");
    expect(identity.name).toBe(project.name);
  });

  it("reports no workspace when both pointers are empty", () => {
    const identity = activeWorkspaceIdentity(null, null);
    expect(identity.kind).toBe("none");
    // The empty state must still label the pill with an action, not a blank.
    expect(identity.name.length).toBeGreaterThan(0);
    expect(identity.ariaLabel.length).toBeGreaterThan(0);
  });

  it("labels the empty state with an action verb, not brand text", () => {
    const identity = activeWorkspaceIdentity(null, null);
    expect(identity.name).toMatch(/^Open\b/);
    expect(identity.name).not.toMatch(/daintree/i);
  });

  it("treats undefined like null", () => {
    expect(activeWorkspaceIdentity(undefined, undefined).kind).toBe("none");
    expect(activeWorkspaceIdentity(undefined, scratch).kind).toBe("scratch");
  });
});

describe("branchChipState", () => {
  it("shows the branch for a project on a branch", () => {
    expect(branchChipState("project", "feature/x")).toBe("visible");
  });

  it("drops the chip entirely for a scratch workspace — issue #11084", () => {
    // A scratch is never a git repo, so the chip has nothing to say and must leave
    // the layout: a merely-faded chip still reserves blank width beside the name.
    expect(branchChipState("scratch", undefined)).toBe("hidden");
  });

  it("drops the chip for a scratch even if a stale branch is still selected", () => {
    // The worktree selection is not scratch-aware, so a branch can linger in the
    // store after switching to a scratch. The workspace kind, not the branch, decides.
    expect(branchChipState("scratch", "feature/x")).toBe("hidden");
  });

  it("reserves the chip's width for a branchless project", () => {
    // Detached HEAD, or a view that painted before its project bound. The branch may
    // still arrive, so the width is held rather than collapsed — a late expansion
    // would shift the titlebar's no-drag region.
    expect(branchChipState("project", undefined)).toBe("reserved");
  });

  it("reserves rather than shows in the empty state, even with a stale branch", () => {
    // Closing a project nulls it without clearing the worktree selection, so the
    // branch outlives it. It must not linger visibly beside "Open project".
    expect(branchChipState("none", undefined)).toBe("reserved");
    expect(branchChipState("none", "feature/x")).toBe("reserved");
  });

  it("never shows a branch outside a project", () => {
    const outsideProject = (["scratch", "none"] as const).map((kind) =>
      branchChipState(kind, "feature/x")
    );
    expect(outsideProject).not.toContain("visible");
  });
});
