import type {
  Worktree,
  WorktreeMood,
  WorktreeLifecycleStatus,
  WorktreeLifecyclePhaseResult,
  WorktreeResourceStatus,
  WslGitEligibility,
} from "../../shared/types/worktree.js";
import type { CIStatusState } from "../../shared/types/forge.js";
import type { WorktreeSnapshot } from "../../shared/types/workspace-host.js";
import type { WorktreeChanges, RepoState } from "../../shared/types/git.js";
import type { PluginWorktreeLinked } from "../../shared/types/plugin.js";

export interface SnapshotBuilderHost {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly branch: string | undefined;
  readonly isCurrent: boolean;
  readonly isMainWorktree: boolean;
  readonly gitDir: Worktree["gitDir"];
  readonly summary: string | undefined;
  readonly modifiedCount: number;
  readonly mood: WorktreeMood;
  readonly lastActivityTimestamp: number | null;
  readonly createdAt: number | undefined;
  readonly aiNote: string | undefined;
  readonly aiNoteTimestamp: number | undefined;
  readonly issueNumber: number | undefined;
  readonly prNumber: number | undefined;
  readonly prUrl: string | undefined;
  readonly prState: import("../../shared/types/forge.js").NormalizedPRState | undefined;
  readonly prCiStatus: CIStatusState | undefined;
  readonly prTitle: string | undefined;
  readonly issueTitle: string | undefined;
  readonly branchDerivedTitle: string | undefined;
  readonly sourcePrNumber: number | undefined;
  readonly prLastUpdatedAt: number | undefined;
  readonly issueLastUpdatedAt: number | undefined;
  readonly worktreeChanges: WorktreeChanges | null;
  readonly lifecycleStatus: WorktreeLifecycleStatus | undefined;
  readonly lifecyclePhaseResults: readonly WorktreeLifecyclePhaseResult[];
  readonly resourceStatus: WorktreeResourceStatus | undefined;
  readonly resourceConnectCommand: string | undefined;
  readonly resourceProvider: string | undefined;
  readonly hasResourceConfig: boolean;
  readonly hasStatusCommand: boolean;
  readonly hasPauseCommand: boolean;
  readonly hasResumeCommand: boolean;
  readonly hasTeardownCommand: boolean;
  readonly hasProvisionCommand: boolean;
  readonly worktreeMode: string;
  readonly worktreeEnvironmentLabel: string | undefined;
  readonly hasPlanFile: boolean;
  readonly planFilePath: string | undefined;
  readonly aheadCount: number | undefined;
  readonly behindCount: number | undefined;
  readonly baseBranchName: string | null | undefined;
  readonly baseAheadCount: number | null | undefined;
  readonly baseBehindCount: number | null | undefined;
  readonly baseMatchesUpstream: boolean | undefined;
  readonly lastFetchedAt: number | null;
  readonly lastGitStatusCheckedAt: number;
  readonly fetchAuthFailed: boolean;
  readonly fetchNetworkFailed: boolean;
  readonly isFetchInFlight: boolean;
  readonly matchedForgeProviderId: string | null;
  readonly isWslPath: boolean;
  readonly wslDistro: string | undefined;
  readonly wslPosixPath: string | undefined;
  readonly wslGitEligible: WslGitEligibility;
  readonly wslGitOptIn: boolean;
  readonly wslGitDismissed: boolean;
  readonly linked: PluginWorktreeLinked | null | undefined;
  readonly repoState: RepoState | undefined;
  readonly isDetached: boolean;
  readonly head: string | undefined;
}

/** Assembles the IPC-serializable `WorktreeSnapshot` from live monitor state. */
export class SnapshotBuilder {
  constructor(private readonly host: SnapshotBuilderHost) {}

  build(): WorktreeSnapshot {
    let resourceStatus: WorktreeResourceStatus | undefined;
    if (this.host.resourceStatus) {
      resourceStatus = { ...this.host.resourceStatus, provider: this.host.resourceProvider };
    } else if (this.host.resourceProvider) {
      resourceStatus = { provider: this.host.resourceProvider };
    }

    // `linked` is the source of truth (#8452). When present, the legacy flat
    // fields are derived from it; the private flat fields only serve the
    // legacy/branch-parse path where `_linked` was never populated.
    const linkedPr = this.host.linked?.pr;
    const linkedIssue = this.host.linked?.issue;
    const linkedPrState: "open" | "merged" | "closed" | undefined = linkedPr
      ? linkedPr.state === "declined"
        ? "closed"
        : linkedPr.state
      : undefined;
    const linkedPrCiStatus: CIStatusState | undefined =
      linkedPr?.ciStatus &&
      (linkedPr.ciStatus.state === "success" ||
        linkedPr.ciStatus.state === "failure" ||
        linkedPr.ciStatus.state === "pending")
        ? linkedPr.ciStatus.state
        : undefined;

    const snapshot: WorktreeSnapshot = {
      id: this.host.id,
      path: this.host.path,
      name: this.host.name,
      branch: this.host.branch,
      isCurrent: this.host.isCurrent,
      isMainWorktree: this.host.isMainWorktree,
      gitDir: this.host.gitDir,
      summary: this.host.summary,
      modifiedCount: this.host.modifiedCount,
      mood: this.host.mood,
      lastActivityTimestamp: this.host.lastActivityTimestamp,
      createdAt: this.host.createdAt,
      aiNote: this.host.aiNote,
      aiNoteTimestamp: this.host.aiNoteTimestamp,
      issueNumber: linkedIssue?.ref.number ?? this.host.issueNumber,
      prNumber: linkedPr?.ref.number ?? this.host.prNumber,
      prUrl: linkedPr?.url ?? this.host.prUrl,
      prState: linkedPr
        ? linkedPrState
        : this.host.prState === "declined"
          ? "closed"
          : this.host.prState,
      prCiStatus: linkedPr ? linkedPrCiStatus : this.host.prCiStatus,
      prTitle: linkedPr ? linkedPr.title : this.host.prTitle,
      issueTitle: linkedIssue ? linkedIssue.title : this.host.issueTitle,
      branchDerivedTitle: this.host.branchDerivedTitle,
      sourcePrNumber: this.host.sourcePrNumber,
      prLastUpdatedAt: this.host.prLastUpdatedAt,
      issueLastUpdatedAt: this.host.issueLastUpdatedAt,
      worktreeChanges: this.host.worktreeChanges,
      worktreeId: this.host.id,
      timestamp: Date.now(),
      lifecycleStatus: this.host.lifecycleStatus,
      lifecyclePhaseResults:
        this.host.lifecyclePhaseResults.length > 0
          ? [...this.host.lifecyclePhaseResults]
          : undefined,
      resourceStatus,
      resourceConnectCommand: this.host.resourceConnectCommand,
      hasResourceConfig: this.host.hasResourceConfig || undefined,
      hasStatusCommand: this.host.hasStatusCommand || undefined,
      hasPauseCommand: this.host.hasPauseCommand || undefined,
      hasResumeCommand: this.host.hasResumeCommand || undefined,
      hasTeardownCommand: this.host.hasTeardownCommand || undefined,
      hasProvisionCommand: this.host.hasProvisionCommand || undefined,
      worktreeMode: this.host.worktreeMode !== "local" ? this.host.worktreeMode : undefined,
      worktreeEnvironmentLabel: this.host.worktreeEnvironmentLabel,
      hasPlanFile: this.host.hasPlanFile || undefined,
      planFilePath: this.host.planFilePath,
      aheadCount: this.host.aheadCount,
      behindCount: this.host.behindCount,
      baseBranchName: this.host.baseBranchName ?? undefined,
      baseAheadCount: this.host.baseAheadCount ?? undefined,
      baseBehindCount: this.host.baseBehindCount ?? undefined,
      baseMatchesUpstream: this.host.baseMatchesUpstream ?? undefined,
      lastFetchedAt: this.host.lastFetchedAt ?? undefined,
      lastGitStatusCheckedAt: this.host.lastGitStatusCheckedAt,
      fetchAuthFailed: this.host.fetchAuthFailed || undefined,
      fetchNetworkFailed: this.host.fetchNetworkFailed || undefined,
      // Read in-flight state authoritatively at snapshot time (lesson #1700)
      // so a snapshot emitted between fetch-start and fetch-end always
      // serializes the correct value, never a stale cached copy.
      isFetchInFlight: this.host.isFetchInFlight || undefined,
      matchedForgeProviderId: this.host.matchedForgeProviderId ?? undefined,
      isWslPath: this.host.isWslPath || undefined,
      wslDistro: this.host.wslDistro,
      wslPosixPath: this.host.wslPosixPath,
      // Emit the three-state value directly for WSL paths so the renderer can
      // tell "ineligible" (distro mismatch) from "unprobed" (probe pending /
      // failed). Suppressed for non-WSL worktrees to keep snapshots lean.
      wslGitEligible: this.host.isWslPath ? this.host.wslGitEligible : undefined,
      wslGitOptIn: this.host.wslGitOptIn || undefined,
      wslGitDismissed: this.host.wslGitDismissed || undefined,
      linked: this.host.linked,
      repoState: this.host.repoState || undefined,
      isDetached: this.host.isDetached || undefined,
      head: this.host.head || undefined,
    };

    return snapshot;
  }
}
