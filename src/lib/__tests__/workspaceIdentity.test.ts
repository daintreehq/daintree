import { describe, it, expect } from "vitest";
import { activeWorkspaceIdentity } from "../workspaceIdentity";

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
