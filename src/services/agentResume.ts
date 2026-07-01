import {
  buildResumeCommand,
  buildResumeLatestCommand,
  reconcileBypassFlags,
  resolveEffectiveBypass,
} from "@shared/types/agentSettings";
import { getEffectiveAgentConfig } from "@shared/config/agentRegistry";
import type { AddPanelOptions } from "@shared/types/addPanelOptions";
import type { AgentSessionRecord } from "@shared/types/ipc/agentSessionHistory";
import { useAgentSettingsStore } from "@/store/agentSettingsStore";

/**
 * Reconciles a resumed session's persisted launch flags against the current
 * global skip-permissions setting (#10432, the "resume trap"): the snapshot may
 * have been captured while the global switch was in a different state, so strip
 * the agent's canonical bypass flag and re-add it only if it currently resolves.
 *
 * Reads `useAgentSettingsStore` synchronously (a Zustand store read, not
 * React-bound), so it is safe to call from action definitions and effects alike.
 */
export function reconcileResumeLaunchFlags(session: {
  agentId: string;
  agentLaunchFlags?: string[];
}): string[] | undefined {
  const settings = useAgentSettingsStore.getState().settings;
  const entry = settings?.agents?.[session.agentId] ?? {};
  const effectiveBypass = resolveEffectiveBypass(
    entry,
    session.agentId,
    settings?.globalSkipPermissions
  );
  // Pass [] when no flags were captured so global-on still injects the bypass
  // token for a supported agent (reconcileBypassFlags no-ops for others).
  return reconcileBypassFlags(
    session.agentLaunchFlags ?? [],
    session.agentId,
    effectiveBypass,
    entry.dangerousArgs as string | undefined
  );
}

/**
 * Turns a journaled/palette-selected {@link AgentSessionRecord} into the
 * `addPanel` options that relaunch its agent with a resume command. Funnels
 * through `buildResumeCommand ?? buildResumeLatestCommand` (never re-derives
 * from current settings — #5343) with reconciled launch flags (#3175).
 *
 * Launches into the caller-provided `cwd`/`worktreeId`. Session resume is
 * directory-scoped — the CLI locates the conversation from the launch cwd
 * (#4781) — so callers resolve the target from the session's OWN recorded
 * location via `resolveResumeLaunchTarget`, falling back to the active worktree
 * only for records that predate those fields. Seeds `agentSessionId` so callers
 * can detect an already-open resume and focus it instead of spawning a
 * duplicate.
 *
 * @returns `addPanel` options, or `null` when the record is malformed or the
 *   agent has no resume config / no buildable command.
 */
export function buildResumePanelOptions(
  session: AgentSessionRecord,
  target: { cwd: string; worktreeId?: string }
): AddPanelOptions | null {
  if (!session.agentId || !session.sessionId) return null;
  const agentConfig = getEffectiveAgentConfig(session.agentId);
  if (!agentConfig) return null;
  const resumeFlags = reconcileResumeLaunchFlags(session);
  const command =
    buildResumeCommand(session.agentId, session.sessionId, resumeFlags) ??
    buildResumeLatestCommand(session.agentId, resumeFlags);
  if (!command) return null;
  return {
    kind: "terminal",
    launchAgentId: session.agentId,
    title: agentConfig.name,
    cwd: target.cwd,
    worktreeId: target.worktreeId,
    command,
    location: "grid",
    agentSessionId: session.sessionId,
  };
}
