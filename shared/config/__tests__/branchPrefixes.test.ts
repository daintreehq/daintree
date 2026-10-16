import { describe, expect, it } from "vitest";
import { BRANCH_TYPES, classifyBranch, lookupBranchType } from "../branchPrefixes.js";

function typeOf(branch: string): string | null {
  return classifyBranch(branch).type?.id ?? null;
}

describe("BRANCH_TYPES", () => {
  it("never claims one prefix for two types", () => {
    const seen = new Map<string, string>();
    for (const type of BRANCH_TYPES) {
      for (const prefix of [type.prefix, ...type.aliases]) {
        const key = prefix.toLowerCase();
        expect(seen.get(key), `${key} claimed by ${seen.get(key)} and ${type.id}`).toBeUndefined();
        seen.set(key, type.id);
      }
    }
  });

  it("never names a namespace with a type prefix", () => {
    for (const namespace of ["claude", "codex", "copilot", "cursor", "devin", "ai", "renovate"]) {
      expect(lookupBranchType(namespace)).toBeNull();
    }
  });

  it("resolves every prefix and alias back to its own type", () => {
    for (const type of BRANCH_TYPES) {
      for (const prefix of [type.prefix, ...type.aliases]) {
        expect(typeOf(`${prefix}/x`)).toBe(type.id);
        expect(typeOf(`${prefix.toUpperCase()}/x`)).toBe(type.id);
      }
    }
  });
});

describe("classifyBranch", () => {
  it.each([
    ["design/sidebar", "design"],
    ["design-review/sidebar", "design"],
    ["hotfix/login", "hotfix"],
    ["build/vite", "build"],
    ["ci/cache", "ci"],
    ["spike/idea", "experiment"],
    ["cherry-pick/x", "backport"],
  ])("reads %s as %s", (branch, type) => {
    expect(typeOf(branch)).toBe(type);
  });

  it("folds only the first slash segment into the glyph", () => {
    expect(classifyBranch("feature/auth/login")).toMatchObject({
      prefix: "feature",
      rest: "auth/login",
    });
  });

  it("keeps a work type nested under an agent namespace", () => {
    const result = classifyBranch("codex/fix/login");
    expect(result.type?.id).toBe("bugfix");
    expect(result.namespace).toMatchObject({ id: "codex", kind: "agent" });
    expect(result).toMatchObject({ prefix: "codex", rest: "fix/login" });
  });

  it("gives an agent branch with no nested type no work type", () => {
    for (const branch of ["codex/login", "claude/fix", "Copilot/add-x", "ai/try-this"]) {
      const result = classifyBranch(branch);
      expect(result.type, branch).toBeNull();
      expect(result.namespace?.kind, branch).toBe("agent");
    }
  });

  it("files bot branches under the work their bot does", () => {
    expect(typeOf("dependabot/npm_and_yarn/vite-8.0.14")).toBe("deps");
    expect(typeOf("renovate/react-19.x")).toBe("deps");
    expect(typeOf("greenkeeper/lodash-4")).toBe("deps");
    expect(typeOf("changeset-release/main")).toBe("release");
    expect(typeOf("dependabot/fix/thing")).toBe("bugfix");
  });

  it("recognises generated release-please and GitHub revert names", () => {
    expect(classifyBranch("release-please--branches--main")).toMatchObject({
      type: { id: "release" },
      prefix: "",
      rest: "release-please--branches--main",
    });
    expect(classifyBranch("revert-123-feature/login")).toMatchObject({
      type: { id: "revert" },
      prefix: "",
      rest: "revert-123-feature/login",
    });
  });

  it("reads a type nested under a person's namespace", () => {
    const result = classifyBranch("alice/feature/login");
    expect(result.type?.id).toBe("feature");
    expect(result.namespace).toMatchObject({ id: "alice", kind: "user" });
  });

  it("leaves a two-segment unknown prefix alone", () => {
    expect(classifyBranch("alice/login")).toMatchObject({
      type: null,
      namespace: null,
      prefix: "alice",
      rest: "login",
    });
    // The second segment of a two-segment name is the branch's name, not a type.
    expect(typeOf("alice/feature")).toBeNull();
    expect(typeOf("alice//feature/x")).toBeNull();
  });

  it("reads a lowercase hyphenated type with no slash", () => {
    expect(classifyBranch("feature-login")).toMatchObject({
      type: { id: "feature" },
      prefix: "",
      rest: "feature-login",
    });
    expect(typeOf("design-review-header")).toBe("design");
    expect(typeOf("fix-typo")).toBe("bugfix");
  });

  it("reads a hyphenated type off the first segment of a slashed name, whole", () => {
    expect(classifyBranch("feature-login/step-2")).toMatchObject({
      type: { id: "feature" },
      prefix: "",
      rest: "feature-login/step-2",
    });
    expect(typeOf("FEATURE-login/step-2")).toBeNull();
  });

  it("reads a dependency bot's hyphenated branch as dependencies", () => {
    expect(typeOf("dependabot-vite-8")).toBe("deps");
    expect(typeOf("renovate-react-19")).toBe("deps");
    // An agent's name is not a work type, hyphenated or not.
    expect(typeOf("codex-login")).toBeNull();
  });

  it.each(["CI-42-flaky-test", "UI-7-header", "DB-1-schema", "feature-", "feature", "my-branch"])(
    "does not read a type into %s",
    (branch) => {
      expect(typeOf(branch)).toBeNull();
    }
  );

  it.each(["constructor/foo", "__proto__/x", "toString-x", "hasOwnProperty/a/b"])(
    "is not fooled by Object.prototype names (%s)",
    (branch) => {
      expect(classifyBranch(branch)).toMatchObject({ type: null, namespace: null });
    }
  );

  it("treats an Object.prototype name as a person's namespace, nothing more", () => {
    expect(classifyBranch("valueOf/feature/x")).toMatchObject({
      type: { id: "feature" },
      namespace: { id: "valueOf", kind: "user" },
    });
  });

  it("leaves a bare name whole", () => {
    expect(classifyBranch("main")).toEqual({
      type: null,
      namespace: null,
      prefix: "",
      rest: "main",
    });
  });
});
