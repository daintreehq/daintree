export interface FindProjectMatchPayload {
  remoteUrls: string[];
  committedProjectId: string | null;
}

export interface ProjectMatchCandidate {
  projectId: string | null;
  path: string;
  name: string;
  remotes: Array<{ name: string; url: string }>;
  /** "registered" is a Daintree project; "on-disk" is an unregistered clone found by scanning. */
  source: "registered" | "on-disk";
  matchedBy: "remote-url" | "committed-id";
  lastOpenedAt: number | null;
}

export interface ScanProjectMatchPayload {
  remoteUrls: string[];
}

export interface FindWorktreeForBranchPayload {
  projectId: string;
  branch: string;
}

export interface WorktreeForBranch {
  /** The working tree with the branch checked out, or null when none has it. */
  worktreePath: string | null;
}

/**
 * Setup chosen when a project was cloned onto this host, waiting for the
 * first view of the project to run it (recipes run in a view).
 */
export interface PendingHostSetup {
  projectId: string;
  recipeId: string;
  /** Where to run it; null runs it in the project's main folder. */
  worktreePath: string | null;
}

export interface TakePendingHostSetupPayload {
  projectId: string;
}

/** `shallow` is `--depth 1`; `partial` is `--filter=blob:none`. */
export type HostCloneDepth = "full" | "shallow" | "partial";

export interface HostCloneOptions {
  submodules: boolean;
  depth: HostCloneDepth;
}

/** A branch to have a working tree for once the project is on the host. */
export interface HostBranchTarget {
  /** The branch's name on this host once it exists here. */
  name: string;
  /** Its name on the remote it is fetched from (may differ under `push.default=upstream`). */
  remoteBranch: string;
}

/** Why a destination can or can't take a clone. */
export type DestinationStatus =
  /** Nothing there, or an empty folder. */
  | "free"
  /** Already a clone of the same repository. */
  | "same-repository"
  /** Something else lives there. */
  | "occupied"
  | "invalid";

export interface DestinationCheck {
  path: string;
  status: DestinationStatus;
  /** Plain-language reason for anything but `free`. */
  detail: string | null;
  /** A free sibling (`<name>-2`) when this one is taken. */
  suggestion: string | null;
}

export interface CheckDestinationPayload {
  path: string;
  remoteUrls: string[];
}

export interface SuggestDestinationPayload {
  /** The project's folder relative to the Shell user's home, when it is inside it. */
  homeRelativePath: string | null;
  repoName: string;
  remoteUrls: string[];
}

/** What a host can tell a Shell before it clones there. */
export interface HostCloneEnvironment {
  homeDir: string;
  /** Where this host keeps its projects: the common folder of the ones it has. */
  projectsDir: string;
  gitLfsAvailable: boolean;
}

export type HostCloneSource =
  | { kind: "remote"; url: string }
  /** A repository bundle already received on this host, named by its token. */
  | { kind: "bundle"; token: string };

export interface CloneAndOpenPayload {
  opId: string;
  source: HostCloneSource;
  destination: string;
  branch: HostBranchTarget | null;
  options: HostCloneOptions;
  /** An in-repo recipe to run once the project is opened, if the clone has it. */
  setupRecipeId: string | null;
}

/** A project on this host, ready to open, and where its branch is. */
export interface HostProjectOpened {
  projectId: string;
  projectPath: string;
  projectName: string;
  /** The working tree for the requested branch, when there is one. */
  worktreePath: string | null;
  /**
   * The requested branch isn't checked out anywhere but exists on this
   * host's copy of the remote, so it can be checked out here.
   */
  canCheckOutBranch: boolean;
  /** Why the branch step produced no working tree, in git's words when git refused. */
  branchNote: string | null;
  /** The setup recipe that will run in the first view, when one was chosen and the clone has it. */
  setupRecipeId: string | null;
}

export type CloneAndOpenOutcome =
  | ({ ok: true } & HostProjectOpened)
  | {
      ok: false;
      /** `GitOperationError` reason, or a plain code for failures before git ran. */
      reason: string;
      /** Git's own error text (credentials scrubbed), or the refusal. */
      message: string;
    };

export interface OpenOnHostPayload {
  /** A registered project, or null to register `path` (an unregistered clone found on disk). */
  projectId: string | null;
  path: string;
  /** Remotes the folder must share before an unregistered one is adopted. */
  remoteUrls: string[];
  branch: HostBranchTarget | null;
  /** The source's remote URL for the branch, to pick the same remote here. */
  branchRemoteUrl: string | null;
}

/**
 * A new worktree asked for in one host's new-worktree dialog and placed on
 * another: what to create there. The path is relative to the project folder
 * (a sibling layout carries across hosts; an absolute path on one machine
 * means nothing on another); null lets the host pick by its own pattern.
 */
export interface PlacedWorktree {
  newBranch: string;
  baseBranch: string;
  fromRemote: boolean;
  useExistingBranch: boolean;
  relativePath: string | null;
  /** An in-repo recipe to run in the new worktree's first view, when the host's copy has it. */
  recipeId: string | null;
}

export interface PlaceWorktreePayload {
  opId: string;
  projectId: string;
  worktree: PlacedWorktree;
}

/** The repository identity of a project on its host: what another host matches it by. */
export interface ProjectIdentity {
  remotes: Array<{ name: string; url: string }>;
  committedProjectId: string | null;
}

export interface IdentifyProjectPayload {
  projectId: string;
}

export interface CheckOutBranchPayload {
  projectId: string;
  branch: HostBranchTarget;
  branchRemoteUrl: string | null;
}

/** What the source host reports about a project it is sending elsewhere. */
export interface SourceProjectDescription {
  projectId: string;
  projectName: string;
  projectPath: string;
  worktreePath: string;
  branch: string | null;
  branchCheck: import("./hostSwitch.js").BranchCheck | null;
  remoteBranch: string | null;
  /** The remote the branch lives on (or would be pushed to). */
  remote: string | null;
  /** That remote's URL, else origin's, else the only remote's. */
  cloneUrl: string | null;
  hasUncommittedChanges: boolean;
  /** Commits a push would publish (newest first, capped), for the confirmation to show. */
  unpushedCommits: Array<{ sha: string; subject: string }>;
  remotes: Array<{ name: string; url: string }>;
  committedProjectId: string | null;
  /** The project folder relative to this host's home, when inside it. */
  homeRelativePath: string | null;
  repoName: string;
  usesLfs: boolean;
  hasSubmodules: boolean;
  recipes: Array<{ id: string; name: string }>;
  defaultRecipeId: string | null;
}

export interface DescribeSourcePayload {
  projectId: string;
  worktreePath: string | null;
}

export interface PushBranchPayload {
  projectId: string;
  worktreePath: string;
  branch: string;
  remote: string;
  remoteBranch: string;
}

export type PushBranchOutcome = { ok: true } | { ok: false; reason: string; message: string };
