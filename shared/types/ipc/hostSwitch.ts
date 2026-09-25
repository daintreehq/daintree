import type { HostId } from "../remoteHosts.js";

/** The fresh remote check of a branch, run on the machine the branch is on. */
export type BranchRemoteState =
  | { kind: "same-tip"; remote: string; sha: string }
  | { kind: "ahead"; remote: string; ahead: number }
  | { kind: "diverged"; remote: string }
  | { kind: "not-on-remote"; remote: string | null; upstream: string | null }
  | { kind: "remote-unreachable"; remote: string | null; detail: string | null }
  | { kind: "detached" };

export interface HostSwitchPlanPayload {
  fromHostId: HostId;
  toHostId: HostId;
  projectId: string;
  /** The worktree the user is in on the source host. */
  worktreePath: string | null;
}

export interface HostSwitchPlan {
  projectName: string;
  branch: string | null;
  branchState: BranchRemoteState | null;
  hasUncommittedChanges: boolean;
  remotes: Array<{ name: string; url: string }>;
  /** Candidates on the target host, best first. Empty means clone. */
  candidates: import("./projectMatch.js").ProjectMatchCandidate[];
  /** Default clone destination on the target host. */
  suggestedDestination: string | null;
}
