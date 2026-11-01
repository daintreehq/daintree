import { z } from "zod";
import { withWorktreeLocation } from "./locationArgs";
import { AgentIdSchema } from "./schemas";

// Shared by the agent actions' metadata in agentActions.ts and their runs in
// agentActions.impl.ts.
// Named so the bookmark actions can both declare `argsSchema` and `.parse()` in
// run() for typed args without an unsafe `as` cast (#11288).
export const BookmarkAndCloseArgsSchema = z.object({
  terminalId: z.string().trim().min(1),
  label: z.string().trim().min(1).max(120),
});
export const BookmarkMutateArgsSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().trim().min(1).max(120),
});
export const BookmarkDeleteArgsSchema = z.object({ sessionId: z.string().min(1) });

// Bounds for the two agent-facing session listings (#11530). Deliberately
// tighter than the 50/500 used for log-shaped actions: a session record is an
// order of magnitude heavier than a log line, and an MCP result is billed twice
// (once as text, once as `structuredContent`). 20 matches RESUME_PAGE_SIZE, the
// resume palette's own page size.
export const SESSION_LIST_DEFAULT_LIMIT = 20;
const SESSION_LIST_MAX_LIMIT = 100;
const SessionListLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(SESSION_LIST_MAX_LIMIT)
  .default(SESSION_LIST_DEFAULT_LIMIT)
  .describe(
    `Max records, newest first (default ${SESSION_LIST_DEFAULT_LIMIT}, max ${SESSION_LIST_MAX_LIMIT}).`
  );

// Paired with the limit so a bounded page isn't a one-way door. Bookmarks are
// exempt from every eviction rule, so a project can hold more of them than the
// maximum limit — without an offset those records would be unreachable through
// the action, and their sessionId is the only handle rename/delete accept.
const SessionListOffsetSchema = z
  .number()
  .int()
  .min(0)
  .default(0)
  .describe("Records to skip, for paging (default 0).");

export const BookmarkListArgsSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    limit: SessionListLimitSchema,
    offset: SessionListOffsetSchema,
  })
  .optional();

export const AgentListModelsArgsSchema = z.object({
  agentId: z
    .string()
    .min(1)
    .optional()
    .describe("One agent's models; omit for every listed agent."),
});

export const AgentListPresetsArgsSchema = z.object({
  agentId: AgentIdSchema,
  projectId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project whose repository presets to include (default: this call's). Another project returns only the other layers, marked incomplete."
    ),
});

// Worktree-scoped so the caller must assert WHERE the session lives, using the
// shared location vocabulary (#11543) rather than a bespoke `worktreeId` field.
// The selector scopes the lookup; it never chooses the launch directory, which
// the record itself owns (#4781).
export const ResumeSessionArgsSchema = withWorktreeLocation({
  sessionId: z
    .string()
    .min(1)
    .describe(
      "Exact session id from a session-history or bookmark listing; never a title or prefix."
    ),
});

export const SessionHistoryListArgsSchema = z
  .object({
    // `.min(1)`: an empty string would fall through the bridge's `if
    // (!worktreeId)` guard to an unfiltered listing — a surprising result for a
    // caller that passed a (blank) id expecting a scoped one.
    worktreeId: z.string().min(1).optional().describe("Only this worktree."),
    projectId: z
      .string()
      .min(1)
      .optional()
      .describe("Only this project; combines with `worktreeId`."),
    limit: SessionListLimitSchema,
    offset: SessionListOffsetSchema,
  })
  .optional();

// The three user-preset writes (#16047). Strict, so a misspelt field is refused
// rather than dropped: the user approves what the preview shows, and a field
// the caller meant to set but that never reached the preset is a change nobody
// approved. No transforms (no `.trim()`): `planAgentPresetMutation` reports
// anything the launch-time sanitiser would change instead of applying it.
const PresetEnvSchema = z.record(z.string(), z.string());
const PresetModeSchema = z.enum(["inherit", "on", "off"]);
const PRESET_ARGS_DESCRIPTION = "Argv for the CLI, one argument per entry.";
const PRESET_FLAGS_DESCRIPTION = "Flag text used instead of the agent's own, as typed in Settings.";
const PRESET_SKIP_DESCRIPTION = "Skip permissions: on, off, or inherit the agent's.";
const PRESET_INLINE_DESCRIPTION = "Inline output (on), alt screen (off), or inherit the agent's.";
const PRESET_COLOR_DESCRIPTION = "Hex colour, e.g. #3b82f6.";
const PRESET_TITLE_DESCRIPTION = "Panel title; defaults to the name.";
const PRESET_FALLBACKS_DESCRIPTION =
  "Up to 3 other preset ids of this agent, tried in order when this one's provider fails.";
const PRESET_RATE_LIMIT_DESCRIPTION =
  "Also fall back on a usage limit, which ends the running conversation.";

const PresetIdArgSchema = z
  .string()
  .min(1)
  .describe("A user preset's id (source custom) from the preset listing.");

export const AgentCreatePresetArgsSchema = z.strictObject({
  agentId: AgentIdSchema,
  name: z.string().describe("Shown in the preset picker."),
  env: PresetEnvSchema.optional().describe("Env vars the agent launches with."),
  args: z.array(z.string()).optional().describe(PRESET_ARGS_DESCRIPTION),
  customFlags: z.string().optional().describe(PRESET_FLAGS_DESCRIPTION),
  dangerousMode: PresetModeSchema.optional().describe(PRESET_SKIP_DESCRIPTION),
  inlineMode: PresetModeSchema.optional().describe(PRESET_INLINE_DESCRIPTION),
  color: z.string().optional().describe(PRESET_COLOR_DESCRIPTION),
  displayTitle: z.string().optional().describe(PRESET_TITLE_DESCRIPTION),
  fallbacks: z.array(z.string()).optional().describe(PRESET_FALLBACKS_DESCRIPTION),
  fallbackOnRateLimit: z.boolean().optional().describe(PRESET_RATE_LIMIT_DESCRIPTION),
});

// A patch, never a whole preset: the listing returns no env or flags, so a
// caller could only replace a preset by being handed every value, secrets
// included. Omitted keeps a field; null clears it.
export const AgentUpdatePresetArgsSchema = z.strictObject({
  agentId: AgentIdSchema,
  presetId: PresetIdArgSchema,
  name: z.string().optional().describe("New name."),
  envSet: PresetEnvSchema.optional().describe("Env vars to add or replace; the rest are kept."),
  envUnset: z.array(z.string()).optional().describe("Env var names to remove."),
  args: z.array(z.string()).nullable().optional().describe(PRESET_ARGS_DESCRIPTION),
  customFlags: z.string().nullable().optional().describe(PRESET_FLAGS_DESCRIPTION),
  dangerousMode: PresetModeSchema.nullable().optional().describe(PRESET_SKIP_DESCRIPTION),
  inlineMode: PresetModeSchema.nullable().optional().describe(PRESET_INLINE_DESCRIPTION),
  color: z.string().nullable().optional().describe(PRESET_COLOR_DESCRIPTION),
  displayTitle: z.string().nullable().optional().describe(PRESET_TITLE_DESCRIPTION),
  fallbacks: z.array(z.string()).nullable().optional().describe(PRESET_FALLBACKS_DESCRIPTION),
  fallbackOnRateLimit: z.boolean().optional().describe(PRESET_RATE_LIMIT_DESCRIPTION),
});

export const AgentDeletePresetArgsSchema = z.strictObject({
  agentId: AgentIdSchema,
  presetId: PresetIdArgSchema,
});
