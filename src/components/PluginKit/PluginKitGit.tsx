import {
  KitBranchBadge,
  KitFileIcon,
  KitFileLink,
  KitGitStatusBadge,
  KitWorktreeBadge,
  KitWorktreePicker,
} from "./PluginKitGitWorktree";
import { KitCommitList, KitCommitRow } from "./PluginKitGitCommits";
import {
  KitChecksList,
  KitForgeStateBadge,
  KitIssueRow,
  KitPullRequestRow,
} from "./PluginKitGitForge";
import { KitDevServerStatus, KitPortLink } from "./PluginKitGitRuntime";

export { resolveFileLink, worktreeRows } from "./PluginKitGitWorktree";
export { checksSummary, ciLook, forgeStateLook } from "./PluginKitGitForge";
export { portLinkUrl } from "./PluginKitGitRuntime";

export const pluginKitGit = {
  BranchBadge: KitBranchBadge,
  WorktreeBadge: KitWorktreeBadge,
  WorktreePicker: KitWorktreePicker,
  FileIcon: KitFileIcon,
  FileLink: KitFileLink,
  GitStatusBadge: KitGitStatusBadge,
  CommitRow: KitCommitRow,
  CommitList: KitCommitList,
  ForgeStateBadge: KitForgeStateBadge,
  IssueRow: KitIssueRow,
  PullRequestRow: KitPullRequestRow,
  ChecksList: KitChecksList,
  DevServerStatus: KitDevServerStatus,
  PortLink: KitPortLink,
};
