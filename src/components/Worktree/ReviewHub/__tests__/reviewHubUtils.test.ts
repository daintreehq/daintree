import { describe, expect, it } from "vitest";
import { readGitErrorFields } from "../reviewHubUtils";

describe("readGitErrorFields", () => {
  it("decodes the preload's prefix when no own properties survive (post-contextBridge)", () => {
    // Simulates the renderer side of the bridge: only `message` and `stack`
    // crossed, custom Error properties were stripped. The doc comment claim
    // before #8567 said the properties survived — they did not. The fix is
    // that the prefix on `message` carries the discriminant.
    const err = new Error(
      "[GitError|push-rejected-outdated|deadbeef|feature%2Fmy-branch] rejected"
    );
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "push-rejected-outdated",
      leaseSha: "deadbeef",
      branchName: "feature/my-branch",
    });
  });

  it("returns gitReason but no leaseSha/branchName when the slots are empty", () => {
    const err = new Error("[GitError|auth-failed||] auth refused");
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "auth-failed",
      leaseSha: undefined,
      branchName: undefined,
    });
  });

  it("reads same-realm errors that already carry the fields as own properties", () => {
    // A test mock or main-process-side throw in the same realm — the properties
    // survive and isClientGitError's fallback recognises them.
    const err = Object.assign(new Error("rejected"), {
      name: "GitOperationError",
      gitReason: "push-rejected-outdated",
      leaseSha: "abc123",
      branchName: "main",
    });
    expect(readGitErrorFields(err)).toEqual({
      gitReason: "push-rejected-outdated",
      leaseSha: "abc123",
      branchName: "main",
    });
  });

  it("returns empty object for non-Error inputs", () => {
    expect(readGitErrorFields(null)).toEqual({});
    expect(readGitErrorFields(undefined)).toEqual({});
    expect(readGitErrorFields("oops")).toEqual({});
    expect(readGitErrorFields(42)).toEqual({});
    // Plain object with the right shape — still not an Error instance.
    // Tightening to instanceof Error keeps the surface area to actual thrown
    // errors and prevents accidental coercion of unrelated payloads.
    expect(readGitErrorFields({ gitReason: "push-rejected-outdated", leaseSha: "x" })).toEqual({});
  });

  it("returns empty object for a plain Error with no prefix and no own properties", () => {
    const err = new Error("just a message");
    expect(readGitErrorFields(err)).toEqual({
      gitReason: undefined,
      leaseSha: undefined,
      branchName: undefined,
    });
  });
});
