import { z } from "zod";
import { BUILT_IN_AGENT_IDS, BUILT_IN_TERMINAL_TYPES } from "@shared/config/agentIds";
import {
  GLOBAL_SETTINGS_TAB_IDS,
  PROJECT_SETTINGS_TAB_IDS,
} from "@/components/Settings/settingsTabIds";

// Built-in agent ids plus the synthetic terminal/browser kinds, OR any non-empty
// string so plugin-contributed agent ids (#10560) validate through the action
// system (`agent.launch`). Plugin ids are validated at registration time in
// `pluginAgentRegistry`; this schema is not the authoritative boundary for them.
export const AgentIdSchema = z
  .union([z.enum([...BUILT_IN_AGENT_IDS, "terminal", "browser", "dev-preview"]), z.string().min(1)])
  .describe(
    "Which agent CLI to run. The enumerated ids are the built-ins; any other non-empty string is accepted so user- and plugin-contributed agents work, which means an unrecognised id fails at launch rather than at validation. Query the agent-listing capability for the ids actually installed and launchable."
  );

export const LaunchLocationSchema = z
  .enum(["grid", "dock", "overlay"])
  .describe(
    'Where to place the panel. "grid" places it in the main panel grid (default). "dock" places it in the sidebar dock. "overlay" places it in a floating overlay (e.g. the Daintree Assistant), outside the grid and dock.'
  );

/**
 * Mirror of `TerminalSpawnSource` from `shared/types/panel.ts`. Kept in lockstep
 * with that union so action argsSchemas can validate the field. The MCP bridge
 * stamps `"mcp"` on spawn-producing dispatches; user surfaces stamp their own
 * origin (`"quickrun"`, `"recipe"`, `"agent"`, `"palette"`).
 */
export const TerminalSpawnSourceSchema = z
  .enum(["quickrun", "recipe", "agent", "palette", "mcp"])
  .describe(
    "Records which surface asked for the spawn, for provenance and run history only; it never changes what is launched. Leave it unset when dispatching over MCP — the bridge stamps its own origin."
  );

/**
 * Mirror of `AddPanelFocusPolicy` from `shared/types/panel.ts`.
 */
export const AddPanelFocusPolicySchema = z
  .enum(["auto", "preserve", "take"])
  .describe(
    'Whether creating the panel moves keyboard focus to it. "auto" (the effective default) moves focus except while the assistant owns input, "preserve" always leaves focus where it is, and "take" always moves it. Prefer "preserve" when spawning in the background so the user\'s typing is not interrupted.'
  );

// Derived from the settingsTabIds tuples so the action schema can't drift from
// the registry (the previous hand-written enum was missing plugins,
// plugin-actions, and run-history). The legacy aliases stay accepted because
// ActionService validates argsSchema BEFORE dispatch reaches the handler —
// useSettingsDialog normalizes them to "code-forge" (TODO #8329).
export const SettingsTabSchema = z.enum([
  ...GLOBAL_SETTINGS_TAB_IDS,
  ...PROJECT_SETTINGS_TAB_IDS,
  "github",
  "forge",
]);

export const SettingsNavTargetSchema = z.object({
  tab: SettingsTabSchema,
  subtab: z.string().optional(),
  sectionId: z.string().optional(),
});

export const TerminalTypeSchema = z.enum(BUILT_IN_TERMINAL_TYPES);

export const BuiltInAgentIdSchema = z.enum(BUILT_IN_AGENT_IDS);

// Every member of the `GitStatus` union (shared/types/git.ts). `conflicted` is
// unreachable through git.getStagingStatus today only because its loop skips the
// conflicted set first — but `StagingFileEntry.status` is typed as the full
// union, and since dispatch parses results (#11539) a missing member would fail
// the whole action rather than one row.
export const GitStatusSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "untracked",
  "ignored",
  "renamed",
  "copied",
  "conflicted",
]);

export const StagingFileEntrySchema = z.object({
  path: z.string(),
  status: GitStatusSchema,
  insertions: z.number().nullable(),
  deletions: z.number().nullable(),
});

export const ConflictedFileEntrySchema = z.object({
  path: z.string(),
  xy: z.string(),
  label: z.string(),
});

export const PulseRangeDaysSchema = z
  .union([z.literal(60), z.literal(120), z.literal(180)])
  .optional()
  .default(60)
  .describe(
    "How far back to aggregate commit activity, in days. A wider window costs more history to walk, so widen it only when the shorter window leaves the trend ambiguous."
  );

export const FileSearchPayloadSchema = z.object({
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute root path to search under. Defaults to the active worktree; the call fails when it is omitted and no worktree is active."
    ),
  query: z
    .string()
    .describe(
      "Matched as a plain substring against file names and paths — not as a glob, and not file contents. Use a source-reading capability to search inside files."
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Caps how many matches come back; results are truncated silently rather than paged."),
});

/**
 * Canonical pagination arguments (#11543). Four schemes existed before —
 * `skip`/`limit`, `limit`/`offset`, an opaque `cursor`, and none at all. The
 * documented shape is now `limit` plus a positional selector: `cursor` for
 * sources that issue one, `offset` for sources that page by index. `skip` stays
 * accepted as a legacy alias for `offset`.
 *
 * Ceiling values are deliberately left to each action (issue #11531 owns
 * choosing them); this only converges the shape.
 */
export type LegacyPaginationAlias = "skip";

export interface PaginationOptions {
  legacy?: readonly LegacyPaginationAlias[];
  cursor?: boolean;
  offset?: boolean;
  maxLimit?: number;
}

/**
 * The pagination fields on their own, so they can be merged into a larger object
 * BEFORE it is transformed. A transformed schema is a `ZodPipe` and can no
 * longer be `.extend()`ed, so a tool that paginates *and* takes a location has
 * to assemble one flat shape rather than chaining two builders.
 */
export function paginationShape(options: PaginationOptions = {}): Record<string, z.ZodTypeAny> {
  const { legacy = [], cursor = false, offset = true, maxLimit } = options;

  const limitField = maxLimit
    ? z.number().int().positive().max(maxLimit)
    : z.number().int().positive();

  const shape: Record<string, z.ZodTypeAny> = {
    limit: limitField.optional().describe("Maximum number of items to return."),
  };
  if (offset) {
    shape.offset = z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Number of items to skip before collecting results.");
  }
  if (cursor) {
    shape.cursor = z
      .string()
      .optional()
      .describe(
        "Opaque cursor — pass the previous response's `nextCursor` to fetch the next page."
      );
  }
  for (const alias of legacy) {
    shape[alias] = z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Legacy alias for `offset`; prefer `offset`.");
  }
  return shape;
}

/**
 * Collapse the legacy `skip` spelling into `offset`. See {@link paginationShape}.
 * Only consumes `skip` when the tool opted into it, so a tool with its own
 * unrelated `skip` field keeps it.
 */
export function foldPagination(
  value: Record<string, unknown>,
  ctx: z.RefinementCtx,
  legacy: readonly LegacyPaginationAlias[] = []
): Record<string, unknown> | typeof z.NEVER {
  if (!legacy.includes("skip")) return value;

  const { skip, ...rest } = value as { skip?: number; offset?: number } & Record<string, unknown>;
  const supplied = [rest.offset, skip].filter(
    (candidate): candidate is number => candidate !== undefined
  );
  if (new Set(supplied).size > 1) {
    ctx.addIssue({
      code: "custom",
      message: "`offset` and `skip` are aliases for the same value — supply only one.",
    });
    return z.NEVER;
  }
  const resolved = supplied[0];
  return resolved === undefined ? rest : { ...rest, offset: resolved };
}

/**
 * Decode a cursor issued by an index-paged source back into its offset.
 *
 * Those sources emit `String(nextOffset)` as their `nextCursor`, so decoding is
 * the inverse. It is strict on purpose: a garbage cursor silently restarting at
 * page zero would look like a successful re-read of the first page, and a
 * negative one would reach `git log --skip`. Throws a static message — the
 * rejected value is never echoed back.
 */
export function decodeIndexCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) return undefined;
  // `Number("")` and `Number(" ")` are 0, so an empty cursor would read as a
  // valid "start from the top" rather than the caller error it is.
  const parsed = cursor.trim() === "" ? Number.NaN : Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Invalid cursor — pass back the `nextCursor` from the previous response.");
  }
  return parsed;
}

export function withPagination<T extends z.ZodRawShape>(extra: T, options: PaginationOptions = {}) {
  return z.object({ ...paginationShape(options), ...extra }).transform((value, ctx) => {
    const folded = foldPagination(value as Record<string, unknown>, ctx, options.legacy ?? []);
    if (folded === z.NEVER) return z.NEVER;
    return folded as Omit<z.core.output<z.ZodObject<T>>, "offset" | "skip"> & {
      limit?: number;
      offset?: number;
      cursor?: string;
    };
  });
}

/**
 * Canonical list-result envelope (#11543). Every paginated tool returns the same
 * four keys so a caller writes its paging loop once: `items`, `hasMore`, a
 * `nextCursor` that is null at the end of the list, and `total` only where an
 * exact count is already cheap to produce.
 */
export function PaginatedResultSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    total: z.number().optional(),
  });
}

export const CopyTreeOptionsSchema = z
  .object({
    format: z.enum(["xml", "json", "markdown", "tree", "ndjson", "sarif"]).optional(),
    // `filter` and `includePaths` are two spellings of one selection set, and both
    // feed the SDK's single `filter`. They used to collapse with `||`, so a caller
    // that put literal files in one and globs in the other silently lost the
    // second — the exact shape a curated bundle takes (#11722). They are unioned
    // now, and say so here, since the union is only discoverable from these
    // descriptions on the MCP wire.
    // Non-empty at both levels, like `scopePaths` below. An empty list and a
    // blank entry both leave the selection empty, and an empty selection reads as
    // "no filter" to the SDK — i.e. the whole worktree. Accepting either would
    // turn a malformed narrow request into a full-repo copy onto the clipboard,
    // so they are rejected here rather than normalized away downstream.
    filter: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .optional()
      .describe(
        "Selects which files to include, as worktree-relative exact file paths or glob patterns. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'; prefer `scopePaths` when selecting a folder. Combined with `includePaths` when both are given; omit both to include the whole worktree."
      ),
    exclude: z.union([z.string(), z.array(z.string())]).optional(),
    // Undocumented on the wire until #11750, which is how a caller ended up
    // hand-computing per-file patterns for it. Described now as the blunt
    // instrument it is, so `scopeIgnoresIgnoreFiles` below reads as the narrower
    // tool rather than a synonym.
    always: z
      .array(z.string())
      .optional()
      .describe(
        "Force-includes matching files, overriding several exclusion layers at once: ignore files, project and config exclusions, your own `exclude`, the `modified`/`changed` git filters, and `maxFileSize`. It is the blunt option: a broad pattern can pull in `node_modules`, and a `../` pattern reaches outside the worktree entirely. What it does not override: `.git`, CopyTree's internal 10MB memory ceiling, and the `maxFileCount`/`maxTotalSize`/`charLimit` budgets, which still drop force-included files. Prefer `scopePaths` with `scopeIgnoresIgnoreFiles` when you only need past an ignore rule."
      ),
    includePaths: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        "Selects which files to include, as worktree-relative exact file paths or glob patterns. Patterns match file paths, so a folder needs a glob: pass 'src/panels/**', not 'src/panels'; prefer `scopePaths` when selecting a folder. Use this to assemble a curated bundle of scattered files — sources, their supporting code, and their tests — in one call. Combined with `filter` when both are given. Unlike `scopePaths` this does not restrict traversal, so patterns may match anywhere in the worktree."
      ),
    // An empty list or blank entry would resolve to the worktree root — a folder
    // copy that silently became a whole-worktree copy. Absent means no scoping.
    scopePaths: z
      .array(z.string().min(1))
      .min(1)
      .optional()
      .describe(
        "Restricts the copy to these subtrees, as worktree-relative literal file or directory paths to walk — not glob patterns, so pass 'src/panels', not 'src/panels/**'. Prefer this over `filter` or `includePaths` when selecting a folder. Omit to include the whole worktree; supplying an empty list is rejected rather than treated as no scoping, since that would silently copy everything. This restricts traversal, so `filter` and `includePaths` can only narrow within these paths and never add a file outside them."
      ),
    scopeIgnoresIgnoreFiles: z
      .boolean()
      .optional()
      .describe(
        "Lets `scopePaths` into subtrees an ignore file would have pruned (default false — a scoped copy returns what a whole-worktree copy would have returned). Requires `scopePaths` and is rejected without it. Set true when a path you named is being dropped by a `.copytreeignore` or `.gitignore` rule: only the rules blocking entry into each scoped path are removed, from those two ignore files. Unrelated rules in the same files, negations, and ignore files at or below the selection all still apply — as do project and config exclusions such as node_modules, your own `exclude`, `.git`, the `modified`/`changed` filters, `maxFileSize` and every budget. To get past a rule declared inside a selected folder, scope the exact file instead of that folder: a scoped directory subsumes any of its children you also list, so naming both changes nothing."
      ),
    modified: z.boolean().optional(),
    changed: z.string().optional(),
    maxFileSize: z.number().int().positive().optional(),
    maxTotalSize: z.number().int().positive().optional(),
    maxFileCount: z.number().int().positive().optional(),
    withLineNumbers: z.boolean().optional(),
    charLimit: z.number().int().positive().optional(),
    // These actions validate against their own copy of the options schema, so a
    // field only the IPC schema knows about is stripped before the request ever
    // leaves the renderer. `sort` was missing here while `CopyTreeOptions` and the
    // IPC schema both accepted it, so an MCP caller asking for a sort order
    // silently got the default one.
    sort: z.enum(["path", "size", "modified", "name", "extension", "depth"]).optional(),
  })
  // Scope-bound, so `scopeIgnoresIgnoreFiles` alone does nothing at all: the SDK
  // only consults it while walking `scope` entries. Accepting it silently is the
  // shape of the bug #11750 was filed about — the caller believes it asked for
  // the ignored files back, gets a short bundle, and is told nothing. Naming the
  // missing field costs one round trip instead. Pinned on the IPC schema too;
  // neither derives from the other.
  .superRefine((options, ctx) => {
    if (options.scopeIgnoresIgnoreFiles === true && !options.scopePaths?.length) {
      ctx.addIssue({
        code: "custom",
        path: ["scopeIgnoresIgnoreFiles"],
        message: "scopeIgnoresIgnoreFiles requires scopePaths",
      });
    }
  });

export const AgentPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  args: z.array(z.string()).optional(),
  dangerousEnabled: z.boolean().optional(),
  dangerousMode: z.enum(["inherit", "on", "off"]).optional(),
  customFlags: z.string().optional(),
  inlineMode: z.union([z.boolean(), z.enum(["inherit", "on", "off"])]).optional(),
  color: z.string().optional(),
  displayTitle: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
});

export const AgentSettingsEntrySchema = z
  .object({
    selected: z.boolean().optional(),
    enabled: z.boolean().optional(),
    customFlags: z.string().optional(),
    dangerousArgs: z.string().optional(),
    dangerousEnabled: z.boolean().optional(),
    dangerousMode: z.enum(["inherit", "on", "off"]).optional(),
    presetId: z.string().optional(),
    customPresets: z.array(AgentPresetSchema).optional(),
  })
  .catchall(z.unknown());

export const WorktreeSummarySchema = z.object({
  id: z.string(),
  path: z.string(),
  branch: z.string().nullable(),
  isActive: z.boolean(),
  isMain: z.boolean(),
  issueNumber: z.number().nullable(),
  issueTitle: z.string().nullable(),
  prNumber: z.number().nullable(),
  prTitle: z.string().nullable(),
  prUrl: z.string().nullable(),
  status: z.string().nullable(),
  lastCommit: z.string().nullable(),
});

export const TerminalSummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  // Vestigial: terminal.list always emits this as `undefined`, which drops out
  // on JSON serialization. Keep it optional so the advertised MCP outputSchema
  // (#10676) does not mark a key the structuredContent never carries as required.
  type: z.unknown().nullable().optional(),
  worktreeId: z.string().nullable(),
  title: z.string().nullable(),
  // All six members of `PanelLocation`. `dialog` is filtered out by
  // isEphemeralPanel and `overlay` only incidentally — every overlay creation
  // site happens to set `excludeFromPersistence`. One that doesn't would fail
  // the enum and, since dispatch parses results (#11539), take down the whole
  // listing instead of dropping a row.
  location: z.enum(["grid", "dock", "overlay", "trash", "background", "dialog"]),
  agentId: z.string().nullable(),
  agentState: z.string().nullable(),
  isInputLocked: z.boolean(),
  isFocused: z.boolean(),
});

export const TerminalStatusEntrySchema = z.object({
  terminalId: z.string(),
  agentId: z.string().nullable(),
  agentState: z.string().nullable(),
  waitingReason: z.string().optional(),
  lastTransitionAt: z.number().optional(),
  exitCode: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "Present once the process has exited, so its absence means still running. Null means the process was terminated by a signal and produced no numeric code — tell a clean finish from a failure with this rather than by scraping output."
    ),
  spawnedAt: z
    .number()
    .optional()
    .describe(
      "Wall-clock spawn time in epoch milliseconds, for run-duration and staleness checks."
    ),
  lastCheckResult: z
    .object({
      command: z.string().nullable(),
      passed: z.boolean(),
      ranAt: z.number(),
      failureSummary: z.string().nullable(),
      truncated: z.boolean(),
    })
    .optional()
    .describe(
      "A best-effort reading of the agent's most recent test, lint, or build summary, parsed from its output rather than from a process exit code — the check runs inside the terminal, so its real exit status is unobservable. Absence means no recognized summary was seen, which is not the same as no check running and not the same as passing. Check the run time for freshness before trusting it."
    ),
  recentOutput: z.string().nullable().optional(),
  armed: z
    .boolean()
    .optional()
    .describe(
      "Whether fleet broadcast input is routed to this terminal. Populated for every terminal that was found; absent only when the terminal itself could not be resolved."
    ),
  error: z
    .string()
    .optional()
    .describe(
      "Set when the terminal was not found, and also stamped on every resolved entry when the batched output fetch fails — in that case the status fields are still populated and only the recent output is missing. Its presence therefore does not by itself mean this terminal was unreadable, and it never fails the call as a whole."
    ),
});

export const PersistedStoreInfoSchema = z.object({
  storeId: z.string(),
  storageKey: z.string(),
  declaredVersion: z.number().nullable(),
  persistedBlobVersion: z.number().nullable(),
  hasMigrate: z.boolean(),
  hasMerge: z.boolean(),
  hasPartialize: z.boolean(),
  persistedStateType: z.string(),
  hasPersistedValue: z.boolean(),
  sizeBytes: z.number(),
  parseStatus: z.enum(["ok", "missing", "corrupt"]),
});

export const PortalTabSummarySchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
  title: z.string(),
});

export const RecipeSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  worktreeId: z.string().nullable(),
  terminalCount: z.number(),
  showInEmptyState: z.boolean(),
});

// Mirror of `AgentSessionRecord` (shared/types/ipc/agentSessionHistory.ts) — the
// journaled record for a closed, resumable agent session. Nullable vs optional
// tracks the TS type exactly: `worktreeId`/`title`/`projectId` are always present
// but may be null; `agentLaunchFlags`/`agentModelId`/`cwd`/`branch` are `?:` and
// may be absent, so the advertised MCP outputSchema must not mark them required.
// Durable bookmark metadata (#11288). Present only when the user has pinned a
// session; documents the shape surfaced through the MCP/list actions. Contains
// no transcript/output/env — only the label and pane-presentation hints.
export const AgentSessionBookmarkMetadataSchema = z.object({
  bookmarkedAt: z.number(),
  label: z.string(),
  sourcePanelId: z.string().optional(),
  sourceLocation: z.enum(["grid", "dock"]).optional(),
  titleMode: z.enum(["default", "custom", "user"]).optional(),
  agentPresetId: z.string().optional(),
  agentPresetColor: z.string().optional(),
  originalPresetId: z.string().optional(),
  isUsingFallback: z.boolean().optional(),
  fallbackChainIndex: z.number().optional(),
  isInputLocked: z.boolean().optional(),
});

export const AgentSessionRecordSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  worktreeId: z.string().nullable(),
  title: z.string().nullable(),
  projectId: z.string().nullable(),
  // Epoch ms the resume record was captured (session close), for newest-first ordering.
  savedAt: z.number(),
  // Original launch flags/model, preserved so a relaunch reproduces the session (#3175).
  agentLaunchFlags: z.array(z.string()).optional(),
  agentModelId: z.string().optional(),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  // Present when the user has pinned this session as a durable bookmark (#11288).
  bookmark: AgentSessionBookmarkMetadataSchema.optional(),
});

// Agent-facing projection of the bookmark metadata (#11530). The full schema
// above documents what main stores; this documents what the list actions
// actually hand an agent. The pane-presentation hints an agent cannot act on
// (`sourcePanelId`, `titleMode`, `agentPresetColor`, `isUsingFallback`,
// `fallbackChainIndex`) are dropped — the retained fields are the ones that
// identify the bookmark or feed a relaunch.
export const AgentFacingBookmarkMetadataSchema = z.object({
  bookmarkedAt: z.number(),
  label: z.string(),
  sourceLocation: z.enum(["grid", "dock"]).optional(),
  agentPresetId: z.string().optional(),
  originalPresetId: z.string().optional(),
  isInputLocked: z.boolean().optional(),
});

// The record shape the MCP-exposed list actions return. Identical to
// `AgentSessionRecordSchema` except for the leaner bookmark. Dispatch parses
// results against this now (#11539), so it strips as well as documents — but the
// hand projection in each `run()` stays: the journal admits degraded records, and
// each list action filters them out against this schema before returning so one
// bad row cannot reject the whole page.
export const AgentFacingSessionRecordSchema = AgentSessionRecordSchema.extend({
  bookmark: AgentFacingBookmarkMetadataSchema.optional(),
});
