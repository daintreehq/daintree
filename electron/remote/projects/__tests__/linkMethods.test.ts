import { describe, expect, it } from "vitest";
import { OpenSchema, SourceDescriptionSchema, StartCloneSchema } from "../linkMethods.js";

const open = {
  projectId: "p1",
  path: "/home/greg/Projects/daintree",
  remoteUrls: ["https://example.test/daintree.git"],
  branch: null,
  branchRemoteUrl: null,
};
const start = {
  opId: "op-1",
  source: { kind: "remote", url: "https://example.test/daintree.git" },
  destination: "/home/greg/Projects/daintree",
  branch: null,
  options: { submodules: false, depth: "full" },
  setupRecipeId: null,
};

describe("a project's display identity on the link", () => {
  it("carries a usable one with a clone or an open", () => {
    const display = { name: "App", emoji: "🎸", color: null };
    expect(OpenSchema.parse({ ...open, display }).display).toEqual(display);
    expect(StartCloneSchema.parse({ ...start, display }).display).toEqual(display);
  });

  it("drops a malformed one without refusing the request, and needs none from an older Shell", () => {
    const bad = { name: "", emoji: 5 };
    expect(OpenSchema.parse({ ...open, display: bad }).display).toBeUndefined();
    expect(StartCloneSchema.parse({ ...start, display: bad }).display).toBeUndefined();
    expect("display" in OpenSchema.parse(open)).toBe(false);
    expect("display" in StartCloneSchema.parse(start)).toBe(false);
  });

  it("reads a source description from an older host, which sends none", () => {
    const parsed = SourceDescriptionSchema.safeParse({
      projectId: "p1",
      projectName: "daintree",
      projectPath: "/p",
      worktreePath: "/p",
      branch: null,
      branchCheck: null,
      remoteBranch: null,
      remote: null,
      cloneUrl: null,
      hasUncommittedChanges: false,
      unpushedCommits: [],
      remotes: [],
      committedProjectId: null,
      homeRelativePath: null,
      repoName: "daintree",
      usesLfs: false,
      hasSubmodules: false,
      recipes: [],
      defaultRecipeId: null,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.display).toBeUndefined();
  });
});
