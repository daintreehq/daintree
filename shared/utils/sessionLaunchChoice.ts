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
 * The account is the terminal's: a later run of the same CLI started in its
 * shell inherits the folder the PTY was spawned with. Not while another CLI is
 * the one detected there, whose own folder variable the launch never set. The
 * preset is the launched run's alone, since a run started by hand takes none
 * of its arguments, so it goes once another agent run has taken the PTY over.
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
    ...(!otherCli && isAccountId(agentAccountId) && { agentAccountId }),
  };
}
