import { z } from "zod";

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

// What ended a journaled session, as `AgentSessionCloseCause` names it (#16341).
export const AgentSessionCloseCauseSchema = z.enum([
  "user",
  "kill",
  "restart",
  "shutdown",
  "sleep",
  "exit",
  "bookmark",
]);

// One incarnation of one terminal: a restart keeps the id and moves `spawnedAt`.
export const AgentSessionTerminalSchema = z.object({
  id: z.string(),
  spawnedAt: z.number(),
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
  // Absent on records journaled before they were kept. What tells a session the
  // person closed from one that died, and which pane it came from (#16341).
  closedBy: AgentSessionCloseCauseSchema.optional(),
  terminal: AgentSessionTerminalSchema.optional(),
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

// Why a saved session wasn't reopened as a pane (#16000), as the tool reports it (#16341).
export const AgentSessionPaneRefusalSchema = z.enum([
  "no-session-id",
  "unknown-agent",
  "no-resume-support",
  "unknown-project",
  "history-unavailable",
  "worktrees-unavailable",
  "worktree-gone",
  "other-worktree",
  "terminals-unavailable",
  "panel-limit",
  "missing-cli",
  "spawn-failed",
  "cancelled",
  "not-authorized",
]);

export type AgentSessionPaneRefusal = z.infer<typeof AgentSessionPaneRefusalSchema>;

// `agent.resumeOwned` (#16341). No project: the call runs in the one its session
// is bound to. No flags, command or directory: those come from the journal.
export const AgentResumeOwnedArgsSchema = z.object({
  worktreeId: z.string().min(1).describe("The worktree the session ran in."),
  agentId: z.string().min(1).describe("The session record's `agentId`."),
  sessionId: z.string().min(1).describe("The session record's `sessionId`, exactly."),
});

// Top-level object, for `buildToolOutputSchema`. Every field is required and
// individually nullable, as on `agent.launch`.
export const AgentResumeOwnedResultSchema = z.object({
  status: z.enum(["launched", "existing", "refused"]),
  terminalId: z.string().nullable(),
  savedInLayout: z.boolean().nullable(),
  reason: AgentSessionPaneRefusalSchema.nullable(),
  message: z.string().nullable(),
});

export type AgentResumeOwnedResult = z.infer<typeof AgentResumeOwnedResultSchema>;
