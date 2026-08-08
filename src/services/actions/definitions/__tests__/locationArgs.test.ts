import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import {
  withWorktreeLocation,
  withProjectLocation,
  worktreeLocationShape,
  resolveWorktreeLocation,
  resolveProjectLocation,
  requireWorktreePath,
  requireWorktreeId,
  requireExplicitWorktreeForAgentDispatch,
  requireProjectPath,
} from "../locationArgs";
import { withPagination, PaginatedResultSchema, decodeIndexCursor } from "../schemas";
import {
  setWorktreePathIndexAccessor,
  setProjectPathIndexAccessor,
  resetStoreAccessorsForTesting,
} from "@/store/storeAccessors";

const emptyContext: ActionContext = {};

/** Mirrors ActionService.zodSchemaToJsonSchema so these assert the real MCP surface. */
function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    reused: "inline",
    cycles: "ref",
    target: "draft-2020-12",
  }) as Record<string, unknown>;
}

function properties(schema: z.ZodType): Record<string, { description?: string }> {
  return (toInputSchema(schema).properties ?? {}) as Record<string, { description?: string }>;
}

/** The exact expression ActionService uses to derive `requiresArgs`. */
function computeRequiresArgs(schema: z.ZodType): boolean {
  return !schema.safeParse(undefined).success && !schema.safeParse({}).success;
}

describe("withWorktreeLocation", () => {
  it("advertises canonical selectors and only the legacy aliases the tool opted into", () => {
    const props = properties(
      withWorktreeLocation({ search: z.string().optional() }, { legacy: ["cwd"] })
    );

    expect(Object.keys(props).sort()).toEqual(["cwd", "search", "worktreeId", "worktreePath"]);
    // An alias must point the caller at the canonical name it stands in for,
    // and must not read as an independent argument.
    expect(props.cwd?.description).toMatch(/alias for `worktreePath`/i);
    // The canonical selector must state where a caller gets an id and what
    // omitting it does — that fallback used to be restated in every tool's own
    // description, and this field is now its only home (#11542). Referencing
    // the source capability in prose rather than by action id is deliberate:
    // clients rewrite every character outside [A-Za-z0-9_-] when namespacing a
    // tool, so a literal `worktree.list` names something the model never sees.
    expect(props.worktreeId?.description).toMatch(/worktree-listing capability/i);
    expect(props.worktreeId?.description).toMatch(/active worktree/i);
  });

  it("does not add legacy aliases to tools that never accepted them", () => {
    const props = properties(withWorktreeLocation({}));
    expect(Object.keys(props).sort()).toEqual(["worktreeId", "worktreePath"]);
  });

  it("folds each legacy alias into worktreePath and strips the alias key", () => {
    const schema = withWorktreeLocation({}, { legacy: ["cwd", "rootPath"] });

    expect(schema.parse({ cwd: "/repo" })).toEqual({ worktreePath: "/repo" });
    expect(schema.parse({ rootPath: "/repo" })).toEqual({ worktreePath: "/repo" });
    expect(schema.parse({ worktreePath: "/repo" })).toEqual({ worktreePath: "/repo" });
  });

  it("preserves the tool's own fields through the transform", () => {
    const schema = withWorktreeLocation({ search: z.string().optional() }, { legacy: ["cwd"] });
    expect(schema.parse({ cwd: "/repo", search: "fix" })).toEqual({
      worktreePath: "/repo",
      search: "fix",
    });
  });

  it("leaves a tool's own field alone when it shares a name with an unopted alias", () => {
    // `path` is only an alias for tools that opt in. A tool that declares its
    // own `path` must keep it — and must not have it folded into worktreePath.
    const schema = withWorktreeLocation({ path: z.string() }, { legacy: ["cwd"] });

    expect(schema.parse({ path: "src/index.ts" })).toEqual({ path: "src/index.ts" });
    expect(schema.parse({ path: "src/index.ts", cwd: "/repo" })).toEqual({
      path: "src/index.ts",
      worktreePath: "/repo",
    });
  });

  it("rejects two path spellings that disagree", () => {
    const schema = withWorktreeLocation({}, { legacy: ["cwd", "rootPath"] });
    expect(schema.safeParse({ cwd: "/a", rootPath: "/b" }).success).toBe(false);
  });

  it("accepts two path spellings that agree", () => {
    const schema = withWorktreeLocation({}, { legacy: ["cwd"] });
    expect(schema.parse({ cwd: "/a", worktreePath: "/a" })).toEqual({ worktreePath: "/a" });
  });

  it("keeps requiresArgs false when the tool has an active-worktree fallback", () => {
    expect(computeRequiresArgs(withWorktreeLocation({}, { legacy: ["cwd"] }))).toBe(false);
  });

  it("keeps requiresArgs true when the tool demands an explicit selector", () => {
    const schema = withWorktreeLocation({}, { legacy: ["rootPath"], requireSelector: true });

    expect(computeRequiresArgs(schema)).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.parse({ rootPath: "/repo" })).toEqual({ worktreePath: "/repo" });
    expect(schema.parse({ worktreeId: "wt-1" })).toEqual({ worktreeId: "wt-1" });
  });

  it("rejects an empty selector rather than silently retargeting the active worktree", () => {
    // An empty string that parsed successfully would read as "absent" to the
    // resolver, so a destructive call naming `cwd: ""` would run against
    // whatever worktree happens to be active.
    const schema = withWorktreeLocation({}, { legacy: ["cwd"] });

    expect(schema.safeParse({ cwd: "" }).success).toBe(false);
    expect(schema.safeParse({ worktreePath: "" }).success).toBe(false);
    expect(schema.safeParse({ worktreeId: "" }).success).toBe(false);
  });

  it("still advertises the object shape when wrapped in .optional()", () => {
    const props = properties(withWorktreeLocation({}, { legacy: ["cwd"] }).optional());
    expect(Object.keys(props).sort()).toEqual(["cwd", "worktreeId", "worktreePath"]);
  });
});

describe("withProjectLocation", () => {
  it("advertises both project selectors alongside the tool's own fields", () => {
    const props = properties(withProjectLocation({ tab: z.string().optional() }));
    expect(Object.keys(props).sort()).toEqual(["projectId", "projectPath", "tab"]);
  });

  it("stays extendable, unlike the transformed worktree builder", () => {
    // Nothing needs folding for projects, so this must not become a ZodPipe.
    const extended = withProjectLocation({}).extend({ extra: z.string().optional() });
    expect(Object.keys(properties(extended)).sort()).toEqual(["extra", "projectId", "projectPath"]);
  });

  it("rejects an empty selector rather than treating it as absent", () => {
    expect(withProjectLocation({}).safeParse({ projectId: "" }).success).toBe(false);
  });
});

describe("resolveProjectLocation", () => {
  beforeEach(() => {
    setProjectPathIndexAccessor(() => new Map([["proj-a", "/projects/a"]]));
  });
  afterEach(() => {
    resetStoreAccessorsForTesting();
  });

  it("resolves an explicit projectId to its own path, not the active project's", () => {
    // Returning no path here would be worse than rejecting the argument: every
    // consumer falls back to the active project, so naming another project
    // would silently operate on the active one.
    const ctx: ActionContext = { projectId: "proj-active", projectPath: "/projects/active" };
    expect(resolveProjectLocation({ projectId: "proj-a" }, ctx)).toEqual({
      projectId: "proj-a",
      projectPath: "/projects/a",
    });
  });

  it("throws on an id no open project has", () => {
    expect(() => resolveProjectLocation({ projectId: "nope" }, {})).toThrow(/Unknown project/);
  });

  it("degrades to the context project when no index is registered at all", () => {
    // A null index means missing wiring (store never imported, or between a
    // store-orchestrator destroy and the next init) — not a bad argument. It
    // must not reject an id it simply cannot check.
    resetStoreAccessorsForTesting();
    const ctx: ActionContext = { projectId: "proj-active", projectPath: "/projects/active" };
    expect(resolveProjectLocation({ projectId: "proj-a" }, ctx)).toEqual({
      projectId: "proj-a",
      projectPath: "/projects/active",
    });
  });

  it("falls back to the context project when no selector is given", () => {
    const ctx: ActionContext = { projectId: "proj-active", projectPath: "/projects/active" };
    expect(resolveProjectLocation(undefined, ctx)).toEqual({
      projectId: "proj-active",
      projectPath: "/projects/active",
    });
  });
});

describe("resolveWorktreeLocation", () => {
  beforeEach(() => {
    setWorktreePathIndexAccessor(() => new Map([["wt-1", "/repo/one"]]));
  });
  afterEach(() => {
    resetStoreAccessorsForTesting();
  });

  it("prefers an explicit id over an explicit path and fills the missing half", () => {
    expect(
      resolveWorktreeLocation({ worktreeId: "wt-1", worktreePath: "/repo/other" }, emptyContext)
    ).toEqual({ worktreeId: "wt-1", worktreePath: "/repo/one" });
  });

  it("reverse-resolves an id from a known path", () => {
    expect(resolveWorktreeLocation({ worktreePath: "/repo/one" }, emptyContext)).toEqual({
      worktreeId: "wt-1",
      worktreePath: "/repo/one",
    });
  });

  it("passes an unknown path through without inventing an id", () => {
    expect(resolveWorktreeLocation({ worktreePath: "/elsewhere" }, emptyContext)).toEqual({
      worktreeId: undefined,
      worktreePath: "/elsewhere",
    });
  });

  it("falls back to the active worktree when no selector is supplied", () => {
    const ctx: ActionContext = { activeWorktreeId: "wt-9", activeWorktreePath: "/repo/nine" };
    expect(resolveWorktreeLocation(undefined, ctx)).toEqual({
      worktreeId: "wt-9",
      worktreePath: "/repo/nine",
    });
  });

  it("rejects contradictory spellings on the spread composition too", () => {
    // `worktreeLocationShape` has no transform, so the schema cannot catch this
    // — the resolver has to, or forge tools would silently pick a winner while
    // the builder-composed tools reject the same input.
    const parsed = z.object(worktreeLocationShape({ legacy: ["cwd"] })).parse({
      worktreePath: "/repo/a",
      cwd: "/repo/b",
    });
    expect(() => resolveWorktreeLocation(parsed, emptyContext)).toThrow(/only one/i);
  });

  it("resolves with no view store mounted", () => {
    resetStoreAccessorsForTesting();
    expect(resolveWorktreeLocation({ worktreeId: "wt-1" }, emptyContext)).toEqual({
      worktreeId: "wt-1",
      worktreePath: undefined,
    });
  });
});

describe("require* helpers throw rather than returning failure as data", () => {
  beforeEach(() => {
    setWorktreePathIndexAccessor(() => new Map([["wt-1", "/repo/one"]]));
  });
  afterEach(() => {
    resetStoreAccessorsForTesting();
  });

  it("returns the resolved path for a known id", () => {
    expect(requireWorktreePath({ worktreeId: "wt-1" }, emptyContext)).toBe("/repo/one");
  });

  it("distinguishes an unknown id from an absent selector", () => {
    expect(() => requireWorktreePath({ worktreeId: "nope" }, emptyContext)).toThrow(
      /Unknown worktree/
    );
    expect(() => requireWorktreePath(undefined, emptyContext)).toThrow(/No active worktree/);
  });

  it("never interpolates the rejected value into the message", () => {
    const secret = "/Users/someone/secret-project";
    try {
      requireWorktreePath({ worktreePath: undefined, worktreeId: secret }, emptyContext);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it("resolves an id from a path for id-based IPC", () => {
    expect(requireWorktreeId({ worktreePath: "/repo/one" }, emptyContext)).toBe("wt-1");
    expect(() => requireWorktreeId({ worktreePath: "/elsewhere" }, emptyContext)).toThrow(
      /Unknown worktree/
    );
  });

  it("requireProjectPath falls back to the context project", () => {
    expect(requireProjectPath(undefined, { projectPath: "/proj" })).toBe("/proj");
    expect(() => requireProjectPath(undefined, emptyContext)).toThrow(/No active project/);
  });
});

describe("withPagination", () => {
  it("advertises limit and offset, plus opted-in cursor and legacy skip", () => {
    const props = properties(withPagination({}, { legacy: ["skip"], cursor: true }));
    expect(Object.keys(props).sort()).toEqual(["cursor", "limit", "offset", "skip"]);
    expect(props.skip?.description).toMatch(/alias for `offset`/i);
  });

  it("folds skip into offset and strips the alias", () => {
    const schema = withPagination({}, { legacy: ["skip"] });
    expect(schema.parse({ skip: 20 })).toEqual({ offset: 20 });
    expect(schema.parse({ offset: 20 })).toEqual({ offset: 20 });
  });

  it("rejects skip and offset that disagree", () => {
    const schema = withPagination({}, { legacy: ["skip"] });
    expect(schema.safeParse({ skip: 10, offset: 20 }).success).toBe(false);
    expect(schema.safeParse({ skip: 10, offset: 10 }).success).toBe(true);
  });

  it("enforces a ceiling only when the action sets one", () => {
    expect(withPagination({}, { maxLimit: 100 }).safeParse({ limit: 101 }).success).toBe(false);
    expect(withPagination({}, { maxLimit: 100 }).safeParse({ limit: 100 }).success).toBe(true);
    expect(withPagination({}).safeParse({ limit: 5000 }).success).toBe(true);
  });

  it("keeps requiresArgs false so paginated queries stay palette-dispatchable", () => {
    expect(computeRequiresArgs(withPagination({}, { legacy: ["skip"] }))).toBe(false);
  });

  it("composes with a worktree location without losing either half", () => {
    const schema = withWorktreeLocation(
      { search: z.string().optional() },
      { legacy: ["cwd"], pagination: { legacy: ["skip"] } }
    );

    expect(Object.keys(properties(schema)).sort()).toEqual([
      "cwd",
      "limit",
      "offset",
      "search",
      "skip",
      "worktreeId",
      "worktreePath",
    ]);
    // Both folds run: the path alias and the pagination alias collapse together.
    expect(schema.parse({ cwd: "/repo", skip: 10, limit: 5 })).toEqual({
      worktreePath: "/repo",
      offset: 10,
      limit: 5,
    });
    expect(schema.safeParse({ skip: 1, offset: 2 }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/a", worktreePath: "/b" }).success).toBe(false);
  });
});

describe("decodeIndexCursor", () => {
  it("round-trips an offset emitted as nextCursor", () => {
    expect(decodeIndexCursor(String(40))).toBe(40);
    expect(decodeIndexCursor("0")).toBe(0);
    expect(decodeIndexCursor(undefined)).toBeUndefined();
  });

  it("rejects a cursor that would silently restart or run backwards", () => {
    // Falling back to page zero on garbage looks like a successful re-read of
    // the first page; a negative offset would reach `git log --skip`.
    for (const bad of ["abc", "", "-1", "1.5", "NaN", "9007199254740993"]) {
      expect(() => decodeIndexCursor(bad)).toThrow(/Invalid cursor/);
    }
  });

  it("never echoes the rejected cursor back to the caller", () => {
    const secret = "/Users/someone/private";
    try {
      decodeIndexCursor(secret);
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });
});

describe("PaginatedResultSchema", () => {
  it("survives output-mode JSON Schema generation (result schemas must not be transformed)", () => {
    const schema = PaginatedResultSchema(z.object({ id: z.string() }));
    const json = z.toJSONSchema(schema, {
      io: "output",
      unrepresentable: "any",
      reused: "inline",
      cycles: "ref",
      target: "draft-2020-12",
    }) as { properties?: Record<string, unknown> };

    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "hasMore",
      "items",
      "nextCursor",
      "total",
    ]);
  });

  it("requires nextCursor to be present and nullable", () => {
    const schema = PaginatedResultSchema(z.object({ id: z.string() }));
    expect(schema.safeParse({ items: [], hasMore: false, nextCursor: null }).success).toBe(true);
    expect(schema.safeParse({ items: [], hasMore: false }).success).toBe(false);
  });
});

describe("requireExplicitWorktreeForAgentDispatch", () => {
  const agentCtx: ActionContext = { dispatchSource: "agent", activeWorktreeId: "wt-active" };
  const call =
    (args: Parameters<typeof requireExplicitWorktreeForAgentDispatch>[1], ctx = agentCtx) =>
    (): void =>
      requireExplicitWorktreeForAgentDispatch("copyTree.generateAndCopyFile", args, ctx);

  it("rejects an agent dispatch that names no worktree, even when one is active", () => {
    // The whole point: an active worktree must NOT satisfy the guard, or a
    // headless caller silently inherits whatever the user happens to be on.
    expect(call(undefined)).toThrow(/requires an explicit/);
    expect(call({})).toThrow(/requires an explicit/);
  });

  it("names the action and both accepted selectors so the agent can self-correct", () => {
    expect(call(undefined)).toThrow(
      "copyTree.generateAndCopyFile requires an explicit `worktreeId` or `worktreePath` when dispatched by an agent or MCP client — pass the `id` or `path` from the worktree-listing capability."
    );
  });

  it("accepts either explicit selector", () => {
    expect(call({ worktreeId: "wt-1" })).not.toThrow();
    expect(call({ worktreePath: "/repo/feature" })).not.toThrow();
  });

  it("ignores a blank selector rather than treating it as explicit", () => {
    // `.min(1)` in the schema rejects these first, but the guard is exported and
    // must not be the layer that accepts an empty string as a named target.
    expect(call({ worktreeId: "" })).toThrow(/requires an explicit/);
    expect(call({ worktreePath: "" })).toThrow(/requires an explicit/);
  });

  it("leaves every non-agent dispatch on the active-worktree fallback", () => {
    // Includes the source-less shape used by action unit tests and by any
    // dispatch that carries no context at all — the guard must fail open there,
    // which is why it compares to "agent" instead of negating an allowlist.
    for (const source of ["user", "keybinding", "plugin", undefined] as const) {
      expect(
        call(undefined, { dispatchSource: source, activeWorktreeId: "wt-active" })
      ).not.toThrow();
    }
    expect(call(undefined, {})).not.toThrow();
  });
});
