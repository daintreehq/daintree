import type { BranchCheck, HostSwitchPreparation } from "@shared/types/ipc/hostSwitch";
import type { PlacedWorktree, ProjectMatchCandidate } from "@shared/types/ipc/projectMatch";
import { extractHostname } from "@shared/utils/forgeHostnames";
import { isSupportedCloneUrl, normalizeGitRemoteUrl } from "@shared/utils/gitRemoteUrl";
import { pluralize } from "@/lib/pluralize";

/** What happens to the branch once the project is on the target host. */
export type BranchPlan =
  /** Find or create a working tree for it from the remote's version. */
  | "worktree"
  /** Push it from the source first (with the source's credentials), then as above. */
  | "push-then-worktree"
  /** Open the project without a working tree for the branch. */
  | "no-worktree";

export interface BranchChoice {
  plan: BranchPlan;
  label: string;
  description: string | null;
}

export interface BranchHandoff {
  summary: string;
  detail: string | null;
  tone: "ok" | "attention" | "neutral";
  /** Empty when there is nothing to choose; `defaultPlan` then applies. */
  choices: BranchChoice[];
  defaultPlan: BranchPlan;
}

/** `origin/topic`: where a push goes, as the choice names it. */
function pushTarget(destination: { remote: string; branch: string }): string {
  return `${destination.remote}/${destination.branch}`;
}

/**
 * The branch line of the dialog, from the fresh check on the source: what we
 * saw, and the ways forward. Pushing is offered, never done unasked, and only
 * to where git itself pushes the branch, named in the choice.
 * `existingCopy` is the host already having the project, so not taking the
 * branch opens that copy as it is rather than a fresh clone's default branch.
 */
export function describeBranchHandoff(
  prep: Pick<
    HostSwitchPreparation,
    "branch" | "branchCheck" | "pushDestination" | "headSha" | "unpushedCommitCount" | "isUnborn"
  >,
  sourceName: string,
  existingCopy = false
): BranchHandoff {
  const branch = prep.branch;
  const check: BranchCheck | null = prep.branchCheck;
  const stays = existingCopy ? "The copy there opens as it is." : null;
  if (!branch || !check || check.kind === "detached") {
    const at = prep.headSha ? ` (at ${prep.headSha.slice(0, 8)})` : "";
    return {
      summary: `No branch is checked out on ${sourceName}${at}`,
      detail: stays ?? "The clone opens on its default branch.",
      tone: "neutral",
      choices: [],
      defaultPlan: "no-worktree",
    };
  }
  if (prep.isUnborn) {
    return {
      summary: `${branch} has no commits on ${sourceName} yet`,
      detail: stays,
      tone: "neutral",
      choices: [],
      defaultPlan: "no-worktree",
    };
  }
  const fromRemote = (remote: string | null): BranchChoice => ({
    plan: "worktree",
    label: remote ? `Continue from ${remote}'s version` : "Continue from the pushed version",
    description: null,
  });
  const startFresh: BranchChoice = {
    plan: "no-worktree",
    label: existingCopy ? "Open the copy as it is" : "Start from the default branch",
    description: `${branch} stays on ${sourceName}.`,
  };
  const destination = prep.pushDestination;
  const noPush = (upstream: string | null, remote: string): string =>
    upstream && upstream !== `${remote}/${branch}`
      ? `It tracks ${upstream}, a different branch, so it isn't pushed from here.`
      : `git has no push destination for ${branch} on ${sourceName}, so it isn't pushed from here.`;
  switch (check.kind) {
    case "same-tip":
      return {
        summary: `On ${check.remote} at the same commit`,
        detail: `It opens in a worktree for ${branch}.`,
        tone: "ok",
        choices: [],
        defaultPlan: "worktree",
      };
    case "behind":
      return {
        summary: `On ${check.remote}, which has ${pluralize(check.behind, "newer commit")}`,
        detail: `It opens in a worktree for ${branch}, from ${check.remote}'s version.`,
        tone: "ok",
        choices: [],
        defaultPlan: "worktree",
      };
    case "ahead": {
      const count = Math.max(prep.unpushedCommitCount, check.ahead);
      const choices: BranchChoice[] = [];
      if (destination) {
        choices.push(
          {
            plan: "push-then-worktree",
            label: `Push ${pluralize(count, "commit")} to ${pushTarget(destination)}, then continue`,
            description: `Pushes from ${sourceName}, with ${sourceName}'s credentials.`,
          },
          {
            ...fromRemote(check.remote),
            description: `The unpushed commits stay on ${sourceName}.`,
          }
        );
      }
      return {
        summary: `${branch} has ${pluralize(check.ahead, "unpushed commit")} on ${sourceName}`,
        detail: destination
          ? null
          : `${noPush(null, check.remote)} It continues from ${check.remote}'s version; the unpushed commits stay on ${sourceName}.`,
        tone: "attention",
        choices,
        // Pushing is outward-facing: it is chosen, never preselected.
        defaultPlan: "worktree",
      };
    }
    case "diverged":
      return {
        summary: `${branch} has diverged from ${check.remote} on ${sourceName}`,
        detail: `Nothing is pushed. Cancel to sort it out on ${sourceName}, or continue from ${check.remote}'s version.`,
        tone: "attention",
        choices: [],
        defaultPlan: "worktree",
      };
    case "not-on-remote": {
      const choices: BranchChoice[] = [];
      if (destination) {
        choices.push({
          plan: "push-then-worktree",
          label: `Push ${branch} to ${pushTarget(destination)}, then continue`,
          description: `Pushes from ${sourceName}, with ${sourceName}'s credentials.`,
        });
      }
      choices.push(startFresh);
      return {
        summary: `${branch} only exists on ${sourceName}`,
        detail: destination || !check.remote ? null : noPush(check.upstream, check.remote),
        tone: "attention",
        choices,
        defaultPlan: "no-worktree",
      };
    }
    case "remote-unreachable":
      return {
        summary: `Couldn't reach ${check.remote ?? "the branch's remote"} from ${sourceName}`,
        detail: check.detail,
        tone: "attention",
        choices: [fromRemote(check.remote), startFresh],
        defaultPlan: "worktree",
      };
  }
}

function forgeName(url: string | null): string | null {
  const host = url ? extractHostname(url) : null;
  if (host === "github.com") return "GitHub";
  if (host === "gitlab.com") return "GitLab";
  return null;
}

/**
 * A clone the target host couldn't do: name the host, keep git's own words,
 * and say what the host needs (its own access, never this machine's).
 */
export function describeCloneFailure(input: {
  reason: string;
  message: string;
  hostName: string;
  url: string | null;
}): { title: string; gitText: string; fix: string | null } {
  const { reason, hostName, url } = input;
  const title = url
    ? `${hostName} couldn't clone ${url}`
    : `${hostName} couldn't clone the repository`;
  let fix: string | null = null;
  if (reason === "auth-failed" || reason === "repository-not-found") {
    const forge = forgeName(url);
    fix = forge
      ? `${hostName} needs its own access to this repo: add an SSH key on ${hostName}, or connect ${forge} on ${hostName} (Settings on ${hostName} → ${forge}).`
      : `${hostName} needs its own access to this repo: add an SSH key or credentials on ${hostName}.`;
  } else if (reason === "network-unavailable") {
    fix = `${hostName} couldn't reach the server. Check its network and try again.`;
  } else if (reason === "git-not-installed") {
    fix = `Install git on ${hostName}.`;
  } else if (reason === "lfs-missing") {
    fix = `Install Git LFS on ${hostName}.`;
  }
  return { title, gitText: input.message, fix };
}

/**
 * How a candidate relates to the source's remotes when the source tracks
 * more than one repository (a fork and its upstream): whose clone it is.
 */
export function candidateRelation(
  candidate: Pick<ProjectMatchCandidate, "remotes">,
  sourceRemotes: Array<{ name: string; url: string }>
): string | null {
  const distinct = new Set(
    sourceRemotes.map((r) => normalizeGitRemoteUrl(r.url)).filter((u): u is string => u !== null)
  );
  if (distinct.size < 2) return null;
  const primary =
    candidate.remotes.find((r) => r.name === "origin") ?? candidate.remotes[0] ?? null;
  const primaryUrl = primary ? normalizeGitRemoteUrl(primary.url) : null;
  if (!primaryUrl) return null;
  const match = sourceRemotes.find((r) => normalizeGitRemoteUrl(r.url) === primaryUrl);
  if (!match) return null;
  // Named for the remote it matched; whether that is a fork is not ours to guess.
  return `Same repository as your ${match.name}`;
}

/**
 * Nothing to decide: the host has exactly one copy that is already a project,
 * the branch is on the remote as it is here, and nothing would stay behind.
 * The dialog then opens it straight away instead of asking.
 */
export function opensWithoutQuestion(
  prep: Pick<
    HostSwitchPreparation,
    | "candidates"
    | "branch"
    | "branchCheck"
    | "pushDestination"
    | "headSha"
    | "unpushedCommitCount"
    | "isUnborn"
    | "hasUncommittedChanges"
    | "usesLfs"
    | "targetGitLfsAvailable"
  >,
  placedWorktree: boolean,
  navigateOnly = false
): boolean {
  if (placedWorktree) return false;
  const only = prep.candidates.length === 1 ? prep.candidates[0]! : null;
  // Matched by remote, never by a committed id alone: a fork inherits that id.
  if (!only || only.source !== "registered" || only.matchedBy !== "remote-url") return false;
  // Going to the copy as it is moves nothing, so nothing here can be left behind.
  if (navigateOnly) return true;
  if (prep.hasUncommittedChanges) return false;
  if (prep.usesLfs && !prep.targetGitLfsAvailable) return false;
  const handoff = describeBranchHandoff(prep, "");
  return handoff.tone === "ok" && handoff.choices.length === 0;
}

/**
 * The remotes another host can clone from: a forge or server URL. A
 * `file://` or local-path remote names this machine's disk, which the other
 * host can't read.
 */
export function cloneableRemotes(
  remotes: Array<{ name: string; url: string }>
): Array<{ name: string; url: string }> {
  return remotes.filter((r) => isSupportedCloneUrl(r.url));
}

/** The dialog's opening view, from what the target already has and the source's remotes. */
export function initialView(
  prep: Pick<HostSwitchPreparation, "candidates" | "remotes">
): "existing" | "clone" | "local-only" {
  if (prep.candidates.length > 0) return "existing";
  return cloneableRemotes(prep.remotes).length === 0 ? "local-only" : "clone";
}

/** The name a host goes by in copy: its own name, or "This Mac" for this machine. */
export function hostDisplayName(
  hostId: string,
  hosts: Array<{ descriptor: { id: string; name: string } }>,
  localLabel: string
): string {
  if (hostId === "local") return localLabel;
  return hosts.find((h) => h.descriptor.id === hostId)?.descriptor.name ?? hostId;
}

/** The placed worktree, in words: what will be created on the host, and from what. */
export function describePlacedWorktree(worktree: PlacedWorktree, hostName: string): string {
  const from = worktree.useExistingBranch
    ? `Checks out the existing branch on ${hostName}`
    : `New branch from ${worktree.baseBranch}${worktree.fromRemote ? " on the remote" : ""}`;
  const where = worktree.relativePath
    ? `, at ${worktree.relativePath} beside the project`
    : `, where ${hostName} puts new worktrees`;
  return `${from}${where}.`;
}

/**
 * The clone destination once "Change…" picked `folder` on the host: the
 * picked folder itself when it already carries the clone's folder name,
 * otherwise that name inside it.
 */
export function destinationInFolder(folder: string, current: string, fallbackName: string): string {
  const trimmed = current.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1) || fallbackName;
  const parent = folder.replace(/\/+$/, "") || "/";
  if (parent.slice(parent.lastIndexOf("/") + 1) === name) return parent;
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}
