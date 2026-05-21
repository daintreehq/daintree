// EventContext

/** Common context in domain events for filtering and correlation */
export interface EventContext {
  /** ID of the worktree this event relates to */
  worktreeId?: string;

  /** ID of the agent executing work */
  agentId?: string;

  /** ID of the terminal involved */
  terminalId?: string;

  /** GitHub issue number if applicable */
  issueNumber?: number;

  /** GitHub PR number if applicable */
  prNumber?: number;
}
