import { z } from "zod";
import type { ActionContext } from "@shared/types/actions";
import { getWorktreePathIndex } from "@/store/storeAccessors";
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
 * handler ever runs. A whole-object `.transform()` is used deliberately:
 * `z.toJSONSchema(..., { io: "input" })` unwraps it and still advertises every
 * alias property with its own description, whereas `z.preprocess()` would mark
 * the wrapped field `required` in the generated schema (zod 4.x upstream #5366).
 */

/** Legacy spellings that a tool may keep accepting for `worktreePath`. */
export type LegacyWorktreePathAlias = "cwd" | "rootPath" | "path";

/** Legacy spellings that a tool may keep accepting for `projectPath`. */
export type LegacyProjectPathAlias = "projectPath";

const legacyAliasDescription = (canonical: string): string =>
  `Legacy alias for \`${canonical}\`; prefer \`${canonical}\`.`;

const worktreeIdField = z
  .string()
  .optional()
  .describe("Worktree id (the `id` from `worktree.list`). Defaults to the active worktree.");

const worktreePathField = z
  .string()
  .optional()
  .describe(
    "Absolute worktree root path (the `path` from `worktree.list`). Used when `worktreeId` is omitted."
  );

const projectIdField = z
  .string()
  .optional()
  .describe("Project id (the `id` from `project.getAll`). Defaults to the active project.");

const projectPathField = z
  .string()
  .optional()
  .describe("Absolute project root path. Used when `projectId` is omitted.");

/**
 * The location half of a worktree-scoped tool's arguments, after alias collapse.
 * Legacy alias keys are stripped, so a handler only ever reads the canonical two.
 */
export interface WorktreeLocationArgs {
  worktreeId?: string;
  worktreePath?: string;
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
  ctx: z.RefinementCtx
): Record<string, unknown> | typeof z.NEVER {
  const {
    cwd,
    rootPath,
    path: legacyPath,
    ...rest
  } = value as {
    cwd?: string;
    rootPath?: string;
    path?: string;
    worktreePath?: string;
  } & Record<string, unknown>;

  const supplied = [rest.worktreePath, cwd, rootPath, legacyPath].filter(
    (candidate): candidate is string => candidate !== undefined
  );

  if (new Set(supplied).size > 1) {
    ctx.addIssue({
      code: "custom",
      message:
        "`worktreePath`, `cwd`, `rootPath`, and `path` are aliases for the same value — supply only one, or identical values.",
    });
    return z.NEVER;
  }

  const worktreePath = supplied[0];
  return worktreePath === undefined ? rest : { ...rest, worktreePath };
}

function collapseProjectPath(
  value: Record<string, unknown>,
  _ctx: z.RefinementCtx
): Record<string, unknown> {
  return value;
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
    shape[alias] = z.string().optional().describe(legacyAliasDescription("worktreePath"));
  }
  if (pagination) Object.assign(shape, paginationShape(pagination));

  return z
    .object({ ...shape, ...extra })
    .transform((value, ctx) => {
      const collapsed = collapseWorktreePath(value as Record<string, unknown>, ctx);
      if (collapsed === z.NEVER) return z.NEVER;
      const paged = pagination ? foldPagination(collapsed, ctx) : collapsed;
      if (paged === z.NEVER) return z.NEVER;
      const located = paged as Record<string, unknown> & WorktreeLocationArgs;
      if (requireSelector && !located.worktreeId && !located.worktreePath) {
        ctx.addIssue({
          code: "custom",
          message: "Supply `worktreeId` or `worktreePath` — this action has no active-worktree default.",
        });
        return z.NEVER;
      }
      return located as Omit<z.core.output<z.ZodObject<T>>, keyof WorktreeLocationArgs> &
        WorktreeLocationArgs;
    });
}

type ProjectLocationOptions = {
  /** Keep `projectPath` on the surface. Preferred selector is always `projectId`. */
  allowPath?: boolean;
  requireSelector?: boolean;
};

/**
 * Build a project-scoped `argsSchema`. Mirrors {@link withWorktreeLocation};
 * `projectPath` is the only legacy spelling in play, and it stays canonical-ish
 * (an accepted second selector) rather than being folded away, because several
 * tools genuinely receive a path and never had an id to fold it into.
 */
export function withProjectLocation<T extends z.ZodRawShape>(
  extra: T,
  options: ProjectLocationOptions = {}
) {
  const { allowPath = true, requireSelector = false } = options;

  const shape: Record<string, z.ZodTypeAny> = { projectId: projectIdField };
  if (allowPath) shape.projectPath = projectPathField;

  return z
    .object({ ...shape, ...extra })
    .transform((value, ctx) => {
      const located = collapseProjectPath(
        value as Record<string, unknown>,
        ctx
      ) as Record<string, unknown> & ProjectLocationArgs;
      if (requireSelector && !located.projectId && !located.projectPath) {
        ctx.addIssue({
          code: "custom",
          message: "Supply `projectId` or `projectPath` — this action has no active-project default.",
        });
        return z.NEVER;
      }
      return located as Omit<z.core.output<z.ZodObject<T>>, keyof ProjectLocationArgs> &
        ProjectLocationArgs;
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

  if (args?.worktreeId) {
    return { worktreeId: args.worktreeId, worktreePath: index?.get(args.worktreeId) };
  }

  if (args?.worktreePath) {
    const path = args.worktreePath;
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

/** Resolve a project-scoped tool's selectors against the action context. */
export function resolveProjectLocation(
  args: ProjectLocationArgs | undefined,
  ctx: ActionContext
): { projectId: string | undefined; projectPath: string | undefined } {
  if (args?.projectId) {
    return { projectId: args.projectId, projectPath: undefined };
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
