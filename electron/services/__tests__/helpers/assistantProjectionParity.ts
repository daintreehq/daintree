/**
 * The one expectation both producers of assistant presence are held to.
 *
 * `ProjectStatsService` (the pushed status map) and `handleProjectGetBulkStats`
 * (the palette's cold seed) each hand-write their own projection of the same
 * `computeProjectAgentCounts` output. That duplication is exactly the shape of
 * #10989, where the two answered "is this an agent?" independently and drifted
 * — and because the push suppresses unchanged payloads, nothing corrected the
 * disagreement until agent state next moved.
 *
 * Both suites assert this same object against {@link PARITY_ASSISTANT_TERMINAL},
 * so either producer drifting fails its own file with a diff that names the
 * field. Shared as a constant rather than duplicated because two copies of the
 * expectation could drift in precisely the way it exists to catch.
 */
export const ASSISTANT_PROJECTION_PARITY = {
  assistantState: "waiting",
  assistantWaitingReason: "error",
  assistantStateSince: 3_000,
  // The assistant contributes to none of these. `processCount` is the host's
  // raw terminal count minus the assistant PTY it already counted.
  activeAgentCount: 0,
  waitingAgentCount: 0,
  processCount: 0,
} as const;

/** The terminal fields both suites must feed their producer to get the above. */
export const PARITY_ASSISTANT_TERMINAL = {
  agentState: "waiting",
  waitingReason: "error",
  lastStateChange: 3_000,
} as const;
