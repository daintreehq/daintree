import type { SimpleGit } from "simple-git";
import type { ForgeNewPRLinkState } from "../../shared/types/ipc/forge.js";
import { parseKnownRemoteBranch } from "../../shared/utils/baseRemoteSelection.js";
import { refExists } from "./baseCompareRef.js";
import { resolveGitPushAndUpstream } from "./gitPushDestination.js";
import { readRemoteBranchTip, type RawGitRunner } from "./remoteBranchTip.js";

type LocalGit = Pick<SimpleGit, "raw" | "getRemotes">;

export interface NewPRLinkInput {
  git: LocalGit;
  /** Opened only when the local refs can't answer, since it means asking the network. */
  openNetworkGit: () => Promise<RawGitRunner>;
  /** The remote the forge provider resolved this repository from. */
  forgeRemote: string;
  head: string;
  base: string | null;
  baseRef: string | null;
  buildUrl: (refs: { base: string; head: string }) => string | null;
}

const UNAVAILABLE: ForgeNewPRLinkState = { state: "unavailable" };

/**
 * What the "No PR" chip can offer for `head`.
 *
 * The URL only names branches on the forge's repository, so anything that puts
 * either end somewhere else (a branch pushed to a fork, a base measured on
 * `upstream`) is `unavailable` rather than a page for the wrong repository.
 */
export async function deriveNewPRLink(input: NewPRLinkInput): Promise<ForgeNewPRLinkState> {
  const { git, forgeRemote, head } = input;
  const remotes = (await git.getRemotes()).map((remote) => remote.name);

  const remoteHead = await resolveRemoteHead(git, head, remotes, forgeRemote);
  if (remoteHead === null) return UNAVAILABLE;

  const pushed = await isOnRemote(input, remoteHead);
  if (pushed === null) return UNAVAILABLE;
  if (!pushed) return { state: "unpushed" };

  const base = await resolveRemoteBase(input, remotes);
  if (base === null || base === remoteHead) return UNAVAILABLE;

  const url = input.buildUrl({ base, head: remoteHead });
  return url === null ? UNAVAILABLE : { state: "ready", url };
}

/** The name `head` has on the forge's remote, which a push config can make different. */
async function resolveRemoteHead(
  git: LocalGit,
  head: string,
  remotes: readonly string[],
  forgeRemote: string
): Promise<string | null> {
  const { push } = await resolveGitPushAndUpstream(git, head, remotes);
  if (push.status === "resolved") {
    return push.destination.remote === forgeRemote ? push.destination.branch : null;
  }
  // Several remotes and no config naming one is every fresh branch in a fork
  // setup. Nothing says it went elsewhere, so the forge's remote can still be
  // asked about it under its own name.
  return push.reason === "ambiguous" ? head : null;
}

/**
 * `null` when the remote couldn't be asked: an unreachable remote is no
 * evidence that the branch isn't there, so it never reads as unpushed.
 */
async function isOnRemote(input: NewPRLinkInput, branch: string): Promise<boolean | null> {
  if (await refExists(input.git, `refs/remotes/${input.forgeRemote}/${branch}`)) return true;
  const networkGit = await input.openNetworkGit();
  const tip = await readRemoteBranchTip(networkGit, input.forgeRemote, branch);
  return tip === undefined ? null : tip !== null;
}

async function resolveRemoteBase(
  input: NewPRLinkInput,
  remotes: readonly string[]
): Promise<string | null> {
  const { git, forgeRemote, base, baseRef } = input;
  if (base !== null) {
    const measuredOn = parseKnownRemoteBranch(baseRef, remotes);
    return measuredOn && measuredOn.remote !== forgeRemote ? null : base;
  }
  // The main worktree gets no base divergence, so it has no base of its own.
  // Git's record of what the remote calls its default is the one local answer
  // that isn't a guess; without it there is no target to name.
  const prefix = `refs/remotes/${forgeRemote}/`;
  const target = await git
    .raw(["symbolic-ref", "--quiet", `${prefix}HEAD`])
    .then((out) => out.trim())
    .catch(() => "");
  return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}
