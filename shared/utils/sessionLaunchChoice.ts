import { isAccountId } from "./agentAccountId.js";

/** The ids a journaled session keeps of the launch it ran on (#18191). */
export interface SessionLaunchChoice {
  agentPresetId?: string;
  agentAccountId?: string;
}

/** Launchable preset ids, as `sanitizePreset` admits them. */
const PRESET_ID = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * The preset and account a terminal's run was on, for the session record its
 * capture writes (#18191): ids only, so a resume reads both again from the
 * settings and the record never holds an environment value.
 *
 * Only the run Daintree launched: one started by hand in the shell afterwards
 * may have inherited the account's folder and the preset's env without its
 * arguments, or changed either, so no id names what it ran on and a resume
 * refuses rather than reopen it on a provider it may not have used. Nor while
 * another CLI is the one detected, whose folder variable the launch never set.
 */
export function launchChoiceForRecord(terminal: {
  agentPresetId?: unknown;
  agentAccountId?: unknown;
  agentIncarnation?: number;
  launchAgentId?: unknown;
  detectedAgentId?: unknown;
}): SessionLaunchChoice {
  const { agentPresetId, agentAccountId, detectedAgentId } = terminal;
  const launchedRun = (terminal.agentIncarnation ?? 0) === 0;
  const otherCli =
    typeof detectedAgentId === "string" && detectedAgentId !== terminal.launchAgentId;
  return {
    ...(launchedRun &&
      typeof agentPresetId === "string" &&
      PRESET_ID.test(agentPresetId) && { agentPresetId }),
    ...(launchedRun && !otherCli && isAccountId(agentAccountId) && { agentAccountId }),
  };
}
