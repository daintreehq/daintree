import { describe, expect, it } from "vitest";
import { CopyTreeOptionsSchema, CopyTreeTestConfigOptionsSchema } from "../ipc.js";

/**
 * The IPC half of the selection guard (#11722).
 *
 * `filter` and `includePaths` are one selection set, unioned in
 * `CopyTreeService`. An empty selection cannot be expressed to the CopyTree SDK
 * — it reads a missing or empty filter as "no filter" and returns the whole
 * worktree — so an empty list or a blank entry has to be rejected at the
 * boundary rather than normalized downstream. Getting this wrong turns a
 * malformed narrow request into a full-repo bundle on the user's clipboard,
 * which is why it is pinned on both schemas independently: the renderer action
 * schema guards MCP/palette callers, this one guards everything that reaches
 * the main process.
 */
describe("CopyTreeOptionsSchema selection guards", () => {
  const parse = (options: unknown) => CopyTreeOptionsSchema.safeParse(options).success;

  it("rejects a selection that would resolve to nothing", () => {
    for (const options of [
      { includePaths: [] },
      { includePaths: [""] },
      { includePaths: ["src/a.ts", ""] },
      { filter: [] },
      { filter: [""] },
      { filter: "" },
    ]) {
      expect(parse(options)).toBe(false);
    }
  });

  it("accepts a real selection in either spelling, and both together", () => {
    expect(parse({ includePaths: ["src/a.ts"] })).toBe(true);
    expect(parse({ filter: "src/**" })).toBe(true);
    expect(parse({ filter: ["src/**"] })).toBe(true);
    expect(parse({ includePaths: ["src/a.ts"], filter: ["tests/**"] })).toBe(true);
  });

  it("still treats an omitted selection as the whole worktree", () => {
    // Absent is the one shape that legitimately means "everything" — the guard
    // above must not have made the field effectively required.
    expect(parse({})).toBe(true);
    expect(parse({ format: "xml" })).toBe(true);
  });
});

/**
 * The ignore-file escape is scope-bound (#11750): the SDK only consults it while
 * walking `scope` entries, so `scopeIgnoresIgnoreFiles` without `scopePaths` is
 * inert. Accepting it would hand back a short bundle and say nothing — the exact
 * failure the issue was filed about — so the boundary names the missing field
 * instead. Pinned here and on the renderer action schema; neither derives from
 * the other.
 */
describe("CopyTreeOptionsSchema ignore-file bypass guard", () => {
  const parse = (options: unknown) => CopyTreeOptionsSchema.safeParse(options);

  it("accepts the bypass when a scope was named", () => {
    expect(parse({ scopePaths: ["docs"], scopeIgnoresIgnoreFiles: true }).success).toBe(true);
  });

  it("rejects the bypass when nothing scopes it, whatever else the request carries", () => {
    for (const options of [
      { scopeIgnoresIgnoreFiles: true },
      // Neither pattern spelling scopes anything: both feed the SDK's `filter`,
      // which the escape never looks at.
      { scopeIgnoresIgnoreFiles: true, includePaths: ["docs/guide.md"] },
      { scopeIgnoresIgnoreFiles: true, filter: ["docs/**"] },
      // `always` is a force-include, not a selection — it would not rescue this
      // even though it happens to defeat ignore files by other means.
      { scopeIgnoresIgnoreFiles: true, always: ["docs/**"] },
      { scopeIgnoresIgnoreFiles: true, modified: true },
    ]) {
      expect(parse(options).success).toBe(false);
    }
  });

  it("points the failure at the flag and names what it needs", () => {
    const result = parse({ scopeIgnoresIgnoreFiles: true });

    // A caller acts on the issue, not on `success: false`. Asserting the path
    // and the named field is what makes the rejection worth more than silence.
    const issue = result.success ? undefined : result.error.issues[0];
    expect(issue?.path).toEqual(["scopeIgnoresIgnoreFiles"]);
    expect(issue?.message).toContain("scopePaths");
  });

  it("leaves every request that did not ask for the bypass alone", () => {
    // The guard must fire on the opt-in only — never on absence, and never on
    // the default spelled out, which builds the same bundle as omitting it.
    expect(parse({}).success).toBe(true);
    expect(parse({ scopeIgnoresIgnoreFiles: false }).success).toBe(true);
    expect(parse({ includePaths: ["src/a.ts"] }).success).toBe(true);
  });

  it("applies the same rule to a test-config dry run", () => {
    // The dry-run variant re-types six fields as nullable and is built from the
    // same object base. A refinement attached to only one of the two would let
    // the settings preview disagree with the run it is previewing.
    expect(
      CopyTreeTestConfigOptionsSchema.safeParse({ scopeIgnoresIgnoreFiles: true }).success
    ).toBe(false);
    expect(
      CopyTreeTestConfigOptionsSchema.safeParse({
        scopePaths: ["docs"],
        scopeIgnoresIgnoreFiles: true,
        // Cleared-field sentinel, to prove the base's nullable overrides survived
        // being re-wrapped by the refinement.
        always: null,
      }).success
    ).toBe(true);
  });
});
