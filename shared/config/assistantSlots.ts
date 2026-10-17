/**
 * Assistant session slots (#12108).
 *
 * A project runs up to {@link MAX_ASSISTANT_SLOTS} concurrent Daintree
 * Assistant sessions. A *slot* is the durable lane identity: stable across
 * launches, unlike the per-provision `sessionId`. Two things force that
 * stability — Claude Code's per-folder workspace-trust acceptance is keyed by
 * the session directory, and an agent's resume token is keyed by the cwd it
 * was captured from. A directory named after the ephemeral session id would
 * re-prompt for trust and strand the resume token on every launch, which is
 * why `HelpSessionService` moved off per-launch UUID dirs in the first place.
 *
 * Every lane of a project on one agent shares ONE session directory. Lanes
 * used to get their own (`<hash>-sN`), which bought isolation of
 * the per-lane MCP bearer at the price of a fresh workspace-trust prompt and a
 * fresh `.mcp.json` approval prompt for every lane a user opened. Both prompts
 * are per folder, so one folder means one of each per project. What the extra
 * directories were isolating now lives elsewhere: an agent's resume id is
 * captured explicitly and passed back with `--resume <id>` rather than
 * inferred from "latest in this cwd", and Claude's per-lane bearer rides in a
 * per-lane `--mcp-config` file instead of the shared `.mcp.json`.
 *
 * Lanes on different AGENTS do not share it. The directory holds agent-shaped
 * files — the user-content mirror writes one agent's skills and retires the
 * other's, a non-Claude provision strips the Claude hooks, and Claude empties
 * the `.mcp.json` Copilot reads — so a second agent provisioning into it would
 * clobber a live sibling's setup. Claude keeps the bare hash, which is where
 * its trust acceptance and its cwd-scoped `--resume` already point; every
 * other agent gets `<hash>.<agent key>`. Codex resumes by exact id from any
 * cwd, so moving it costs a resumed conversation nothing.
 *
 * The single-backend invariant (#7509) is scoped to the slot rather than
 * dropped: at most one assistant PTY per (project, slot). A same-slot
 * re-provision still revokes the prior bearer before killing its PTY; only
 * genuinely different lanes coexist.
 */

/**
 * Concurrent assistant sessions allowed per project. Each costs a billed CLI
 * process, a PTY, an xterm instance, a live MCP transport and a session
 * directory, so the ceiling is deliberate rather than configurable.
 */
export const MAX_ASSISTANT_SLOTS = 3;

/** The lane an install had before slots existed. Never re-numbered. */
export const DEFAULT_ASSISTANT_SLOT = 0;

/** Every slot, ascending — the canonical order tabs and sweeps iterate in. */
export const ASSISTANT_SLOTS: readonly number[] = Array.from(
  { length: MAX_ASSISTANT_SLOTS },
  (_, i) => i
);

export function isValidAssistantSlot(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_ASSISTANT_SLOTS
  );
}

/**
 * Composite key for the per-(project, slot) bookkeeping that used to be keyed
 * by project alone. Uses a NUL delimiter because a project id can be a
 * filesystem path and every printable separator is a legal path character —
 * the same reasoning behind `WorkspaceService`'s control-char delimiters.
 */
export function assistantSlotKey(projectId: string, slot: number): string {
  return `${projectId}\u0000${slot}`;
}

/**
 * Recover the project id from a slot key. Splits on the last delimiter so a
 * project id that itself contains a NUL round-trips.
 */
export function projectIdFromSlotKey(slotKey: string): string {
  const at = slotKey.lastIndexOf("\u0000");
  return at === -1 ? slotKey : slotKey.slice(0, at);
}

/**
 * Session directory name for a project's lanes on one agent. Every lane of a
 * project on that agent shares it, so this takes no slot. A null key is the
 * bare project hash — Claude's, and what an existing install's slot 0 already
 * had, so its workspace trust and resume tokens are untouched by lanes sharing
 * it. Any other agent's key qualifies the hash; see `assistantAgentDirKey` in
 * `HelpSessionService` for how one is derived.
 */
export function assistantSessionDirName(
  projectPathHash: string,
  agentDirKey: string | null = null
): string {
  return agentDirKey ? `${projectPathHash}.${agentDirKey}` : projectPathHash;
}

/** What an agent key may contain: lowercase, digits and inner hyphens, bounded. */
export const ASSISTANT_AGENT_DIR_KEY_PATTERN = "[a-z0-9]+(?:-[a-z0-9]+)*";
export const ASSISTANT_AGENT_DIR_KEY_MAX_LENGTH = 32;

/**
 * Whether a name under the sessions root is a live project session directory:
 * the bare project hash, or the hash qualified by an agent key after a `.`.
 *
 * Load-bearing for GC: `gcStaleSessions` recursively deletes every directory
 * it does not recognize, so a name that fails this test is a *deleted* session
 * directory, not merely an unclassified one. That is deliberate for the two
 * legacy shapes it rejects — per-launch UUID directories from before the
 * per-project model, and the `<hash>-sN` per-lane directories that preceded
 * the shared one. Neither can be resumed from (their agents' resume ids were
 * captured against a cwd that is no longer used), so keeping them alive would
 * only strand transcripts nothing can reach. The agent qualifier uses a `.`,
 * which neither legacy shape ever did, so it can never revive one.
 *
 * Recognition does not depend on the agent still being registered: a
 * directory for an agent the user since removed keeps its resumable state.
 */
export function isAssistantSessionDirName(name: string, projectHashLength: number): boolean {
  const match = new RegExp(
    `^[0-9a-f]{${projectHashLength}}(?:\\.(${ASSISTANT_AGENT_DIR_KEY_PATTERN}))?$`
  ).exec(name);
  if (!match) return false;
  const key = match[1];
  return key === undefined || key.length <= ASSISTANT_AGENT_DIR_KEY_MAX_LENGTH;
}

/**
 * The directory, inside a project's shared session directory, that holds the
 * per-lane files the lanes cannot share — today, Claude's `--mcp-config` with
 * that lane's literal bearer. Hidden and unmistakably ours, so the template
 * copy leaves it alone and the user-content mirror never claims it.
 */
export const ASSISTANT_LANE_CONFIG_DIR = ".lanes";

/**
 * File name of one provision's MCP config inside {@link ASSISTANT_LANE_CONFIG_DIR}.
 *
 * Named per PROVISION, not per slot. A same-slot re-provision writes a new file
 * while the old session's revoke may still be waiting on its graceful kill; a
 * fixed `slot-N` name would let that late revoke delete the replacement's file
 * from under it. The session id in the name is also what the GC sweep keys on,
 * so a file is judged by whether its session is live rather than by parsing a
 * bearer out of its contents.
 */
export function assistantLaneMcpConfigName(slot: number, sessionId: string): string {
  return `slot-${slot}-${sessionId}.mcp.json`;
}

/** Recover the session id from a lane config file name, or null if it is not one. */
export function sessionIdFromLaneMcpConfigName(name: string): string | null {
  const match = /^slot-\d+-([0-9a-fA-F-]+)\.mcp\.json$/.exec(name);
  return match?.[1] ?? null;
}
