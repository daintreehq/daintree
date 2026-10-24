// Git and forge: worktrees, branches, files and their status, commits, issues,
// pull requests, CI checks and dev servers, drawn as the host draws its own.
// Every component here is presentational: the data comes from your worker
// (`host.getWorktrees()`, `host.git`, your forge provider) as props.

import type { MouseEvent, ReactNode } from "react";
import type { PluginAriaRootAttributes, PluginRootAttributes } from "./common.js";

/** A file's state in git, as the host's change lists letter it. */
export type PluginGitFileStatus =
  "modified" | "added" | "deleted" | "untracked" | "renamed" | "copied" | "ignored" | "conflicted";

/**
 * A worktree as the kit's worktree components read it. The field names are
 * `PluginWorktreeSnapshot`'s, so a snapshot from `host.getWorktrees()` passes
 * straight through.
 */
export interface PluginWorktreeItem {
  /** Non-empty and unique. A snapshot's `id`. */
  id: string;
  /** What the worktree is called. Falls back to the branch, then the path's last segment. */
  name?: string;
  branch?: string;
  /** Absolute path, shown in the picker and searched. */
  path?: string;
  /** The worktree this view stands in: marked "Current". */
  isCurrent?: boolean;
  /** The repository's main checkout: listed first. */
  isMainWorktree?: boolean;
  /** Commits on the branch its upstream does not have. */
  aheadCount?: number;
  /** Commits on the upstream the branch does not have. */
  behindCount?: number;
  /** Files with uncommitted changes. When absent, `status.changedFileCount` is read. */
  changedFileCount?: number;
  /** A snapshot's status projection; only its `changedFileCount` is read. */
  status?: { readonly changedFileCount?: number } | null;
  /** The heading the picker lists it under. Without any, the main checkout leads the rest. */
  group?: string;
}

/** Props of `BranchBadge`: a branch name as Daintree draws one in its chrome. */
export interface PluginBranchBadgeProps extends PluginRootAttributes {
  branch: string;
  className?: string;
}

/** Props of `WorktreeBadge`: a worktree's name, branch and how far it has moved. */
export interface PluginWorktreeBadgeProps extends PluginRootAttributes {
  worktree: PluginWorktreeItem;
  /** Shows the branch beside the name. Defaults to true; hidden anyway when it is the name. */
  showBranch?: boolean;
  /** Shows uncommitted changes and ahead/behind counts. Defaults to true. */
  showStatus?: boolean;
  className?: string;
}

/** Props of `WorktreePicker`: choose one of the project's worktrees. */
export interface PluginWorktreePickerProps extends PluginAriaRootAttributes {
  worktrees: readonly PluginWorktreeItem[];
  /** The chosen worktree's `id`, controlled. Passing the prop at all makes it controlled. */
  value?: string | null;
  defaultValue?: string;
  onValueChange?: (id: string, worktree: PluginWorktreeItem) => void;
  /** Whether the list is open, controlled. Pair with `onOpenChange`. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shown on the trigger while nothing is chosen. Defaults to "Choose a worktree". */
  placeholder?: string;
  /** The search field's placeholder. Defaults to "Search worktrees". */
  searchPlaceholder?: string;
  /** What the list says when nothing matches. Defaults to "No matching worktrees". */
  emptyMessage?: ReactNode;
  disabled?: boolean;
  density?: "default" | "compact";
  "aria-label"?: string;
  /** Classes for the trigger. */
  className?: string;
}

/** Props of `FileIcon`: the file-type glyph the host's file tree draws for a name. */
export interface PluginFileIconProps extends PluginRootAttributes {
  /** A file name or path; only the last segment is read. */
  path: string;
  /** `directory` draws a folder (open when `expanded`). Defaults to `file`. */
  kind?: "file" | "directory";
  expanded?: boolean;
  /** In px. Defaults to 14, the tree's size. */
  size?: number;
  /** Names the icon for assistive tech. Omitted, it is decorative. */
  "aria-label"?: string;
  className?: string;
}

/** Props of `FileLink`: a file path that opens in Daintree's file viewer. */
export interface PluginFileLinkProps extends PluginRootAttributes {
  /** Relative to `rootPath`, or absolute inside it. */
  path: string;
  /**
   * The absolute directory the file must be inside: the worktree's path. A path
   * that resolves outside it, or no usable root, draws the path without a link.
   */
  rootPath?: string;
  /** A 1-based line to open the file at, shown after the path. */
  line?: number;
  /** The text shown in place of the path. */
  children?: ReactNode;
  /** Draws the file's `FileIcon` before the path. Defaults to true. */
  icon?: boolean;
  /** Draws the path in the monospace face. Defaults to false. */
  mono?: boolean;
  /** Called before the file opens; call `preventDefault()` on the event to open it yourself. */
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /** The link's `tabIndex`: `-1` when your list owns the keyboard, so each row adds no Tab stop. */
  tabIndex?: number;
  className?: string;
}

/** Props of `GitStatusBadge`: a file's git state as the host's change lists mark it. */
export interface PluginGitStatusBadgeProps extends PluginRootAttributes {
  status: PluginGitFileStatus;
  /** `letter` (the default) is the one-character marker; `label` adds the word. */
  variant?: "letter" | "label";
  className?: string;
}

/** A person on a commit, issue or pull request. */
export interface PluginForgePerson {
  name: string;
  /** The avatar's URL. Omitted, the initials are drawn. */
  avatarUrl?: string;
  /** Shown in the author's tooltip on a commit. */
  email?: string;
}

/** A ref decorating a commit. */
export interface PluginCommitRef {
  name: string;
  /** Defaults to `branch`. `head` is the checked-out branch. */
  kind?: "branch" | "tag" | "remote" | "head";
}

/** One commit of a `CommitRow` or `CommitList`. */
export interface PluginCommit {
  /** The full hash. Non-empty; in a list, unique. */
  sha: string;
  /** The first line of the message. */
  subject: string;
  author?: PluginForgePerson;
  /** When it was authored: epoch ms, an ISO string or a `Date`. */
  date?: number | string | Date;
  refs?: readonly PluginCommitRef[];
  additions?: number;
  deletions?: number;
  /** Marks it "Not pushed". */
  unpushed?: boolean;
}

/** Props of `CommitRow`: one commit, as the host's commit list draws it. */
export interface PluginCommitRowProps extends PluginRootAttributes {
  commit?: PluginCommit;
  /** Draws the row's loading skeleton in place of a commit. */
  skeleton?: boolean;
  /** Makes the subject a button: open the commit. */
  onActivate?: (commit: PluginCommit) => void;
  /** The short hash's length. Defaults to 7. */
  shaLength?: number;
  className?: string;
}

/** Props of `CommitList`: commits in the order given (newest first, as git logs them), with skeleton rows while more load. */
export interface PluginCommitListProps extends PluginRootAttributes {
  commits: readonly PluginCommit[];
  /** Skeleton rows after the commits: `true` for three, or a count. */
  loading?: boolean | number;
  onActivate?: (commit: PluginCommit) => void;
  shaLength?: number;
  /** Shown when there are no commits and nothing is loading. */
  empty?: ReactNode;
  /** Names the list ("Commits on main"). */
  "aria-label"?: string;
  className?: string;
}

/** An issue's or pull request's state. `draft` is a pull request's alone. */
export type PluginForgeState = "open" | "closed" | "merged" | "draft";

/** Props of `ForgeStateBadge`: the host's state glyph for an issue or pull request. */
export interface PluginForgeStateBadgeProps extends PluginRootAttributes {
  /** Defaults to `pr`. An issue is open or closed: any other state draws as closed. */
  kind?: "issue" | "pr";
  state: PluginForgeState;
  /** `glyph` (the default) is the 16px mark alone, named for assistive tech; `badge` adds the word. */
  variant?: "glyph" | "badge";
  className?: string;
}

/** A label on an issue or pull request. */
export interface PluginForgeLabel {
  name: string;
  /** `#rgb` or `#rrggbb`, with or without the `#`. */
  color?: string;
}

/** What `IssueRow` and `PullRequestRow` share. */
export interface PluginForgeRowBaseProps extends PluginRootAttributes {
  /** The issue or pull request number, drawn as `#123`. */
  number: number | string;
  title: string;
  /** The forge page. Without `onOpen`, the title opens it in the browser. */
  url?: string;
  /** The title was pressed. Takes the place of opening `url`. */
  onOpen?: () => void;
  author?: PluginForgePerson;
  assignees?: readonly PluginForgePerson[];
  labels?: readonly PluginForgeLabel[];
  /** Labels drawn before the rest fold into "+N", from 1 to 20. Defaults to 1, as the host's own rows draw them. */
  maxLabels?: number;
  commentCount?: number;
  /** The age shown: epoch ms, an ISO string or a `Date`. */
  updatedAt?: number | string | Date;
  /** Words before the age. Defaults to "" (just "3h ago"). */
  timePrefix?: string;
  /** Marks the row as the list's current one: the highlighted fill, and `aria-current` on its title. */
  selected?: boolean;
  /** Your controls at the end of the title line (a `DropdownMenu` trigger). */
  actions?: ReactNode;
  /**
   * The title control's `tabIndex`. Pass `-1` when your list owns the keyboard
   * (a `useListNavigation` listbox, a grid with `aria-activedescendant`), so
   * the rows add no Tab stops of their own.
   */
  titleTabIndex?: number;
  className?: string;
}

/** Props of `IssueRow`. */
export interface PluginIssueRowProps extends PluginForgeRowBaseProps {
  state: "open" | "closed";
}

/** A pull request's checks rolled up, as its row shows them. */
export type PluginForgeCiStatus = "success" | "failure" | "pending" | "neutral";

/** A pull request's review decision. */
export type PluginForgeReviewDecision = "approved" | "changes_requested" | "review_required";

/** Props of `PullRequestRow`. */
export interface PluginPullRequestRowProps extends PluginForgeRowBaseProps {
  state: "open" | "closed" | "merged" | "draft";
  /** Checks rolled up. Shown while the pull request is open. */
  ci?: PluginForgeCiStatus;
  /** The head conflicts with the base: shown in place of `ci`. */
  mergeConflict?: boolean;
  /** Approved and changes requested are shown; awaiting review is the resting state and is not. */
  review?: PluginForgeReviewDecision;
  headRef?: string;
  baseRef?: string;
}

/** A CI check's state. */
export type PluginCheckStatus =
  | "queued"
  | "running"
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "timed_out"
  | "neutral"
  | "action_required";

/** One check of a `ChecksList`. */
export interface PluginCheck {
  /** Unique when given; matrix jobs repeat names, so the list does not key on them. */
  id?: string;
  name: string;
  status: PluginCheckStatus;
  /** The workflow or pipeline it belongs to: the list groups by it. */
  workflow?: string;
  /** Whether it gates merging. Omitted is unknown, not optional. */
  required?: boolean;
  /** How long it ran, in ms. Otherwise worked out from `startedAt` and `finishedAt`, or counted live from `startedAt` while it runs. */
  durationMs?: number;
  startedAt?: number | string | Date;
  finishedAt?: number | string | Date;
  /** Its log or output page: an http(s) URL, opened in the browser. */
  detailsUrl?: string;
}

/** Props of `ChecksList`: CI checks by workflow under a "3 failing, 12 passing" summary. */
export interface PluginChecksListProps extends PluginRootAttributes {
  checks: readonly PluginCheck[];
  /** A heading before the summary ("Checks"). */
  title?: ReactNode;
  /** The counts line. Defaults to true. */
  summary?: boolean;
  /** Your controls at the end of the header (Re-run). */
  actions?: ReactNode;
  /** A check's details button was pressed. Takes the place of opening `detailsUrl`. */
  onOpenDetails?: (check: PluginCheck) => void;
  /** Shown when there are no checks. */
  empty?: ReactNode;
  "aria-label"?: string;
  className?: string;
}

/** A dev server's process state. */
export type PluginDevServerState =
  "starting" | "installing" | "running" | "crashed" | "stopping" | "stopped";

/** Props of `PortLink`: a local server's address that opens in Daintree's browser. */
export interface PluginPortLinkProps extends PluginRootAttributes {
  /** A loopback http(s) URL (`http://localhost:5173/app`). Anything else draws as text. */
  url?: string;
  /** In place of `url`: `http://localhost:<port>`. */
  port?: number;
  /** `panel` (the default) opens a Daintree browser panel; `external` the system browser. */
  target?: "panel" | "external";
  /** A copy button after the address. Defaults to true. */
  copyable?: boolean;
  /** The text shown in place of `localhost:5173`. */
  children?: ReactNode;
  className?: string;
}

/** Props of `DevServerStatus`: a dev server's state and the address it serves. */
export interface PluginDevServerStatusProps extends PluginRootAttributes {
  status: PluginDevServerState;
  /** What it is ("Vite", "web"). Defaults to "Dev server". */
  name?: string;
  /** Its address, drawn as a `PortLink` while it runs. */
  url?: string;
  port?: number;
  /** Why it crashed, shown under the state. */
  error?: string;
  /** Where the address opens, as `PortLink`'s `target`. */
  target?: "panel" | "external";
  /** Your controls at the end (Restart, Stop). */
  actions?: ReactNode;
  className?: string;
}
