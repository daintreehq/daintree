import { isAccountId } from "./agentAccountId.js";

/** The ids a journaled session keeps of the launch it ran on (#18191). */
export interface SessionLaunchChoice {
  agentPresetId?: string;
  agentAccountId?: string;
}

/**
 * The preset and account a terminal's launched run was on, for the session
 * record its capture writes (#18191): ids only, so a resume reads both again
 * from the settings and the record never holds an environment value. Nothing
 * once another agent run has taken the PTY over, which launched on neither.
 */
export function launchChoiceForRecord(terminal: {
  agentPresetId?: unknown;
  agentAccountId?: unknown;
  agentIncarnation?: number;
}): SessionLaunchChoice {
  if ((terminal.agentIncarnation ?? 0) !== 0) return {};
  const { agentPresetId, agentAccountId } = terminal;
  return {
    ...(typeof agentPresetId === "string" && agentPresetId !== "" && { agentPresetId }),
    ...(isAccountId(agentAccountId) && { agentAccountId }),
  };
}
