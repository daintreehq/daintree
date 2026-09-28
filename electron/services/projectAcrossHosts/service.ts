import fs from "node:fs/promises";
import path from "node:path";
import type {
  CheckDestinationPayload,
  CheckOutBranchPayload,
  CloneAndOpenOutcome,
  CloneAndOpenPayload,
  DescribeSourcePayload,
  DestinationCheck,
  FindProjectMatchPayload,
  FindWorktreeForBranchPayload,
  HostBranchTarget,
  HostCloneEnvironment,
  HostProjectOpened,
  IdentifyProjectPayload,
  OpenOnHostPayload,
  PendingHostSetup,
  PlaceWorktreePayload,
  PlacedWorktree,
  ProjectIdentity,
  ProjectMatchCandidate,
  PushBranchOutcome,
  PushBranchPayload,
  PushObservation,
  ScanProjectMatchPayload,
  SourceProjectDescription,
  SuggestDestinationPayload,
  WorktreeForBranch,
} from "../../../shared/types/ipc/projectMatch.js";
import type { DriveLeaseHolder, OperationOutcome } from "../../../shared/types/remoteHosts.js";
import type { BranchCheck } from "../../../shared/types/ipc/hostSwitch.js";
import type { Project } from "../../../shared/types/project.js";
import { formatErrorMessage } from "../../../shared/utils/errorMessage.js";
import { classifyGitError } from "../../../shared/utils/gitOperationErrors.js";
import {
  isSupportedCloneUrl,
  normalizeGitRemoteUrl,
  repositoryNameFromRemote,
  stripRemoteListCredentials,
} from "../../../shared/utils/gitRemoteUrl.js";
import { safeRecipeFilename } from "../../../shared/utils/recipeFilename.js";
import { scrubSecrets } from "../../../shared/utils/secretScrubber.js";
import { validateBranchName } from "../../../shared/utils/pathPattern.js";
import { AppError, GitOperationError } from "../../utils/errorTypes.js";
import { LOCAL_CLIENT_ID } from "../../ipc/endpoint.js";
import { findWorktreeForBranch } from "../../workspace-host/worktreeUtils.js";
import { normalizeOperationId } from "../operations/OperationRegistry.js";
import { readRemoteBranchTip } from "../../utils/remoteBranchTip.js";
import { checkBranchAgainstRemote } from "./branchCheck.js";
import { BundleStore, isBundleToken } from "./bundles.js";
import { checkDestination, suggestDestination } from "./destination.js";
import { refExists, tryRaw } from "./gitOps.js";
import {
  findRegisteredMatches,
  hostProjectsDir,
  listRegisteredRemotes,
  scanForClones,
  scanRoots,
  type RemoteLister,
} from "./matcher.js";
import type { ProjectAcrossHostsDeps } from "./types.js";

const BRANCH_FETCH_TIMEOUT_MS = 15_000;
/** A push that has made no end by then is stuck (a hung credential prompt, a dead link). */
export const PUSH_TIMEOUT_MS = 10 * 60_000;
const MAX_PENDING_SETUPS = 64;
const MAX_PREVIEW_COMMITS = 20;
/** The operation kinds this service starts, and so the only ones it reports or cancels. */
const OWN_OPERATION_KINDS = new Set(["project-clone-and-open", "project-worktree-place"]);

function invalid(message: string): AppError {
  return new AppError({ code: "VALIDATION", message });
}

function requireBranchName(name: unknown, label: string): string {
  if (typeof name !== "string" || !validateBranchName(name).valid) {
    throw invalid(`Invalid ${label}`);
  }
  return name;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof AppError && error.code === "CANCELLED");
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function gitText(error: unknown, fallback: string): string {
  return scrubSecrets(formatErrorMessage(error, fallback));
}

const MAX_RELATIVE_PATH = 1024;

/** A placed worktree as the host accepts it: exact branch names and a relative, bounded path. */
function validatePlacedWorktree(value: unknown): PlacedWorktree {
  const input = (value ?? {}) as Partial<PlacedWorktree>;
  const newBranch = requireBranchName(input.newBranch, "branch");
  const baseBranch = requireBranchName(input.baseBranch, "base branch");
  let relativePath: string | null = null;
  if (input.relativePath !== null && input.relativePath !== undefined) {
    if (
      typeof input.relativePath !== "string" ||
      input.relativePath.length === 0 ||
      input.relativePath.length > MAX_RELATIVE_PATH ||
      input.relativePath.includes("\0") ||
      path.isAbsolute(input.relativePath)
    ) {
      throw invalid("The worktree path must be relative to the project folder");
    }
    relativePath = input.relativePath;
  }
  const recipeId =
    typeof input.recipeId === "string" && input.recipeId.length > 0 && input.recipeId.length <= 256
      ? input.recipeId
      : null;
  return {
    newBranch,
    baseBranch,
    fromRemote: input.fromRemote === true,
    useExistingBranch: input.useExistingBranch === true,
    relativePath,
    recipeId,
  };
}

/**
 * Move a finished clone into place without replacing anything: rename(2)
 * refuses a destination with content in it (and a file or symlink), so only
 * an absent or empty folder — what the free-folder check accepted — is taken.
 */
async function publishClone(staged: string, destination: string): Promise<void> {
  try {
    await fs.rename(staged, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" || code === "EISDIR") {
      const detail = "Something else appeared in this folder during the clone.";
      throw new AppError({ code: "VALIDATION", message: detail, userMessage: detail });
    }
    throw error;
  }
}

/**
 * Who asks to place a worktree, and whether they may change the destination
 * project: it throws to refuse. Required on every placement, so this
 * machine's own windows and a remote Shell's link both go through one.
 */
export interface PlacementAuthority {
  assertMayPlace(projectId: string): void;
}

/**
 * This machine's own windows: one driver among themselves, so they may place
 * into a project nobody holds or this machine holds, never one a remote
 * Shell is driving. With no lease service running (Host mode off) nobody else
 * can be driving it.
 */
export function localPlacementAuthority(
  lease: { getHolder(projectId: string): DriveLeaseHolder | null } | null
): PlacementAuthority {
  return {
    assertMayPlace(projectId) {
      const holder = lease?.getHolder(projectId) ?? null;
      if (holder !== null && holder.clientId !== LOCAL_CLIENT_ID) {
        throw new AppError({
          code: "DRIVEN_ELSEWHERE",
          message: "Another screen drives this project",
          userMessage: `This project is being driven from ${holder.clientName}. Take it over first.`,
          context: { projectId },
        });
      }
    },
  };
}

/**
 * The host side of moving a project between hosts, used for this machine's
 * own projects (when the Shell here is the source or the target) and for a
 * remote Shell's requests over its link alike. Everything that talks to a
 * remote does so with this machine's credentials; nothing here copies a
 * working tree.
 */
export class ProjectAcrossHostsService {
  readonly bundles: BundleStore;
  private readonly pendingSetups = new Map<string, PendingHostSetup>();
  /**
   * Destinations a clone is going into right now, whatever its source: a
   * second clone into one of them is refused rather than racing the first.
   */
  private readonly reservedDestinations = new Set<string>();

  constructor(
    private readonly deps: ProjectAcrossHostsDeps,
    private readonly listRemotes: RemoteLister = listRegisteredRemotes
  ) {
    this.bundles = new BundleStore(() => deps.bundleDir(), deps.now ?? (() => Date.now()));
  }

  private requireProject(projectId: unknown): Project {
    if (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256) {
      throw invalid("projectId is required");
    }
    const project = this.deps.getProject(projectId);
    if (!project) {
      throw new AppError({
        code: "NOT_FOUND",
        message: `No project ${projectId} on this host`,
        userMessage: "This project isn't on this host.",
      });
    }
    return project;
  }

  private async worktreePorcelain(projectPath: string): Promise<string> {
    const git = await this.deps.git.local(projectPath);
    return (await tryRaw(git, ["worktree", "list", "--porcelain"])) ?? "";
  }

  /** `worktreePath` when git lists it as one of the project's working trees, else the project folder. */
  private async resolveWorktree(project: Project, worktreePath: unknown): Promise<string> {
    if (worktreePath === null || worktreePath === undefined) return project.path;
    if (typeof worktreePath !== "string" || !path.isAbsolute(worktreePath)) {
      throw invalid("worktreePath must be an absolute path");
    }
    const wanted = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
    if (wanted === (await fs.realpath(project.path).catch(() => project.path))) return project.path;
    const porcelain = await this.worktreePorcelain(project.path);
    for (const line of porcelain.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      const listed = line.slice("worktree ".length);
      const real = await fs.realpath(listed).catch(() => listed);
      if (real === wanted) return listed;
    }
    throw invalid("worktreePath is not a working tree of this project");
  }

  // Source side

  async describeSource(payload: DescribeSourcePayload): Promise<SourceProjectDescription> {
    const project = this.requireProject(payload?.projectId);
    const worktreePath = await this.resolveWorktree(project, payload.worktreePath);
    const git = await this.deps.git.local(worktreePath);
    const networkGit = await this.deps.git.network(worktreePath);
    const remotes = await this.listRemotes(project.path).catch(() => []);

    const branchResult = await checkBranchAgainstRemote({ git, networkGit, remotes });
    // Everything below leaves this host: never a remote's embedded credentials.
    const shownRemotes = stripRemoteListCredentials(remotes);
    const cloneRemote =
      shownRemotes.find((r) => r.name === branchResult.remote) ??
      shownRemotes.find((r) => r.name === "origin") ??
      (shownRemotes.length === 1 ? shownRemotes[0] : undefined);
    const cloneUrl = cloneRemote?.url ?? null;

    const status = await tryRaw(git, ["status", "--porcelain"]);
    const unpushedCommits = await this.unpushedCommits(git, branchResult.check);
    const submodules = await tryRaw(git, ["submodule", "status"]);
    const hasSubmodules = (submodules ?? "")
      .split("\n")
      .some((line) => line.length > 0 && !line.startsWith("-"));
    const attributes = await fs
      .readFile(path.join(worktreePath, ".gitattributes"), "utf8")
      .catch(() => "");
    const usesLfs = /\bfilter=lfs\b/.test(attributes);

    const tracked = await tryRaw(git, ["ls-files", "--", ".daintree"]);
    const trackedFiles = new Set((tracked ?? "").split("\n").filter(Boolean));
    const recipes = (await this.deps.readInRepoRecipes(project.path).catch(() => []))
      .filter(
        (recipe) =>
          tracked === null ||
          trackedFiles.has(`.daintree/recipes/${safeRecipeFilename(recipe.name)}`)
      )
      .map(({ id, name }) => ({ id, name }));
    const defaultId = await this.deps.defaultRecipeId(project.id).catch(() => null);
    const committedProjectId = trackedFiles.has(".daintree/project.json")
      ? await this.deps.readCommittedProjectId(project.path).catch(() => null)
      : null;

    const home = this.deps.homeDir();
    const relative = path.relative(home, project.path);
    const homeRelativePath =
      relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : null;

    return {
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      worktreePath,
      branch: branchResult.branch,
      branchCheck: branchResult.check,
      remoteBranch: branchResult.remoteBranch,
      remote: branchResult.remote,
      cloneUrl,
      hasUncommittedChanges: (status ?? "").trim().length > 0,
      unpushedCommits,
      remotes: shownRemotes,
      committedProjectId,
      homeRelativePath,
      repoName: (cloneUrl && repositoryNameFromRemote(cloneUrl)) || path.basename(project.path),
      usesLfs,
      hasSubmodules,
      recipes,
      defaultRecipeId: defaultId && recipes.some((r) => r.id === defaultId) ? defaultId : null,
    };
  }

  /**
   * What another host matches this project by: its remotes (never their
   * embedded credentials) and a committed project id when one is tracked.
   * Cheap and offline, unlike {@link describeSource}: no remote is asked.
   */
  async identify(payload: IdentifyProjectPayload): Promise<ProjectIdentity> {
    const project = this.requireProject(payload?.projectId);
    const remotes = stripRemoteListCredentials(
      await this.listRemotes(project.path).catch(() => [])
    );
    const git = await this.deps.git.local(project.path);
    const tracked = await tryRaw(git, ["ls-files", "--", ".daintree/project.json"]);
    const committedProjectId =
      (tracked ?? "").trim().length > 0
        ? await this.deps.readCommittedProjectId(project.path).catch(() => null)
        : null;
    return { remotes, committedProjectId };
  }

  /** What a push of the checked-out branch would publish, for the confirmation to show. */
  private async unpushedCommits(
    git: Awaited<ReturnType<ProjectAcrossHostsDeps["git"]["local"]>>,
    check: BranchCheck
  ): Promise<Array<{ sha: string; subject: string }>> {
    let range: string[];
    if (check.kind === "ahead" || check.kind === "diverged") {
      const upstream = (
        await tryRaw(git, ["rev-parse", "--verify", "--quiet", "@{upstream}"])
      )?.trim();
      range = upstream ? [`${upstream}..HEAD`] : ["HEAD", "--not", "--remotes"];
    } else if (check.kind === "not-on-remote") {
      range = ["HEAD", "--not", "--remotes"];
    } else {
      return [];
    }
    const out = await tryRaw(git, [
      "log",
      `--max-count=${MAX_PREVIEW_COMMITS}`,
      "--format=%h%x09%s",
      ...range,
      "--",
    ]);
    return (out ?? "")
      .split("\n")
      .filter((line) => line.includes("\t"))
      .map((line) => {
        const tab = line.indexOf("\t");
        return { sha: line.slice(0, tab), subject: line.slice(tab + 1).slice(0, 1024) };
      });
  }

  /**
   * Push the branch with this host's credentials and make the remote branch
   * its upstream. `signal` cancels it (the git child is killed and the push
   * throws CANCELLED); a push that runs past {@link PUSH_TIMEOUT_MS} is
   * killed the same way and reported as timed out.
   */
  async pushBranch(
    payload: PushBranchPayload,
    signal?: AbortSignal,
    timeoutMs: number = PUSH_TIMEOUT_MS
  ): Promise<PushBranchOutcome> {
    const project = this.requireProject(payload?.projectId);
    const worktreePath = await this.resolveWorktree(project, payload.worktreePath);
    const branch = requireBranchName(payload.branch, "branch");
    const remoteBranch = requireBranchName(payload.remoteBranch, "remote branch");
    const remotes = await this.listRemotes(project.path).catch(() => []);
    if (!remotes.some((r) => r.name === payload.remote)) throw invalid("Unknown remote");
    if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const git = await this.deps.git.network(worktreePath, combined);
    try {
      await git.raw([
        "push",
        "--set-upstream",
        payload.remote,
        `refs/heads/${branch}:refs/heads/${remoteBranch}`,
      ]);
      return { ok: true };
    } catch (error) {
      if (signal?.aborted) throw new AppError({ code: "CANCELLED", message: "Push cancelled" });
      if (timeout.aborted) {
        return {
          ok: false,
          reason: "timeout",
          message: "git push took too long and was stopped.",
        };
      }
      return {
        ok: false,
        reason: classifyGitError(error),
        message: gitText(error, "git push failed"),
      };
    }
  }

  /**
   * Look at where a push left things, for a push whose outcome was lost with
   * the link: this branch's tip here, and the remote branch's tip as the
   * remote itself reports it. Reads only; it pushes nothing.
   */
  async observePush(payload: PushBranchPayload): Promise<PushObservation> {
    const project = this.requireProject(payload?.projectId);
    const worktreePath = await this.resolveWorktree(project, payload.worktreePath);
    const branch = requireBranchName(payload.branch, "branch");
    const remoteBranch = requireBranchName(payload.remoteBranch, "remote branch");
    const remotes = await this.listRemotes(project.path).catch(() => []);
    if (!remotes.some((r) => r.name === payload.remote)) throw invalid("Unknown remote");
    const git = await this.deps.git.local(worktreePath);
    const local = await tryRaw(git, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ]);
    const networkGit = await this.deps.git.network(worktreePath);
    const tip = await readRemoteBranchTip(networkGit, payload.remote, remoteBranch);
    return {
      localSha: local?.trim() || null,
      remoteSha: tip ?? null,
      remoteReachable: tip !== undefined,
    };
  }

  // Target side

  async environment(): Promise<HostCloneEnvironment> {
    return {
      homeDir: this.deps.homeDir(),
      projectsDir: await hostProjectsDir(this.deps),
      gitLfsAvailable: await this.deps.probeGitLfs().catch(() => false),
    };
  }

  find(payload: FindProjectMatchPayload): Promise<ProjectMatchCandidate[]> {
    return findRegisteredMatches(
      {
        remoteUrls: Array.isArray(payload?.remoteUrls) ? payload.remoteUrls : [],
        committedProjectId:
          typeof payload?.committedProjectId === "string" ? payload.committedProjectId : null,
      },
      this.deps,
      this.listRemotes
    );
  }

  async scan(payload: ScanProjectMatchPayload): Promise<ProjectMatchCandidate[]> {
    const remoteUrls = Array.isArray(payload?.remoteUrls) ? payload.remoteUrls : [];
    const registered = new Set(this.deps.listProjects().map((p) => path.resolve(p.path)));
    return scanForClones(remoteUrls, await scanRoots(this.deps), registered);
  }

  /**
   * Registered matches; when none shares a remote, unregistered clones found
   * on disk follow them (a committed-id-only candidate never rules out a
   * clone that is the same repository by its remotes).
   */
  async match(payload: FindProjectMatchPayload): Promise<ProjectMatchCandidate[]> {
    const registered = await this.find(payload);
    if (registered.some((c) => c.matchedBy === "remote-url")) return registered;
    return [...registered, ...(await this.scan({ remoteUrls: payload.remoteUrls }))];
  }

  checkDestination(payload: CheckDestinationPayload): Promise<DestinationCheck> {
    return checkDestination(
      payload?.path,
      Array.isArray(payload?.remoteUrls) ? payload.remoteUrls : []
    );
  }

  async suggestDestination(payload: SuggestDestinationPayload): Promise<DestinationCheck> {
    return suggestDestination({
      homeDir: this.deps.homeDir(),
      projectsDir: await hostProjectsDir(this.deps),
      homeRelativePath: payload?.homeRelativePath ?? null,
      repoName: payload.repoName,
      remoteUrls: Array.isArray(payload?.remoteUrls) ? payload.remoteUrls : [],
    });
  }

  async findWorktreeForBranch(payload: FindWorktreeForBranchPayload): Promise<WorktreeForBranch> {
    const project = this.requireProject(payload?.projectId);
    const branch = requireBranchName(payload.branch, "branch");
    return {
      worktreePath: findWorktreeForBranch(await this.worktreePorcelain(project.path), branch),
    };
  }

  /**
   * Clone, register and (optionally) give the branch a working tree, as one
   * operation: its own id, progress and cancel, a retained outcome for a
   * Shell whose link dropped, and a second request for the same repository
   * into the same folder joins the first instead of cloning twice. A failure
   * throws: the operation's error carries git's reason as its code and git's
   * own text as its message.
   */
  cloneAndOpen(payload: CloneAndOpenPayload): Promise<CloneAndOpenOutcome> {
    const opId = normalizeOperationId(payload?.opId);
    if (!opId) throw invalid("Invalid operation id");
    if (typeof payload.destination !== "string" || !path.isAbsolute(payload.destination)) {
      throw invalid("destination must be an absolute path");
    }
    const destination = path.resolve(payload.destination);
    const source = payload.source;
    let sourceKey: string;
    if (source?.kind === "remote") {
      if (typeof source.url !== "string" || !isSupportedCloneUrl(source.url.trim())) {
        throw invalid("Only HTTP(S) and SSH remotes can be cloned");
      }
      sourceKey = normalizeGitRemoteUrl(source.url) ?? source.url.trim();
    } else if (source?.kind === "bundle" && isBundleToken(source.token)) {
      sourceKey = `bundle:${source.token}`;
    } else {
      throw invalid("Invalid clone source");
    }
    if (payload.branch) {
      requireBranchName(payload.branch.name, "branch");
      requireBranchName(payload.branch.remoteBranch, "remote branch");
    }
    const depth = payload.options?.depth ?? "full";
    if (depth !== "full" && depth !== "shallow" && depth !== "partial") {
      throw invalid("Invalid clone depth");
    }
    const submodules = payload.options?.submodules === true;

    return this.deps.operations().run(
      {
        opId,
        kind: "project-clone-and-open",
        projectId: null,
        dedupKey: `project-clone-and-open:${sourceKey}\0${destination}`,
        // Everything the result depends on: a joiner that asked for another
        // branch or setup is refused rather than handed the first caller's.
        fingerprint: JSON.stringify({
          sourceKey,
          destination,
          depth,
          submodules,
          branch: payload.branch ?? null,
          setupRecipeId: payload.setupRecipeId ?? null,
        }),
      },
      (op) => {
        // Cancellable from the moment it starts: the clone reads op.signal.
        op.onCancel(() => {});
        // Reserved before anything awaits, so two clones can't both pass the free-folder check.
        if (this.reservedDestinations.has(destination)) {
          const detail = "Another clone is already going into this folder.";
          return Promise.reject(
            new AppError({ code: "VALIDATION", message: detail, userMessage: detail })
          );
        }
        this.reservedDestinations.add(destination);
        return this.runCloneAndOpen(payload, destination, { depth, submodules }, op).finally(() => {
          this.reservedDestinations.delete(destination);
        });
      }
    );
  }

  private async runCloneAndOpen(
    payload: CloneAndOpenPayload,
    destination: string,
    options: { depth: "full" | "shallow" | "partial"; submodules: boolean },
    op: {
      signal: AbortSignal;
      progress(update: {
        fraction: number | null;
        stage: string | null;
        message: string | null;
      }): void;
    }
  ): Promise<CloneAndOpenOutcome> {
    const source = payload.source;
    const bundle = source.kind === "bundle" ? this.bundles.get(source.token) : null;
    // The clone is made here, next to the destination, and only moved into
    // place once complete; a failure removes this folder and nothing else.
    let staging: string | null = null;
    try {
      if (source.kind === "bundle" && !bundle) {
        throw new AppError({
          code: "NOT_FOUND",
          message: "The repository copy never arrived.",
          userMessage: "The repository copy never arrived.",
        });
      }
      const remoteUrls = source.kind === "remote" ? [source.url] : [];
      const check = await checkDestination(destination, remoteUrls);
      if (check.status !== "free") {
        const detail = check.detail ?? "That folder can't take the clone.";
        throw new AppError({ code: "VALIDATION", message: detail, userMessage: detail });
      }
      const parent = path.dirname(destination);
      const folderName = path.basename(destination);
      await fs.mkdir(parent, { recursive: true });
      staging = await fs.mkdtemp(path.join(parent, `.${folderName}.daintree-clone-`));
      const stagedRepo = path.join(staging, folderName);

      op.progress({ fraction: 0, stage: "cloning", message: "Cloning" });
      try {
        if (source.kind === "remote") {
          await this.deps.clone({
            url: source.url.trim(),
            parentPath: staging,
            folderName,
            targetPath: stagedRepo,
            depth: options.depth,
            recurseSubmodules: options.submodules,
            signal: op.signal,
            onProgress: (stage, progress, message) =>
              op.progress({ fraction: progress / 100, stage, message }),
          });
        } else {
          await this.cloneFromBundle(bundle!.path, stagedRepo, op.signal);
        }
      } catch (error) {
        if (isCancellation(error, op.signal) || error instanceof GitOperationError) throw error;
        // The operation records the reason as its error code and git's text as its message.
        throw new GitOperationError(classifyGitError(error), gitText(error, "Clone failed"), {
          op: "clone",
        });
      }

      if (op.signal.aborted) throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
      await publishClone(stagedRepo, destination);
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      staging = null;
      if (source.kind === "remote" && options.depth === "shallow" && payload.branch) {
        // A shallow clone carries only the default branch; fetch the one asked for.
        const networkGit = await this.deps.git.network(destination);
        const ref = payload.branch.remoteBranch;
        await tryRaw(networkGit, [
          "fetch",
          "--depth",
          "1",
          "--no-tags",
          "--quiet",
          "--",
          "origin",
          `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
        ]);
      }

      // Past this point the project exists on the host; a late cancel no longer undoes it.
      op.progress({ fraction: null, stage: "registering", message: "Adding the project" });
      const project = await this.deps.registerProject(destination);

      let branchResult: Pick<
        HostProjectOpened,
        "worktreePath" | "canCheckOutBranch" | "branchNote"
      > = { worktreePath: null, canCheckOutBranch: false, branchNote: null };
      if (payload.branch) {
        op.progress({ fraction: null, stage: "worktree", message: "Creating the worktree" });
        branchResult = await this.ensureBranchWorktree(
          project,
          payload.branch,
          source.kind === "remote" ? "origin" : null
        );
      }

      let setupRecipeId: string | null = null;
      if (payload.setupRecipeId) {
        const recipes = await this.deps.readInRepoRecipes(project.path).catch(() => []);
        if (recipes.some((r) => r.id === payload.setupRecipeId)) {
          setupRecipeId = payload.setupRecipeId;
          this.rememberSetup({
            projectId: project.id,
            recipeId: setupRecipeId,
            worktreePath: branchResult.worktreePath,
          });
        }
      }

      return {
        ok: true,
        projectId: project.id,
        projectPath: project.path,
        projectName: project.name,
        ...branchResult,
        setupRecipeId,
      };
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      if (bundle) await this.bundles.discard(bundle.token);
    }
  }

  /**
   * Clone a bundle, keep every branch it carried as a local branch, then drop
   * `origin`: it names the bundle file, which is deleted straight after.
   * `destination` is the operation's staging folder, which the caller removes on failure.
   */
  private async cloneFromBundle(
    bundlePath: string,
    destination: string,
    signal: AbortSignal
  ): Promise<void> {
    const parentGit = await this.deps.git.local(path.dirname(destination));
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
    await parentGit.raw(["clone", "--quiet", "--", bundlePath, destination]);
    const repo = await this.deps.git.local(destination);
    const current = (
      (await tryRaw(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"])) ?? ""
    ).trim();
    const refs = (
      (await tryRaw(repo, [
        "for-each-ref",
        "--format=%(refname:strip=3)",
        "refs/remotes/origin",
      ])) ?? ""
    )
      .split("\n")
      .map((ref) => ref.trim())
      .filter((ref) => ref.length > 0 && ref !== "HEAD" && ref !== current);
    for (const ref of refs) {
      await repo.raw(["branch", "--no-track", ref, `refs/remotes/origin/${ref}`]);
      if (!(await refExists(repo, `refs/heads/${ref}`))) {
        throw new Error(`Couldn't keep branch ${ref} from the repository copy`);
      }
    }
    await repo.raw(["remote", "remove", "origin"]);
    if (signal.aborted) throw new AppError({ code: "CANCELLED", message: "Clone cancelled" });
  }

  /**
   * A working tree for `target`: the one that already has it checked out
   * (never a suffixed duplicate), else a new one — reusing a local branch of
   * that name, or created from `remoteName`'s copy with the exact name.
   */
  private async ensureBranchWorktree(
    project: Project,
    target: HostBranchTarget,
    remoteName: string | null
  ): Promise<Pick<HostProjectOpened, "worktreePath" | "canCheckOutBranch" | "branchNote">> {
    const existing = findWorktreeForBranch(await this.worktreePorcelain(project.path), target.name);
    if (existing) {
      await this.deps.focusWorktree(project.id, existing).catch(() => {});
      return { worktreePath: existing, canCheckOutBranch: false, branchNote: null };
    }
    const git = await this.deps.git.local(project.path);
    const hasLocal = await refExists(git, `refs/heads/${target.name}`);
    const remoteRef = remoteName ? `${remoteName}/${target.remoteBranch}` : null;
    const hasRemote = remoteRef !== null && (await refExists(git, `refs/remotes/${remoteRef}`));
    if (!hasLocal && !hasRemote) {
      return {
        worktreePath: null,
        canCheckOutBranch: false,
        branchNote: remoteName
          ? `${target.remoteBranch} isn't on ${remoteName} from this host.`
          : `${target.name} isn't in this repository.`,
      };
    }
    if (hasLocal && hasRemote) {
      const localTip = (await tryRaw(git, ["rev-parse", `refs/heads/${target.name}`]))?.trim();
      const remoteTip = (await tryRaw(git, ["rev-parse", `refs/remotes/${remoteRef}`]))?.trim();
      if (!localTip || localTip !== remoteTip) {
        // Opening this host's own branch as "the remote's version" would be a
        // lie; leave the choice to someone looking at it here.
        return {
          worktreePath: null,
          canCheckOutBranch: false,
          branchNote: `${target.name} on this host isn't at ${remoteRef}'s commit, so it wasn't checked out.`,
        };
      }
    }
    try {
      const worktreePath = await this.deps.worktreePathFor(project.path, target.name);
      const created = await this.deps.createWorktree(
        project.path,
        hasLocal
          ? {
              baseBranch: target.name,
              newBranch: target.name,
              path: worktreePath,
              useExistingBranch: true,
            }
          : {
              baseBranch: remoteRef!,
              newBranch: target.name,
              path: worktreePath,
              fromRemote: true,
              collisionPolicy: "error",
            }
      );
      await this.deps.focusWorktree(project.id, created.worktreeId).catch(() => {});
      return { worktreePath: created.worktreeId, canCheckOutBranch: false, branchNote: null };
    } catch (error) {
      return {
        worktreePath: null,
        canCheckOutBranch: false,
        branchNote: gitText(error, "The worktree couldn't be created."),
      };
    }
  }

  /** This host's remote that is the source's remote for the branch, else origin, else its only one. */
  private async matchingRemote(
    projectPath: string,
    branchRemoteUrl: string | null
  ): Promise<string | null> {
    const remotes = await this.listRemotes(projectPath).catch(() => []);
    const wanted = branchRemoteUrl ? normalizeGitRemoteUrl(branchRemoteUrl) : null;
    if (wanted) {
      const same = remotes.find((r) => normalizeGitRemoteUrl(r.url) === wanted);
      if (same) return same.name;
    }
    if (remotes.some((r) => r.name === "origin")) return "origin";
    return remotes.length === 1 ? remotes[0]!.name : null;
  }

  /**
   * The project `payload` names, or the unregistered clone at its path,
   * registered here. A folder is adopted only once this host has checked it
   * for itself: a real directory at the top of its own git repository (not a
   * subfolder, a linked worktree or a symlink to somewhere else), whose
   * remotes share one with the repository being opened. Where the Shell
   * found it — this host's scan or a person with the picker — doesn't matter.
   */
  private async adoptCandidate(payload: OpenOnHostPayload): Promise<Project> {
    if (payload.projectId) return this.requireProject(payload.projectId);
    if (typeof payload.path !== "string" || !path.isAbsolute(payload.path)) {
      throw invalid("path must be an absolute path");
    }
    const resolved = path.resolve(payload.path);
    const known = this.deps.listProjects().find((p) => path.resolve(p.path) === resolved);
    if (known) return known;
    const refuse = (detail: string): AppError =>
      new AppError({ code: "VALIDATION", message: detail, userMessage: detail });
    const stat = await fs.lstat(resolved).catch(() => null);
    if (!stat?.isDirectory()) throw refuse("That folder isn't there on this host.");
    const gitDir = await fs.lstat(path.join(resolved, ".git")).catch(() => null);
    if (!gitDir?.isDirectory()) throw refuse("That folder isn't a git repository's main folder.");
    const real = await fs.realpath(resolved).catch(() => null);
    const git = await this.deps.git.local(resolved);
    const topLevel = (await tryRaw(git, ["rev-parse", "--show-toplevel"]))?.trim() ?? null;
    const realTop = topLevel ? await fs.realpath(topLevel).catch(() => null) : null;
    if (real === null || realTop !== real) {
      throw refuse("That folder isn't a git repository's main folder.");
    }
    const remoteUrls = Array.isArray(payload.remoteUrls) ? payload.remoteUrls : [];
    const check = await checkDestination(resolved, remoteUrls);
    if (check.status !== "same-repository") {
      throw new AppError({
        code: "VALIDATION",
        message: "The folder is not a clone of this repository",
        userMessage: "That folder isn't a clone of this repository.",
      });
    }
    return this.deps.registerProject(resolved);
  }

  /**
   * Open a project this host has: refresh it from its remote in the
   * background, and find the branch's working tree or say whether the branch
   * can be checked out here.
   */
  async open(payload: OpenOnHostPayload): Promise<HostProjectOpened> {
    const project = await this.adoptCandidate(payload);
    const remoteName = await this.matchingRemote(project.path, payload.branchRemoteUrl ?? null);
    const base = {
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      setupRecipeId: null,
    };
    if (remoteName) this.backgroundFetch(project.path, remoteName);

    if (!payload.branch) {
      return { ...base, worktreePath: null, canCheckOutBranch: false, branchNote: null };
    }
    const target = payload.branch;
    requireBranchName(target.name, "branch");
    requireBranchName(target.remoteBranch, "remote branch");
    const existing = findWorktreeForBranch(await this.worktreePorcelain(project.path), target.name);
    if (existing) {
      await this.deps.focusWorktree(project.id, existing).catch(() => {});
      return { ...base, worktreePath: existing, canCheckOutBranch: false, branchNote: null };
    }
    if (!remoteName) {
      return {
        ...base,
        worktreePath: null,
        canCheckOutBranch: false,
        branchNote: "This copy has no remote to fetch the branch from.",
      };
    }
    // `worktree:fetch-pr-branch` only fetches forge PR refs; a pushed branch is a plain fetch.
    const networkGit = await this.deps.git.network(project.path);
    let branchNote: string | null = null;
    let fetched = false;
    try {
      await withTimeout(
        networkGit.raw([
          "fetch",
          "--no-tags",
          "--quiet",
          "--",
          remoteName,
          `+refs/heads/${target.remoteBranch}:refs/remotes/${remoteName}/${target.remoteBranch}`,
        ]),
        BRANCH_FETCH_TIMEOUT_MS
      );
      fetched = true;
    } catch (error) {
      branchNote = gitText(error, `Couldn't fetch ${target.remoteBranch} from ${remoteName}.`);
    }
    // A tracking ref left from an earlier fetch may be stale or deleted upstream.
    const git = await this.deps.git.local(project.path);
    const onRemote =
      fetched && (await refExists(git, `refs/remotes/${remoteName}/${target.remoteBranch}`));
    return {
      ...base,
      worktreePath: null,
      canCheckOutBranch: onRemote,
      branchNote: onRemote
        ? null
        : (branchNote ?? `${target.remoteBranch} isn't on ${remoteName}.`),
    };
  }

  /** "Check out <branch> here": the exact branch, from this host's copy of the remote. */
  async checkOut(payload: CheckOutBranchPayload): Promise<HostProjectOpened> {
    const project = this.requireProject(payload?.projectId);
    requireBranchName(payload.branch?.name, "branch");
    requireBranchName(payload.branch?.remoteBranch, "remote branch");
    const remoteName = await this.matchingRemote(project.path, payload.branchRemoteUrl ?? null);
    const result = await this.ensureBranchWorktree(project, payload.branch, remoteName);
    return {
      projectId: project.id,
      projectPath: project.path,
      projectName: project.name,
      setupRecipeId: null,
      ...result,
    };
  }

  private backgroundFetch(projectPath: string, remoteName: string): void {
    void (async () => {
      const git = await this.deps.git.network(projectPath);
      await git.raw(["fetch", "--quiet", "--", remoteName]);
    })().catch((error: unknown) => {
      console.warn(
        "[projectAcrossHosts] Background fetch failed:",
        gitText(error, "git fetch failed")
      );
    });
  }

  /**
   * Create the worktree another host's new-worktree dialog asked for, as one
   * operation with its own id and a retained outcome, so a Shell whose link
   * dropped learns how it ended instead of asking twice. A worktree that
   * already has the branch checked out is reused, never suffixed. Refused
   * before anything is recorded unless `authority` lets the asker change the
   * project.
   */
  placeWorktree(
    payload: PlaceWorktreePayload,
    authority: PlacementAuthority
  ): Promise<CloneAndOpenOutcome> {
    const opId = normalizeOperationId(payload?.opId);
    if (!opId) throw invalid("Invalid operation id");
    const project = this.requireProject(payload.projectId);
    // Placing changes the project (a worktree, and its saved active worktree),
    // so whoever asks must be allowed to drive it, whichever side asked.
    authority.assertMayPlace(project.id);
    const worktree = validatePlacedWorktree(payload.worktree);
    return this.deps.operations().run(
      {
        opId,
        kind: "project-worktree-place",
        projectId: project.id,
        dedupKey: `project-worktree-place:${project.id}\0${worktree.newBranch}`,
        fingerprint: JSON.stringify({ projectId: project.id, worktree }),
      },
      (op) => {
        op.onCancel(() => {});
        return this.runPlaceWorktree(project, worktree, op);
      }
    );
  }

  private async runPlaceWorktree(
    project: Project,
    worktree: PlacedWorktree,
    op: {
      signal: AbortSignal;
      progress(update: {
        fraction: number | null;
        stage: string | null;
        message: string | null;
      }): void;
    }
  ): Promise<CloneAndOpenOutcome> {
    const base = { projectId: project.id, projectPath: project.path, projectName: project.name };
    const existing = findWorktreeForBranch(
      await this.worktreePorcelain(project.path),
      worktree.newBranch
    );
    let worktreePath: string;
    if (existing) {
      worktreePath = existing;
    } else {
      const target = worktree.relativePath
        ? path.resolve(project.path, worktree.relativePath)
        : await this.deps.worktreePathFor(project.path, worktree.newBranch);
      const inside = path.relative(project.path, target);
      if (inside === "" || inside === ".git" || inside.startsWith(`.git${path.sep}`)) {
        throw invalid("The worktree can't go inside the project's git folder");
      }
      const occupied = await fs
        .readdir(target)
        .then((entries) => entries.length > 0)
        .catch((error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      if (occupied) {
        const detail = `Something is already at ${target} on this host.`;
        throw new AppError({ code: "VALIDATION", message: detail, userMessage: detail });
      }
      if (op.signal.aborted) throw new AppError({ code: "CANCELLED", message: "Cancelled" });
      op.progress({ fraction: null, stage: "worktree", message: "Creating the worktree" });
      try {
        const created = await this.deps.createWorktree(project.path, {
          baseBranch: worktree.baseBranch,
          newBranch: worktree.newBranch,
          path: target,
          fromRemote: worktree.useExistingBranch ? false : worktree.fromRemote,
          useExistingBranch: worktree.useExistingBranch,
          collisionPolicy: "error",
        });
        worktreePath = created.worktreeId;
      } catch (error) {
        if (error instanceof GitOperationError || error instanceof AppError) throw error;
        throw new GitOperationError(
          classifyGitError(error),
          gitText(error, "The worktree couldn't be created."),
          { op: "worktree" }
        );
      }
    }
    await this.deps.focusWorktree(project.id, worktreePath).catch(() => {});

    let setupRecipeId: string | null = null;
    if (worktree.recipeId) {
      const recipes = await this.deps.readInRepoRecipes(project.path).catch(() => []);
      if (recipes.some((r) => r.id === worktree.recipeId)) {
        setupRecipeId = worktree.recipeId;
        this.rememberSetup({ projectId: project.id, recipeId: setupRecipeId, worktreePath });
      }
    }
    return {
      ok: true,
      ...base,
      worktreePath,
      canCheckOutBranch: false,
      branchNote:
        worktree.recipeId && !setupRecipeId
          ? "The setup recipe isn't in this host's copy of the repository, so it won't run."
          : null,
      setupRecipeId,
    };
  }

  // Operations

  operationStatus(opId: string): OperationOutcome {
    const id = normalizeOperationId(opId);
    if (!id) throw invalid("Invalid operation id");
    const record = this.deps.operations().get(id);
    return record && OWN_OPERATION_KINDS.has(record.kind) ? record.outcome : { status: "unknown" };
  }

  cancelOperation(opId: string): boolean {
    const id = normalizeOperationId(opId);
    if (!id) throw invalid("Invalid operation id");
    const record = this.deps.operations().get(id);
    if (!record || !OWN_OPERATION_KINDS.has(record.kind)) return false;
    return this.deps.operations().cancel(id);
  }

  // Bundles

  async createBundle(payload: {
    projectId: string;
  }): Promise<{ token: string; path: string; size: number }> {
    const project = this.requireProject(payload?.projectId);
    const entry = await this.bundles.create(this.deps.git, project.path);
    return { token: entry.token, path: entry.path, size: entry.size };
  }

  // Setup waiting for the first view

  private rememberSetup(setup: PendingHostSetup): void {
    this.pendingSetups.delete(setup.projectId);
    this.pendingSetups.set(setup.projectId, setup);
    while (this.pendingSetups.size > MAX_PENDING_SETUPS) {
      const oldest = this.pendingSetups.keys().next().value;
      if (oldest === undefined) break;
      this.pendingSetups.delete(oldest);
    }
  }

  /** Hand the setup to the one view that asks first; later views see nothing. */
  takePendingSetup(projectId: string): PendingHostSetup | null {
    if (typeof projectId !== "string") return null;
    const setup = this.pendingSetups.get(projectId) ?? null;
    if (setup) this.pendingSetups.delete(projectId);
    return setup;
  }
}
