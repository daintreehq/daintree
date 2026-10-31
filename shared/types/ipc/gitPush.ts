export interface PushProgressEvent {
  cwd: string;
  stage: string;
  progress: number | null;
  processed: number | null;
  total: number | null;
  targetBranch?: string;
}

export interface GitPushPayload {
  cwd: string;
  setUpstream?: boolean;
  /** Client-minted operation id; absent means the Host mints its own. */
  opId?: string;
  /**
   * The branch, commit and destination a confirm showed (#15646). All four or
   * none: with them the push refuses unless the worktree is still on that
   * branch at that commit, going to that destination, and publishes the
   * commit rather than whatever the branch points at by then.
   */
  expectedBranch?: string;
  expectedHeadOid?: string;
  expectedRemote?: string;
  expectedRemoteBranch?: string;
}
