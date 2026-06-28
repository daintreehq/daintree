import { describe, expect, it } from "vitest";
import path from "node:path";
import { PluginFsScopeSchema } from "../plugin.js";

function accepts(entry: string): boolean {
  return PluginFsScopeSchema.safeParse({ allowedPaths: [entry] }).success;
}

const ABS = path.resolve("/", "abs", "project", "src");

describe("PluginFsScopeSchema allowedPaths entries", () => {
  it("accepts literal absolute paths", () => {
    expect(accepts(ABS)).toBe(true);
  });

  it("accepts the ${project} and ${worktree} tokens, bare and with a suffix", () => {
    expect(accepts("${project}")).toBe(true);
    expect(accepts("${worktree}")).toBe(true);
    expect(accepts("${project}/src")).toBe(true);
    expect(accepts("${worktree}/deep/nested/path")).toBe(true);
  });

  it("rejects relative paths", () => {
    expect(accepts("relative/path")).toBe(false);
    expect(accepts("./rel")).toBe(false);
  });

  it("rejects unknown or malformed tokens", () => {
    expect(accepts("${workspace}")).toBe(false);
    expect(accepts("${project")).toBe(false);
    expect(accepts("$project")).toBe(false);
    expect(accepts("${project}suffix")).toBe(false);
    expect(accepts("prefix${project}")).toBe(false);
  });

  it("rejects `..` traversal in both tokens and literals", () => {
    expect(accepts("${project}/../secret")).toBe(false);
    expect(accepts("${worktree}/sub/../../escape")).toBe(false);
    // A raw `..` segment in a literal (not pre-collapsed by path.join) is rejected.
    expect(accepts("/abs/project/../escape")).toBe(false);
  });

  it("rejects wildcards anywhere", () => {
    expect(accepts(path.join(ABS, "*"))).toBe(false);
    expect(accepts("${project}/*")).toBe(false);
    expect(accepts("${worktree}/sub/*.ts")).toBe(false);
  });

  it("requires at least one entry", () => {
    expect(PluginFsScopeSchema.safeParse({ allowedPaths: [] }).success).toBe(false);
  });
});
