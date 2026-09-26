import type { BranchCheck, HostSwitchPreparation } from "@shared/types/ipc/hostSwitch";
import type { PlacedWorktree, ProjectMatchCandidate } from "@shared/types/ipc/projectMatch";
import { extractHostname } from "@shared/utils/forgeHostnames";
import { normalizeGitRemoteUrl } from "@shared/utils/gitRemoteUrl";

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

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * The branch line of the dialog, from the fresh check on the source: what we
 * saw, and the ways forward. Pushing is offered, never done unasked.
 */
export function describeBranchHandoff(
  prep: Pick<HostSwitchPreparation, "branch" | "branchCheck">,
  sourceName: string
): BranchHandoff {
  const branch = prep.branch;
  const check: BranchCheck | null = prep.branchCheck;
  if (!branch || !check || check.kind === "detached") {
    return {
      summary: `No branch is checked out on ${sourceName}`,
      detail: "The project opens on its default branch.",
      tone: "neutral",
      choices: [],
      defaultPlan: "no-worktree",
    };
  }
  const fromRemote: BranchChoice = {
    plan: "worktree",
    label: "Continue from the remote's version",
    description: null,
  };
  const startFresh: BranchChoice = {
    plan: "no-worktree",
    label: "Start from the default branch",
    description: `${branch} stays on ${sourceName}.`,
  };
  switch (check.kind) {
    case "same-tip":
      return {
        summary: `On ${check.remote} at the same commit`,
        detail: `A worktree for ${branch} is created after cloning.`,
        tone: "ok",
        choices: [],
        defaultPlan: "worktree",
      };
    case "behind":
      return {
        summary: `On ${check.remote}, which has ${plural(check.behind, "newer commit")}`,
        detail: `A worktree for ${branch} is created from ${check.remote}'s version.`,
        tone: "ok",
        choices: [],
        defaultPlan: "worktree",
      };
    case "ahead":
      return {
        summary: `${branch} has ${plural(check.ahead, "unpushed commit")} on ${sourceName}`,
        detail: null,
        tone: "attention",
        choices: [
          {
            plan: "push-then-worktree",
            label: "Push, then continue",
            description: `Pushes to ${check.remote} from ${sourceName}, with ${sourceName}'s credentials.`,
          },
          {
            ...fromRemote,
            description: `The unpushed commits stay on ${sourceName}.`,
          },
        ],
        // Pushing is outward-facing: it is chosen, never preselected.
        defaultPlan: "worktree",
      };
    case "diverged":
      return {
        summary: `${branch} has diverged from ${check.remote} on ${sourceName}`,
        detail: `Nothing is pushed. Cancel to sort it out on ${sourceName}, or continue from ${check.remote}'s version.`,
        tone: "attention",
        choices: [],
        defaultPlan: "worktree",
      };
    case "not-on-remote": {
      const upstream = check.upstream
        ? `Its upstream is set to ${check.upstream}, which the remote doesn't have.`
        : null;
      const choices: BranchChoice[] = [];
      if (check.remote) {
        choices.push({
          plan: "push-then-worktree",
          label: "Push branch, then continue",
          description: `Pushes to ${check.remote} from ${sourceName} and sets it as the upstream.`,
        });
      }
      choices.push(startFresh);
      return {
        summary: `${branch} only exists on ${sourceName}`,
        detail: upstream,
        tone: "attention",
        choices,
        defaultPlan: "no-worktree",
      };
    }
    case "remote-unreachable":
      return {
        summary: `Couldn't reach ${check.remote ?? "the remote"} from ${sourceName}`,
        detail: check.detail,
        tone: "attention",
        choices: [fromRemote, startFresh],
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
  if (match.name === "origin") return "Clone of your fork";
  if (match.name === "upstream") return "Clone of upstream";
  return `Clone of ${match.name}`;
}

/** The dialog's opening view, from what the target already has and the source's remotes. */
export function initialView(
  prep: Pick<HostSwitchPreparation, "candidates" | "remotes">
): "existing" | "clone" | "local-only" {
  if (prep.candidates.length > 0) return "existing";
  return prep.remotes.length === 0 ? "local-only" : "clone";
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
