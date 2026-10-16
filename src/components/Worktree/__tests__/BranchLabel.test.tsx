import { describe, expect, it } from "vitest";
import { Bot, Bug, GitBranch, Sparkle } from "lucide-react";
import { CodexIcon } from "@/components/icons/brands";
import { BRANCH_TYPES } from "@shared/config/branchPrefixes";
import { splitBranchType } from "../BranchLabel";

describe("splitBranchType", () => {
  it("gives every branch type a glyph of its own", () => {
    const icons = BRANCH_TYPES.map((type) => splitBranchType(`${type.prefix}/x`).Icon);
    expect(icons.every((icon) => icon !== null && icon !== GitBranch)).toBe(true);
    expect(new Set(icons).size).toBe(BRANCH_TYPES.length);
  });

  it("draws a work type nested under an agent, keeping the rest of the path", () => {
    expect(splitBranchType("codex/fix/login")).toMatchObject({
      displayName: "Bugfix",
      Icon: Bug,
      prefix: "codex",
      rest: "fix/login",
    });
  });

  it("draws the agent's own mark when no work type is nested", () => {
    expect(splitBranchType("codex/login")).toMatchObject({
      displayName: "Codex",
      Icon: CodexIcon,
      rest: "login",
    });
    expect(splitBranchType("devin/login")).toMatchObject({ displayName: "Devin", Icon: Bot });
  });

  it("draws a type glyph beside a hyphenated name without cutting it", () => {
    expect(splitBranchType("feature-login")).toMatchObject({
      displayName: "Feature",
      Icon: Sparkle,
      prefix: "",
      rest: "feature-login",
    });
  });

  it("keeps the generic look for an unknown prefix and a bare name", () => {
    expect(splitBranchType("alice/login")).toEqual({
      displayName: "Alice",
      Icon: GitBranch,
      prefix: "alice",
      rest: "login",
    });
    expect(splitBranchType("my-branch")).toEqual({
      displayName: null,
      Icon: null,
      prefix: "",
      rest: "my-branch",
    });
    expect(splitBranchType("CI-42-flaky-test").Icon).toBeNull();
  });

  it("does not read an Object.prototype name as a type", () => {
    expect(splitBranchType("constructor/foo")).toMatchObject({ Icon: GitBranch, rest: "foo" });
  });
});
