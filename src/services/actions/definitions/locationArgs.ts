import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { getWorktreePathIndex, getProjectPathIndex } from "@/store/storeAccessors";
import { paginationShape, foldPagination, type PaginationOptions } from "./schemas";

/**
 * Shared location-argument vocabulary for the MCP tool surface (#11543).
 *
 * Before this, six spellings identified the same two resources — `worktreeId`,
 * `worktreePath`, `cwd`, `rootPath`, `projectId`, `projectPath` — and which one
 * a tool wanted varied by namespace and even between the read and write halves
 * of one resource. The rule now:
 *
 * - A worktree-scoped tool accepts `worktreeId` (preferred) or `worktreePath`.
 * - A project-scoped tool accepts `projectId` (preferred) or `projectPath`.
 * - `cwd` / `rootPath` stay accepted as legacy aliases for `worktreePath`, but
 *   ONLY on the tools that already spelled it that way — they are not added to
 *   the surface of tools that never had them, and they are not applied where
 *   `cwd` means an operation-specific directory rather than a worktree root
 *   (`agent.launch`'s PTY launch dir, `artifact.saveToFile`'s save dir).
 * - Omitting every selector targets the active worktree / project.
 * - An explicit id wins over an explicit path.
 *
 * Argument names are not part of the action-id contract, so the legacy spellings
 * keep working; only the documented name converges.
 *
 * The alias collapse happens in the zod schema rather than in the MCP bridge
 * because every surface (MCP, palette, keybindings, context menus) funnels
 * through `ActionService.dispatch`, which validates `argsSchema` before the
 * handler ever runs.
 *
 * The collapse is a whole-object `.transform()` because
 * `z.toJSONSchema(..., { io: "input" })` unwraps it and still advertises every
 * alias property with its own description — verified against the installed zod,
 * and asserted in `locationArgs.test.ts` so a zod upgrade that changed it would
 * fail rather than silently empty the advertised tool surface. The matching
 * `io: "output"` call collapses a transformed schema to `{}`, which is why a
 * `resultSchema` must never be transformed.
 */

/** Legacy spellings that a tool may keep accepting for `worktreePath`. */
export type LegacyWorktreePathAlias = "cwd" | "rootPath" | "path";

const legacyAliasDescription = (canonical: string): string =>
  `Legacy alias for \`${canonical}\`; prefer \`${canonical}\`.`;

/**
 * Every selector is `.min(1)`. An empty string must be a validation error, not
 * a silent fallback to the active worktree/project: the resolvers below treat
 * "absent" as "use the active one", so an empty selector that parsed
 * successfully would retarget a destructive call at whatever happens to be
 * active. Before the shared vocabulary existed each handler's own
 * `if (!resolved) throw` caught that; `.min(1)` is what replaces it.
 */
const selectorField = (description: string) => z.string().min(1).optional().describe(description);

/**
 * These four descriptions are the single home for location semantics (#11542).
 * They used to be restated in every worktree-scoped tool's own description —
 * "defaults to the active worktree" appeared verbatim on 14 tools, and the
 * no-active-worktree failure on more. Stating it here puts it on the wire once
 * per field instead of once per tool, and keeps it correct when the fallback
 * changes.
 *
 * Sibling capabilities are named in prose rather than by action id: a client
 * replaces every character outside `[A-Za-z0-9_-]` when it namespaces a tool,
 * so a literal `worktree.list` here refers to a name the model never sees.
 */
const worktreeIdField = selectorField(
  "Identifies the worktree to act on, using an id from the worktree-listing capability. Omit this and the path to target the active worktree; the call fails when neither is given and no worktree is active."
);

const worktreePathField = selectorField(
  "Identifies the worktree to act on by absolute root path, as an alternative to its id. The id wins when both are given, and an unknown path fails rather than falling back to the active worktree."
);

const projectIdField = selectorField(
  "Identifies the project to act on, using an id from the project-listing capability. Omit this and the path to target the active project; an id that names no open project fails."
);

const projectPathField = selectorField(
  "Identifies the project to act on by absolute root path, as an alternative to its id. The id wins when both are given."
);

/**
 * The location half of a worktree-scoped tool's arguments, after alias collapse.
 * Legacy alias keys are stripped, so a handler only ever reads the canonical two.
 */
export interface WorktreeLocationArgs {
  worktreeId?: string;
  worktreePath?: string;
  /**
   * Legacy spellings. Present only when the schema was composed with
   * {@link worktreeLocationShape} (a plain spread, no transform); the
   * {@link withWorktreeLocation} builder folds them away before `run()` sees
   * them. The resolver accepts either form, so both compositions behave alike.
   */
  cwd?: string;
  rootPath?: string;
  path?: string;
}

export interface ProjectLocationArgs {
  projectId?: string;
  projectPath?: string;
}

type WorktreeLocationOptions = {
  /**
   * Legacy path spellings this tool already accepted. Only list what the tool
   * historically took — every entry adds a property to the advertised
   * `inputSchema`, so the surface should not grow for tools that never had them.
   */
  legacy?: readonly LegacyWorktreePathAlias[];
  /**
   * When true, at least one selector must be supplied — the tool has no active
   * worktree fallback. Keeps `requiresArgs` true for tools that previously had a
   * required location argument, so the palette still routes them correctly.
   */
  requireSelector?: boolean;
  /**
   * Merge the canonical pagination fields in as well. Needed because a
   * transformed schema cannot be `.extend()`ed, so a tool that both paginates
   * and takes a location must build one flat shape instead of chaining builders.
   */
  pagination?: PaginationOptions;
};

/**
 * The worktree location fields on their own, for a schema that cannot use the
 * {@link withWorktreeLocation} builder — typically one assembled by spreading
 * into an existing `z.object({...})`. The advertised MCP surface is identical;
 * only the schema-level alias collapse is skipped, so `run()` must go through
 * {@link resolveWorktreeLocation} (which folds the aliases itself).
 */
export function worktreeLocationShape(
  options: { legacy?: readonly LegacyWorktreePathAlias[] } = {}
): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    worktreeId: worktreeIdField,
    worktreePath: worktreePathField,
  };
  for (const alias of options.legacy ?? []) {
    shape[alias] = selectorField(legacyAliasDescription("worktreePath"));
  }
  return shape;
}

/**
 * Collapse same-kind path aliases into `worktreePath`.
 *
 * Only same-kind conflicts can be detected here: two different *path* spellings
 * disagreeing is a caller error we can reject purely. An id disagreeing with a
 * path cannot be checked without a store lookup, which a sync/pure transform
 * must not do — that precedence (id wins) is applied by
 * {@link resolveWorktreeLocation} instead.
 */
function collapseWorktreePath(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  legacy: readonly LegacyWorktreePathAlias[]
): Record<string, unknown> | typeof z.NEVER {
  // Only the aliases this tool opted into are consumed. A tool that declares its
  // own unrelated `path`/`cwd` field keeps it — folding every spelling
  // unconditionally would silently swallow a caller's real argument.
  const rest = { ...value };
  const supplied: string[] = [];
  if (typeof rest.worktreePath === "string") supplied.push(rest.worktreePath);
  for (const alias of legacy) {
    const candidate = rest[alias];
    delete rest[alias];
    if (typeof candidate === "string") supplied.push(candidate);
  }

  if (new Set(supplied).size > 1) {
    ctx.addIssue({
      code: "custom",
      message:
        "`worktreePath` and its legacy aliases name the same value — supply only one, or identical values.",
    });
    return z.NEVER;
  }

  const worktreePath = supplied[0];
  return worktreePath === undefined ? rest : { ...rest, worktreePath };
}

/**
 * Build a worktree-scoped `argsSchema`: the canonical selectors, any legacy
 * aliases this tool already accepted, plus the tool's own fields.
 *
 * The extra fields are merged onto the base object BEFORE the transform, because
 * a transformed schema is a `ZodPipe` and can no longer be `.extend()`ed.
 *
 * ```ts
 * argsSchema: withWorktreeLocation(
 *   { search: z.string().optional() },
 *   { legacy: ["cwd"] }
 * )
 * ```
 */
export function withWorktreeLocation<T extends z.ZodRawShape>(
  extra: T,
  options: WorktreeLocationOptions = {}
) {
  const { legacy = [], requireSelector = false, pagination } = options;

  const shape: Record<string, z.ZodTypeAny> = {
    worktreeId: worktreeIdField,
    worktreePath: worktreePathField,
  };
  for (const alias of legacy) {
    shape[alias] = selectorField(legacyAliasDescription("worktreePath"));
  }
  if (pagination) Object.assign(shape, paginationShape(pagination));

  return z.object({ ...shape, ...extra }).transform((value, ctx) => {
    const collapsed = collapseWorktreePath(value as Record<string, unknown>, ctx, legacy);
    if (collapsed === z.NEVER) return z.NEVER;
    const paged = pagination ? foldPagination(collapsed, ctx, pagination.legacy ?? []) : collapsed;
    if (paged === z.NEVER) return z.NEVER;
    const located = paged as Record<string, unknown> & WorktreeLocationArgs;
    if (requireSelector && !located.worktreeId && !located.worktreePath) {
      ctx.addIssue({
        code: "custom",
        message:
          "Supply `worktreeId` or `worktreePath` — this action has no active-worktree default.",
      });
      return z.NEVER;
    }
    return located as Omit<z.core.output<z.ZodObject<T>>, keyof WorktreeLocationArgs> &
      WorktreeLocationArgs;
  });
}

/**
 * Build a project-scoped `argsSchema`: both project selectors plus the tool's
 * own fields.
 *
 * Unlike {@link withWorktreeLocation} there is nothing to fold — `projectId` and
 * `projectPath` are both canonical, since several tools genuinely receive a path
 * and never had an id to fold it into. So this returns a plain `ZodObject`
 * rather than a transformed one, which keeps it `.extend()`-able. Precedence
 * (id wins, resolved through the project index) lives in
 * {@link resolveProjectLocation}.
 */
export function withProjectLocation<T extends z.ZodRawShape>(extra: T) {
  return z.object({
    projectId: projectIdField,
    projectPath: projectPathField,
    ...extra,
  });
}

export interface ResolvedWorktreeLocation {
  worktreeId: string | undefined;
  worktreePath: string | undefined;
}

/**
 * Resolve a worktree-scoped tool's selectors to whichever half its IPC needs.
 *
 * Precedence: explicit `worktreeId`, then explicit `worktreePath`, then the
 * active worktree from {@link ActionContext}. The missing half is filled in from
 * the current view's worktree index when it is known; it stays `undefined` when
 * no view store is mounted, which callers surface via the `require*` helpers.
 */
export function resolveWorktreeLocation(
  args: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): ResolvedWorktreeLocation {
  const index = getWorktreePathIndex();

  // Fold the legacy spellings here too, so a schema composed by spreading
  // `worktreeLocationShape` (no transform) resolves identically to one built by
  // `withWorktreeLocation` — including rejecting contradictory spellings, which
  // the builder catches in the schema but the spread composition cannot.
  const suppliedPaths = [args?.worktreePath, args?.cwd, args?.rootPath, args?.path].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0
  );
  if (new Set(suppliedPaths).size > 1) {
    throw new Error(
      "`worktreePath` and its legacy aliases name the same value — supply only one, or identical values."
    );
  }

  if (args?.worktreeId) {
    return { worktreeId: args.worktreeId, worktreePath: index?.get(args.worktreeId) };
  }

  const suppliedPath = suppliedPaths[0];

  if (suppliedPath) {
    const path = suppliedPath;
    let matchedId: string | undefined;
    if (index) {
      for (const [id, candidate] of index) {
        if (candidate === path) {
          matchedId = id;
          break;
        }
      }
    }
    return { worktreeId: matchedId, worktreePath: path };
  }

  return {
    worktreeId: ctx.activeWorktreeId ?? undefined,
    worktreePath: ctx.activeWorktreePath ?? undefined,
  };
}

/**
 * The worktree path for a tool whose IPC is path-based. Throws so the failure
 * reaches the MCP transport as a tool error rather than being serialized as a
 * successful result (`ActionService` maps a thrown handler error to
 * `EXECUTION_ERROR`, which the bridge turns into an `isError` response).
 *
 * Messages are static — a rejected value is never interpolated, since zod's
 * `ZodError.message` in v4 carries the offending input inline.
 */
export function requireWorktreePath(
  args: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): string {
  const { worktreeId, worktreePath } = resolveWorktreeLocation(args, ctx);
  if (worktreePath) return worktreePath;
  if (worktreeId) {
    throw new Error("Unknown worktree — no worktree with that id is open in this project.");
  }
  throw new Error("No active worktree — supply `worktreeId` or `worktreePath`.");
}

/** The worktree id for a tool whose IPC is id-based. See {@link requireWorktreePath}. */
export function requireWorktreeId(
  args: WorktreeLocationArgs | undefined,
  ctx: ActionContext
): string {
  const { worktreeId, worktreePath } = resolveWorktreeLocation(args, ctx);
  if (worktreeId) return worktreeId;
  if (worktreePath) {
    throw new Error("Unknown worktree — no open worktree matches that path.");
  }
  throw new Error("No active worktree — supply `worktreeId` or `worktreePath`.");
}

/**
 * Resolve a project-scoped tool's selectors against the action context.
 *
 * An explicit `projectId` is resolved to its path through the project index.
 * Returning it without a path would be worse than not accepting the argument at
 * all: every consumer falls back to the ACTIVE project's path, so naming
 * another project would silently operate on the active one.
 */
export function resolveProjectLocation(
  args: ProjectLocationArgs | undefined,
  ctx: ActionContext
): { projectId: string | undefined; projectPath: string | undefined } {
  if (args?.projectId) {
    // Reject only when the index can PROVE the id is unknown. A null index means
    // the project store has not registered its accessor (never imported in a
    // unit test, or between a `destroyStoreOrchestrator()` and the next init) —
    // failing hard there would break callers over a missing wiring rather than a
    // bad argument, so degrade to the context project instead.
    const index = getProjectPathIndex();
    if (!index) {
      return { projectId: args.projectId, projectPath: ctx.projectPath ?? undefined };
    }
    const path = index.get(args.projectId);
    if (!path) {
      throw new Error("Unknown project — no project with that id is open.");
    }
    return { projectId: args.projectId, projectPath: path };
  }
  if (args?.projectPath) {
    return { projectId: undefined, projectPath: args.projectPath };
  }
  return { projectId: ctx.projectId ?? undefined, projectPath: ctx.projectPath ?? undefined };
}

/** The project path for a tool whose IPC is path-based. See {@link requireWorktreePath}. */
export function requireProjectPath(
  args: ProjectLocationArgs | undefined,
  ctx: ActionContext
): string {
  const { projectPath } = resolveProjectLocation(args, ctx);
  if (projectPath) return projectPath;
  throw new Error("No active project — supply `projectId` or `projectPath`.");
}
