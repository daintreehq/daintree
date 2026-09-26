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

/**
 * The fresh check with one more observation than {@link BranchRemoteState}:
 * the remote has commits this machine lacks and this machine has none the
 * remote lacks, so continuing from the remote loses nothing.
 */
export type BranchCheck =
  BranchRemoteState | { kind: "behind"; remote: string; behind: number; sha: string };

export interface SourceRecipe {
  id: string;
  name: string;
}

/** Everything the switch dialog shows, gathered from both hosts. */
export interface HostSwitchPreparation {
  fromHostId: HostId;
  toHostId: HostId;
  projectId: string;
  projectName: string;
  /** Where the checked-out branch lives on the source host. */
  worktreePath: string;
  branch: string | null;
  branchCheck: BranchCheck | null;
  /** The branch's name on its remote (its upstream's name, else its own). */
  remoteBranch: string | null;
  /** URL of the remote the branch lives on, else the one to clone from. */
  cloneUrl: string | null;
  hasUncommittedChanges: boolean;
  /** Commits a push would publish (newest first, capped), shown before any push. */
  unpushedCommits: Array<{ sha: string; subject: string }>;
  remotes: Array<{ name: string; url: string }>;
  /** The committed `.daintree/project.json` id, when the repository carries one. */
  committedProjectId: string | null;
  candidates: import("./projectMatch.js").ProjectMatchCandidate[];
  destination: import("./projectMatch.js").DestinationCheck | null;
  usesLfs: boolean;
  /** Submodules are initialised in the source's working tree. */
  hasSubmodules: boolean;
  targetGitLfsAvailable: boolean;
  /** Committed in-repo recipes, so the ones a clone will carry. */
  recipes: SourceRecipe[];
  /** The source's default worktree recipe, when it is one of `recipes`. */
  defaultRecipeId: string | null;
}

export type HostSwitchExecutePayload =
  /** Push the branch from the source, setting its upstream. */
  | {
      kind: "push";
      opId: string;
      fromHostId: HostId;
      projectId: string;
      worktreePath: string;
      branch: string;
      remote: string;
      remoteBranch: string;
    }
  /** Clone onto the target (from the remote, or from a bundle of the source), register and open. */
  | {
      kind: "clone";
      opId: string;
      fromHostId: HostId;
      toHostId: HostId;
      projectId: string;
      source: { kind: "remote"; url: string } | { kind: "bundle" };
      destination: string;
      branch: import("./projectMatch.js").HostBranchTarget | null;
      options: import("./projectMatch.js").HostCloneOptions;
      setupRecipeId: string | null;
    }
  /** Open a project the target already has (or adopt an unregistered clone it found). */
  | {
      kind: "open";
      opId: string;
      toHostId: HostId;
      candidate: { projectId: string | null; path: string };
      remoteUrls: string[];
      branch: import("./projectMatch.js").HostBranchTarget | null;
      branchRemoteUrl: string | null;
    }
  /** Clone a repository by its URL onto a host, register and open it (Add project…). */
  | {
      kind: "clone-url";
      opId: string;
      toHostId: HostId;
      url: string;
      destination: string;
      options: import("./projectMatch.js").HostCloneOptions;
    }
  /** Create the worktree asked for in the new-worktree dialog, in a project the target has. */
  | {
      kind: "create-worktree";
      opId: string;
      toHostId: HostId;
      projectId: string;
      worktree: import("./projectMatch.js").PlacedWorktree;
    }
  /** "Check out <branch> here" on a project the target has. */
  | {
      kind: "checkout";
      opId: string;
      toHostId: HostId;
      projectId: string;
      branch: import("./projectMatch.js").HostBranchTarget;
      branchRemoteUrl: string | null;
    };

export type HostSwitchExecuteResult =
  | { kind: "pushed" }
  /** Git refused on the host that ran the step; `message` is git's own text. */
  | {
      kind: "git-failed";
      step: "push" | "clone" | "worktree";
      hostId: HostId;
      reason: string;
      message: string;
    }
  | ({ kind: "opened"; hostId: HostId } & import("./projectMatch.js").HostProjectOpened);

/** Where a running step is, for the dialog's progress line. */
export interface HostSwitchStatus {
  opId: string;
  state: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
  stage: string | null;
  message: string | null;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
}

export interface HostSwitchOpPayload {
  opId: string;
}

export interface HostSwitchCheckDestinationPayload {
  toHostId: HostId;
  path: string;
  remoteUrls: string[];
}

/** Which other hosts have a project, by its repository identity. */
export interface HostSwitchLocatePayload {
  fromHostId: HostId;
  projectId: string;
  toHostIds: HostId[];
}

/** What one host answered: its registered projects sharing a remote with the source. */
export interface HostProjectPresence {
  hostId: HostId;
  /** Null when the host couldn't be asked. */
  projects: Array<{ projectId: string; name: string; path: string }> | null;
}

export interface HostSwitchSuggestClonePayload {
  toHostId: HostId;
  url: string;
}

export interface HostSwitchListDirectoryPayload {
  toHostId: HostId;
  path: string;
  showHidden?: boolean;
}

export interface HostSwitchPickerRootsPayload {
  toHostId: HostId;
}
