import type { PluginSendToAgentRefusalReason } from "../../../shared/types/plugin.js";

/** Longest id `host.sendToAgent` accepts for a terminal or worktree. */
export const SEND_TO_AGENT_MAX_ID_LENGTH = 512;

// A record keyed by the union so a reason added to the type without an entry
// here fails typecheck rather than being read back as a dismissal.
const REFUSAL_REASON_KEYS = {
  "unknown-terminal": true,
  "not-agent": true,
  exited: true,
  "input-bar-off": true,
  "backend-unavailable": true,
  "input-locked": true,
  restarting: true,
  "input-busy": true,
  "not-in-grid": true,
  "fleet-armed": true,
  "project-unavailable": true,
  "launch-failed": true,
  "prompt-open": true,
  busy: true,
} satisfies Record<PluginSendToAgentRefusalReason, true>;

/** Every refusal a send-to-agent can report, for validating an answer. */
export const SEND_TO_AGENT_REFUSAL_REASONS = Object.keys(REFUSAL_REASON_KEYS) as [
  PluginSendToAgentRefusalReason,
  ...PluginSendToAgentRefusalReason[],
];
