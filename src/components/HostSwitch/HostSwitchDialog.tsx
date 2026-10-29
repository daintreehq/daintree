import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { GitBranch, Server } from "lucide-react";
import type {
  HostSwitchExecutePayload,
  HostSwitchExecuteResult,
  HostSwitchPreparation,
  HostSwitchStatus,
} from "@shared/types/ipc/hostSwitch";
import type {
  DestinationCheck,
  HostBranchTarget,
  HostCloneDepth,
} from "@shared/types/ipc/projectMatch";
import { LOCAL_HOST_ID } from "@shared/types/remoteHosts";
import { AppDialog } from "@/components/ui/AppDialog";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { mintOperationId } from "@/clients/operationsClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { clientPlatform, localHostLabel } from "@/components/Hosts/hostModel";
import { useHostList } from "@/components/Hosts/hostList";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { pickHostPaths } from "@/components/HostFilePicker/hostFilePickerQueue";
import { ProjectMatchChooser } from "./ProjectMatchChooser";
import { pluralize } from "@/lib/pluralize";
import {
  cloneableRemotes,
  describeBranchHandoff,
  describeCloneFailure,
  describeCloneSteps,
  describePlacedWorktree,
  describeStepFailure,
  destinationInFolder,
  hostDisplayName,
  initialView,
  opensWithoutQuestion,
  type BranchPlan,
} from "./hostSwitchModel";
import { GitFailureCallout, type HostGitFailure } from "./GitFailureCallout";
import {
  CloneOptions,
  DestinationField,
  FieldHelp,
  folderHint,
  folderStateOf,
  FormRow,
  OperationSteps,
} from "./hostCloneForm";
import { setHostSwitchBusy, type HostSwitchRequest } from "./hostSwitchRequests";

/**
 * Each request's flow, kept outside React so a step finishing late reads it
 * when it lands: `stopped` by Cancel, `closed` once the dialog went away
 * (which nothing in it can undo).
 */
const flows = new Map<number, { stopped: boolean; closed: boolean }>();

function flowOf(requestId: number): { stopped: boolean; closed: boolean } {
  let flow = flows.get(requestId);
  if (!flow) {
    flow = { stopped: false, closed: false };
    flows.set(requestId, flow);
  }
  return flow;
}

/** The flow was cancelled or its dialog closed: nothing more runs for it. */
function flowEnded(requestId: number): boolean {
  const flow = flowOf(requestId);
  return flow.stopped || flow.closed;
}

const STATUS_POLL_MS = 300;
const DESTINATION_CHECK_DELAY_MS = 300;
const NO_RECIPE = "__none__";

type View = "existing" | "clone" | "local-only";

/** Where a failure is shown: beside the decision it's about, or atop the body. */
type FailureSlot = "top" | "destination" | "branch" | "worktree";

interface Failure extends HostGitFailure {
  near: FailureSlot;
  /** The control that goes back to the choice that fixes it. */
  action?: { label: string; run: () => void } | null;
  /** Pressing the primary again would repeat what failed; false once the plan itself changed. */
  retryable?: boolean;
}

/** What the primary repeats after a failure; its label is read from the plan as it stands. */
type Retry =
  | { kind: "clone" }
  | { kind: "bundle" }
  | { kind: "open"; candidate: { projectId: string | null; path: string } }
  | { kind: "create"; opened: Extract<HostSwitchExecuteResult, { kind: "opened" }> }
  | { kind: "checkout" };

interface CheckoutOffer {
  result: Extract<HostSwitchExecuteResult, { kind: "opened" }>;
}

/** One step through the switch service; a failure other than a cancel is shown, not thrown. */
type StepPayload = HostSwitchExecutePayload extends infer P
  ? P extends HostSwitchExecutePayload
    ? Omit<P, "opId">
    : never
  : never;

function runStep(
  opId: string,
  payload: StepPayload,
  onError: (code: string | null, message: string) => void
): Promise<HostSwitchExecuteResult | null> {
  return window.electron.hostSwitch.execute({ ...payload, opId }).catch((error: unknown) => {
    const code = clientErrorCode(error) ?? null;
    if (code !== "CANCELLED") onError(code, clientErrorText(error, "Something went wrong."));
    return null;
  });
}

/** What the source host saw after the link came back, stated as seen. */
export function describePushObservation(
  result: Extract<HostSwitchExecuteResult, { kind: "push-unconfirmed" }>,
  sourceName: string
): string {
  const { observed, branch, remote, remoteBranch } = result;
  const lost = `The link to ${sourceName} dropped during the push.`;
  if (!observed.remoteReachable) {
    return `${lost} ${remote} didn't answer when ${sourceName} checked it afterwards.`;
  }
  const localTip = observed.localSha ? `is at ${observed.localSha.slice(0, 8)}` : `wasn't found`;
  const remoteTip = observed.remoteSha
    ? `is at ${observed.remoteSha.slice(0, 8)}`
    : `doesn't exist on ${remote}`;
  return `${lost} ${remote}/${remoteBranch} ${remoteTip}; ${branch} on ${sourceName} ${localTip}.`;
}

function currentHostId(): string {
  return window.__DAINTREE_HOST_ID__?.id ?? LOCAL_HOST_ID;
}

/**
 * Get the project this window is in onto another host, through git: open the
 * copy the host already has, or clone it there as the host (with the host's
 * own credentials), then give the branch a worktree. Every step that reaches
 * outward — a push, a clone — runs only from a button here.
 */
export function HostSwitchDialog({
  request,
  onClose,
  onComplete,
}: {
  request: HostSwitchRequest;
  onClose: () => void;
  /** The project is open on the host (with its worktree, when one was asked for). */
  onComplete?: () => void;
}) {
  const { hosts } = useHostList();
  const localLabel = localHostLabel(clientPlatform());
  const fromHostId = currentHostId();
  const sourceName = hostDisplayName(fromHostId, hosts, localLabel);
  const targetName = hostDisplayName(request.toHostId, hosts, localLabel);
  const placed = request.worktree ?? null;
  const newWindow = request.newWindow === true;
  const navigateOnly = request.navigateOnly === true && !placed;

  const [prep, setPrep] = useState<HostSwitchPreparation | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<View>("clone");
  const [candidateIndex, setCandidateIndex] = useState(0);
  const [branchPlan, setBranchPlan] = useState<BranchPlan>("worktree");
  const [cloneUrl, setCloneUrl] = useState<string>("");
  const [destination, setDestination] = useState("");
  const [destinationCheck, setDestinationCheck] = useState<DestinationCheck | null>(null);
  // The input the check answered; a check for an earlier input never enables a clone.
  const [checkedInput, setCheckedInput] = useState<string | null>(null);
  // Why the last check couldn't run (the host dropped, say); Retry bumps the attempt.
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  const [submodules, setSubmodules] = useState(false);
  const [depth, setDepth] = useState<HostCloneDepth>("full");
  const [recipeId, setRecipeId] = useState<string>(NO_RECIPE);
  const [running, setRunning] = useState<{ opId: string; label: string; hostName: string } | null>(
    null
  );
  const [status, setStatus] = useState<HostSwitchStatus | null>(null);
  // The step that has run past the "Still working…" threshold.
  const [stillWorkingOp, setStillWorkingOp] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  /** The commit a push in this dialog already published: a retry doesn't push it again. */
  const [pushedSha, setPushedSha] = useState<string | null>(null);
  /** The clone landed but what follows it (the placed worktree) didn't: only that is left. */
  const [landed, setLanded] = useState<Extract<HostSwitchExecuteResult, { kind: "opened" }> | null>(
    null
  );
  const failureRef = useRef<HTMLDivElement>(null);
  const [checkoutOffer, setCheckoutOffer] = useState<CheckoutOffer | null>(null);
  /** Opening without a question was started once; a failure then shows the full dialog. */
  const [autoOpenStarted, setAutoOpenStarted] = useState(false);
  /** That opening is still out; once it settles without closing the dialog, the dialog shows. */
  const [autoOpening, setAutoOpening] = useState(false);
  /** Bumped to look at the source again, after a push found the branch had moved. */
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const showLoading = useDeferredLoading(prep === null && loadError === null, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    let cancelled = false;
    window.electron.hostSwitch
      .prepare({
        fromHostId,
        toHostId: request.toHostId,
        projectId: request.projectId,
        worktreePath: navigateOnly ? null : request.worktreePath,
        ...(navigateOnly ? { navigateOnly: true } : {}),
      })
      .then((prepared) => {
        if (cancelled) return;
        setPrep(prepared);
        const firstView = initialView(prepared);
        setView(firstView);
        // A placed worktree replaces the branch handoff, and going to the copy
        // as it is has none: nothing is pushed for either.
        setBranchPlan(
          placed || navigateOnly
            ? "no-worktree"
            : describeBranchHandoff(prepared, "", firstView === "existing").defaultPlan
        );
        const cloneable = cloneableRemotes(prepared.remotes);
        setCloneUrl(
          cloneable.find((r) => r.url === prepared.cloneUrl)?.url ?? cloneable[0]?.url ?? ""
        );
        setDestination(prepared.destination?.path ?? "");
        setDestinationCheck(prepared.destination);
        setCheckedInput(prepared.destination?.path ?? null);
        setSubmodules(prepared.hasSubmodules);
        // A placed worktree brings the recipe New Worktree chose; otherwise a
        // default from another machine is that machine's say-so: start with none.
        const placedRecipe = placed?.recipeId ?? null;
        setRecipeId(
          placed
            ? placedRecipe && prepared.recipes.some((r) => r.id === placedRecipe)
              ? placedRecipe
              : NO_RECIPE
            : prepared.fromHostId === LOCAL_HOST_ID && prepared.defaultRecipeId
              ? prepared.defaultRecipeId
              : NO_RECIPE
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(clientErrorText(error, "Couldn't look at the project."));
      });
    return () => {
      cancelled = true;
    };
  }, [
    fromHostId,
    request.toHostId,
    request.projectId,
    request.worktreePath,
    placed,
    navigateOnly,
    prepareAttempt,
  ]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      window.electron.hostSwitch
        .status({ opId: running.opId })
        .then(setStatus)
        .catch(() => {});
    }, STATUS_POLL_MS);
    const slow = setTimeout(() => setStillWorkingOp(running.opId), UI_STILL_WORKING_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(slow);
    };
  }, [running]);

  // A failure lands beside its decision, which may be scrolled away.
  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const remoteUrls = useMemo(() => prep?.remotes.map((r) => r.url) ?? [], [prep]);

  useEffect(() => {
    if (!prep || view === "existing") return;
    const target = destination.trim();
    setCheckError(null);
    if (target.length === 0) {
      setDestinationCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.electron.hostSwitch
        .checkDestination({ toHostId: request.toHostId, path: target, remoteUrls })
        .then((check) => {
          if (cancelled) return;
          setDestinationCheck(check);
          setCheckedInput(target);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // An earlier answer no longer vouches for the folder.
          setDestinationCheck(null);
          setCheckedInput(null);
          setCheckError(clientErrorText(error, "The host didn't answer."));
        });
    }, DESTINATION_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, prep, view, remoteUrls, request.toHostId, targetName, checkAttempt]);

  const handoff =
    prep && !navigateOnly && prep.isGitRepository
      ? describeBranchHandoff(prep, sourceName, view === "existing")
      : null;
  const pushing = branchPlan === "push-then-worktree" && prep?.pushDestination != null;
  // Pushing was chosen and hasn't gone through yet: every label that promises a push reads this.
  const needsPush = pushing && (pushedSha === null || pushedSha !== prep?.headSha);
  const pushTarget = prep?.pushDestination
    ? `${prep.pushDestination.remote}/${prep.pushDestination.branch}`
    : null;
  const destinationReady =
    destinationCheck?.status === "free" && checkedInput === destination.trim();
  // Offered only for a repository whose submodules are in use where it comes from.
  const showSubmodules = view === "clone" && prep?.hasSubmodules === true;

  const branchTarget = (): HostBranchTarget | null => {
    if (!prep?.branch || branchPlan === "no-worktree") return null;
    return { name: prep.branch, remoteBranch: prep.remoteBranch ?? prep.branch };
  };

  const branchRemoteUrl = (): string | null => {
    const check = prep?.branchCheck;
    const remoteName = check && "remote" in check ? check.remote : null;
    return prep?.remotes.find((r) => r.name === remoteName)?.url ?? prep?.cloneUrl ?? null;
  };

  /** One step; once the flow was stopped, its result is dropped and nothing follows it. */
  const execute = (
    label: string,
    payload: StepPayload,
    near: FailureSlot
  ): Promise<HostSwitchExecuteResult | null> => {
    const requestId = request.id;
    if (flowEnded(requestId)) return Promise.resolve(null);
    const opId = mintOperationId();
    // Held before the step is sent, so no request replaces the dialog mid-step.
    setHostSwitchBusy(requestId, true);
    setRunning({ opId, label, hostName: payload.kind === "push" ? sourceName : targetName });
    setStatus(null);
    const hostName = payload.kind === "push" ? sourceName : targetName;
    return runStep(opId, payload, (code, message) =>
      setFailure({
        ...describeStepFailure({ label, code, message, hostName }),
        gitText: null,
        near,
      })
    )
      .then((result) => (flowEnded(requestId) ? null : result))
      .finally(() => {
        setHostSwitchBusy(requestId, false);
        setRunning(null);
      });
  };

  /** A new flow, started by the person: an earlier Cancel no longer applies. */
  const startFlow = (next: Retry) => {
    flowOf(request.id).stopped = false;
    setFailure(null);
    setRetry(next);
  };

  const choosePlan = (plan: BranchPlan) => {
    setBranchPlan(plan);
    if (failure?.near === "branch") setFailure(null);
  };

  /** The source-side push the user chose, before anything happens on the target. */
  const pushIfChosen = async (): Promise<boolean> => {
    if (branchPlan !== "push-then-worktree") return true;
    if (pushedSha !== null && pushedSha === prep?.headSha) return true;
    const destination = prep?.pushDestination;
    // Exactly what was shown: this branch, this commit, to where git pushes it.
    if (!prep?.branch || !destination || !prep.headSha) return false;
    const result = await execute(
      `Pushing ${prep.branch} to ${pushTarget}`,
      {
        kind: "push",
        fromHostId,
        projectId: prep.projectId,
        worktreePath: prep.worktreePath,
        branch: prep.branch,
        remote: destination.remote,
        remoteBranch: destination.branch,
        sha: prep.headSha,
      },
      "branch"
    );
    if (
      result?.kind === "git-failed" &&
      (result.reason === "branch-moved" || result.reason === "destination-changed")
    ) {
      setFailure({
        title: `Didn't push ${prep.branch}`,
        fix: `${prep.branch} changed on ${sourceName} after it was shown here. Look over what's there now, then choose again.`,
        gitText: result.message,
        near: "branch",
        retryable: false,
      });
      setPrep(null);
      // What comes back is looked at again by the person, never opened unasked.
      setAutoOpenStarted(true);
      setPrepareAttempt((n) => n + 1);
      return false;
    }
    if (result?.kind === "git-failed") {
      setFailure({
        title: `Couldn't push ${prep.branch} from ${sourceName}`,
        fix: `${destination.remote} refused the push. Sort it out on ${sourceName} and retry, or pick the choice above that doesn't push.`,
        gitText: result.message,
        near: "branch",
      });
      return false;
    }
    if (result?.kind === "push-unconfirmed") {
      setFailure({
        title: `Couldn't confirm the push of ${prep.branch} from ${sourceName}`,
        fix: `Check ${pushTarget} before pushing again, or pick the choice above that doesn't push.`,
        detail: describePushObservation(result, sourceName),
        gitText: null,
        near: "branch",
      });
      return false;
    }
    if (result?.kind !== "pushed") return false;
    setPushedSha(prep.headSha);
    return true;
  };

  /** `note` is what the host said it didn't do, shown in the view the switch lands in. */
  const finish = (
    result: Extract<HostSwitchExecuteResult, { kind: "opened" }>,
    note: string | null = null
  ) => {
    if (flowEnded(request.id)) return;
    if (onComplete) onComplete();
    else onClose();
    if (note) {
      void switchToHost(result.hostId, newWindow, result.projectId, {
        focusIntent: { intent: "placement-note", note },
      });
      return;
    }
    void switchToHost(result.hostId, newWindow, result.projectId);
  };

  /** The new-worktree dialog's worktree, created in the project now open on the host. */
  const createPlacedWorktree = async (
    opened: Extract<HostSwitchExecuteResult, { kind: "opened" }>
  ) => {
    if (!placed) return;
    // The project is on the host now: a retry creates the worktree, never clones again.
    setLanded(opened);
    setRetry({ kind: "create", opened });
    // The Setup row is where the recipe is chosen once it shows; elsewhere New Worktree's stands.
    const choosesRecipe = view !== "existing" && (prep?.recipes.length ?? 0) > 0;
    const result = await execute(
      `Creating ${placed.newBranch}`,
      {
        kind: "create-worktree",
        toHostId: request.toHostId,
        projectId: opened.projectId,
        worktree: choosesRecipe
          ? { ...placed, recipeId: recipeId === NO_RECIPE ? null : recipeId }
          : placed,
      },
      "worktree"
    );
    if (!result) return;
    if (result.kind === "git-failed") {
      setFailure({
        title: `Couldn't create ${placed.newBranch} on ${targetName}`,
        fix: `${opened.projectName} is on ${targetName} now. Retry, or open it there without the worktree.`,
        gitText: result.message,
        near: "worktree",
        action: { label: "Open without it", run: () => finish(opened) },
      });
      return;
    }
    // The worktree is there either way; a recipe the host's copy lacks is said there.
    if (result.kind === "opened") finish(result, result.branchNote);
  };

  const handleOpened = (result: HostSwitchExecuteResult | null) => {
    if (!result) return;
    if (result.kind === "git-failed") {
      setFailure(
        result.step === "push"
          ? {
              title: `Couldn't push from ${sourceName}`,
              fix: `Sort it out on ${sourceName} and retry, or pick the choice above that doesn't push.`,
              gitText: result.message,
              near: "branch",
            }
          : {
              ...describeCloneFailure({
                reason: result.reason,
                message: result.message,
                hostName: targetName,
                url: view === "local-only" ? null : cloneUrl,
              }),
              near: "destination",
            }
      );
      return;
    }
    if (result.kind !== "opened") return;
    if (placed) {
      void createPlacedWorktree(result);
      return;
    }
    if (!result.worktreePath && branchTarget() && (result.canCheckOutBranch || result.branchNote)) {
      setCheckoutOffer({ result });
      return;
    }
    finish(result);
  };

  const clone = async (source: "remote" | "bundle") => {
    if (!destinationReady || !prep || !destinationCheck) return;
    startFlow({ kind: source === "bundle" ? "bundle" : "clone" });
    if (!(await pushIfChosen())) return;
    const result = await execute(
      source === "bundle" ? "Sending a copy" : "Cloning",
      {
        kind: "clone",
        fromHostId,
        toHostId: request.toHostId,
        projectId: prep.projectId,
        source: source === "bundle" ? { kind: "bundle" } : { kind: "remote", url: cloneUrl },
        destination: destinationCheck.path,
        branch: branchTarget(),
        options: { submodules: source === "remote" && showSubmodules && submodules, depth },
        // A placed worktree carries the recipe itself, so the project's setup isn't asked twice.
        setupRecipeId: placed || recipeId === NO_RECIPE ? null : recipeId,
      },
      "destination"
    );
    handleOpened(result);
  };

  const openCandidate = async (candidate: { projectId: string | null; path: string }) => {
    if (!prep) return;
    startFlow({ kind: "open", candidate });
    if (!(await pushIfChosen())) return;
    const result = await execute(
      "Opening",
      {
        kind: "open",
        toHostId: request.toHostId,
        candidate,
        remoteUrls,
        branch: branchTarget(),
        branchRemoteUrl: branchRemoteUrl(),
        ...(navigateOnly ? { navigateOnly: true } : {}),
      },
      "destination"
    );
    handleOpened(result);
  };

  const openExisting = async () => {
    const candidate = prep?.candidates[candidateIndex];
    if (!candidate) return;
    await openCandidate({ projectId: candidate.projectId, path: candidate.path });
  };

  /**
   * A clone the host's scan didn't find: the person picks it on the host, and
   * the host checks it is this repository before adopting it.
   */
  const pickExistingFolder = async () => {
    const picked = await pickHostPaths({
      mode: "directory",
      title: `Choose ${prep?.projectName ?? "the project"}'s folder on ${targetName}`,
      buttonLabel: needsPush ? "Push, then use this folder" : "Use this folder",
      hostId: request.toHostId,
    });
    const path = picked?.[0];
    // The dialog may have gone while the picker was up: its choice then starts nothing.
    if (path && !flowOf(request.id).closed) await openCandidate({ projectId: null, path });
  };

  /** "Change…": where the clone goes, chosen on the host. */
  const pickDestination = async () => {
    const picked = await pickHostPaths({
      mode: "directory",
      title: `Choose where to clone on ${targetName}`,
      buttonLabel: "Clone here",
      hostId: request.toHostId,
      defaultPath: destination.includes("/")
        ? destination.slice(0, destination.lastIndexOf("/")) || "/"
        : undefined,
    });
    const folder = picked?.[0];
    if (!folder) return;
    changeDestination(destinationInFolder(folder, destination, prep?.projectName ?? "project"));
  };

  /** Every way the folder changes: what was checked, or failed, for the old one no longer holds. */
  const changeDestination = (next: string) => {
    setDestination(next);
    setDestinationCheck(null);
    setCheckedInput(null);
    if (failure?.near === "destination") setFailure(null);
  };

  const checkOutHere = async () => {
    const offer = checkoutOffer;
    const target = branchTarget();
    if (!offer || !target) return;
    startFlow({ kind: "checkout" });
    const result = await execute(
      `Checking out ${target.name}`,
      {
        kind: "checkout",
        toHostId: request.toHostId,
        projectId: offer.result.projectId,
        branch: target,
        branchRemoteUrl: branchRemoteUrl(),
      },
      "top"
    );
    if (result?.kind === "opened" && !result.worktreePath && result.branchNote) {
      setFailure({
        title: `Couldn't check out ${target.name} on ${targetName}`,
        fix: `Retry, or open ${offer.result.projectName} there without it.`,
        gitText: result.branchNote,
        near: "top",
        action: { label: "Open without it", run: () => finish(offer.result) },
      });
      return;
    }
    if (result?.kind === "opened") finish(result);
  };

  const justSwitch = () => {
    onClose();
    void switchToHost(request.toHostId, newWindow);
  };

  /** Looks at the same project and worktree again, as the first look did. */
  const retryPrepare = () => {
    setLoadError(null);
    setPrep(null);
    setPrepareAttempt((n) => n + 1);
  };

  const cancelRunning = () => {
    if (!running) return;
    flowOf(request.id).stopped = true;
    safeFireAndForget(window.electron.hostSwitch.cancel({ opId: running.opId }), {
      context: "Cancelling a host switch step",
    });
  };

  /** The primary after a failure, named for what is left of the plan as it stands now. */
  const retryLabel = (next: Retry): string => {
    const pushFirst = needsPush;
    if (next.kind === "clone") return pushFirst ? "Retry push, then clone" : "Retry clone";
    if (next.kind === "bundle") return "Retry sending a copy";
    if (next.kind === "open") return pushFirst ? "Retry push, then open" : "Retry opening";
    if (next.kind === "checkout") return "Retry checkout";
    return "Retry creating worktree";
  };

  /** The primary after a failure: the step that failed, from where it failed. */
  const runRetry = (next: Retry) => {
    if (next.kind === "clone") void clone("remote");
    else if (next.kind === "bundle") void clone("bundle");
    else if (next.kind === "open") void openCandidate(next.candidate);
    else if (next.kind === "checkout") void checkOutHere();
    else {
      startFlow(next);
      void createPlacedWorktree(next.opened);
    }
  };

  const projectName = prep?.projectName ?? "This project";
  const title =
    view === "existing"
      ? `Open ${projectName} on ${targetName}`
      : landed
        ? `${projectName} is on ${targetName} now`
        : `${projectName} isn't on ${targetName} yet`;
  const busy = running !== null;
  // Once the clone landed, what it was cloned from and into is history.
  const locked = busy || landed !== null;
  const showProgress = useDeferredLoading(busy, UI_DOHERTY_THRESHOLD);
  useEffect(() => {
    const flow = flowOf(request.id);
    flow.closed = false;
    return () => {
      flow.closed = true;
      setHostSwitchBusy(request.id, false);
    };
  }, [request.id]);
  /** Closing mid-step stops it: the step is cancelled and nothing switches afterwards. */
  const closeDialog = () => {
    if (busy) cancelRunning();
    flowOf(request.id).closed = true;
    onClose();
  };
  const autoOpen =
    prep !== null &&
    !autoOpenStarted &&
    request.askFirst !== true &&
    // Moving from another machine, what's on offer is that machine's say-so:
    // the person opens it with a click.
    prep.fromHostId === LOCAL_HOST_ID &&
    opensWithoutQuestion(prep, placed !== null, navigateOnly);

  // Nothing to decide: open it there instead of asking.
  const openWithoutAsking = useEffectEvent(() => {
    setAutoOpenStarted(true);
    setAutoOpening(true);
    void openExisting().finally(() => setAutoOpening(false));
  });
  useEffect(() => {
    if (autoOpen) openWithoutAsking();
  }, [autoOpen]);
  const quietlyOpening = autoOpening && failure === null && checkoutOffer === null;
  const lfsWarning =
    prep?.usesLfs && !prep.targetGitLfsAvailable
      ? `This repository uses Git LFS, and ${targetName} doesn't have Git LFS installed. Files kept in LFS would arrive as pointer files: install it there first.`
      : null;
  const cloneable = prep ? cloneableRemotes(prep.remotes) : [];
  const chosenRemote = cloneable.find((r) => r.url === cloneUrl) ?? null;
  const checkedRemote =
    prep?.branchCheck && "remote" in prep.branchCheck ? prep.branchCheck.remote : null;
  // The branch was checked on one remote and the clone comes from another: its version is the
  // clone's, and a push to the first wouldn't reach it, so pushing isn't offered.
  const cloningOther =
    view === "clone" && chosenRemote !== null && checkedRemote !== null
      ? chosenRemote.name !== checkedRemote
      : false;
  const otherRemote =
    cloningOther && branchTarget() && chosenRemote && checkedRemote
      ? { checked: checkedRemote, cloned: chosenRemote.name }
      : null;
  const branchChoices = (handoff?.choices ?? [])
    .filter((choice) => !cloningOther || choice.plan !== "push-then-worktree")
    .map((choice) =>
      cloningOther && chosenRemote && choice.plan === "worktree"
        ? { ...choice, label: `Continue from ${chosenRemote.name}'s version` }
        : choice
    );
  const recipeName =
    recipeId === NO_RECIPE ? null : (prep?.recipes.find((r) => r.id === recipeId)?.name ?? null);
  const folderState = folderStateOf({
    value: destination,
    check: destinationCheck,
    checkedInput,
    checkError,
  });

  const viewSlots: FailureSlot[] =
    !prep || loadError || quietlyOpening || checkoutOffer
      ? []
      : view === "existing"
        ? placed
          ? ["worktree"]
          : handoff
            ? ["branch"]
            : []
        : view === "clone"
          ? ["destination", placed ? "worktree" : "branch"]
          : prep.isGitRepository && !prep.isUnborn
            ? ["destination", ...(placed ? (["worktree"] as const) : [])]
            : [];
  const failureFor = (slot: FailureSlot) => {
    if (!failure) return null;
    const here = failure.near === slot || (slot === "top" && !viewSlots.includes(failure.near));
    if (!here) return null;
    const action = failure.action;
    return (
      <div ref={failureRef}>
        <GitFailureCallout
          failure={failure}
          action={
            action && (
              <Button variant="outline" size="xs" disabled={busy} onClick={action.run}>
                {action.label}
              </Button>
            )
          }
        />
      </div>
    );
  };

  const existingFolderLink = (label: string) => (
    <Button
      variant="link"
      size="inline"
      className="self-start text-xs"
      disabled={locked}
      onClick={() => void pickExistingFolder()}
    >
      {label}
    </Button>
  );

  const destinationRow = (
    <FormRow label="Into">
      <DestinationField
        hostName={targetName}
        value={destination}
        state={folderState}
        disabled={locked}
        onChange={changeDestination}
        onPick={() => void pickDestination()}
        onUseSuggestion={changeDestination}
        sameRepository={
          view === "clone"
            ? {
                label: needsPush ? "Push, then use it" : "Use this folder",
                onUse: () =>
                  void openCandidate({
                    projectId: null,
                    path: destinationCheck?.path ?? destination.trim(),
                  }),
              }
            : undefined
        }
        onRetry={() => setCheckAttempt((n) => n + 1)}
      >
        {view === "clone" &&
          folderState.kind !== "same-repository" &&
          existingFolderLink(
            needsPush
              ? `Push, then use an existing folder on ${targetName}…`
              : `Use an existing folder on ${targetName}…`
          )}
      </DestinationField>
      {failureFor("destination")}
    </FormRow>
  );

  const placedSection = placed && (
    <FormRow label="Worktree">
      <p className="flex items-center gap-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden />
        <span className="truncate font-mono text-xs">{placed.newBranch}</span>
      </p>
      <FieldHelp>{describePlacedWorktree(placed, targetName)}</FieldHelp>
      {failureFor("worktree")}
    </FormRow>
  );

  const uncommittedNote = prep?.hasUncommittedChanges && (
    <FieldHelp>
      {pluralize(Math.max(prep.uncommittedChangeCount, 1), "uncommitted change")} on {sourceName}{" "}
      {prep.uncommittedChangeCount === 1 ? "stays" : "stay"} there.
    </FieldHelp>
  );

  const WarningGlyph = SEVERITY_GLYPH.warning;
  // The push went through and something after it didn't: the branch is published now.
  const alreadyPushed = pushing && !needsPush;
  const branchSection = placed
    ? placedSection
    : handoff && (
        <FormRow label="Branch">
          <p className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden />
            <span className="truncate font-mono text-xs">{prep?.branch ?? "(detached)"}</span>
          </p>
          <p className="flex items-start gap-1.5 [text-wrap:pretty]">
            {handoff.tone === "attention" && !alreadyPushed && (
              <WarningGlyph
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-warning"
                aria-hidden
                data-severity-glyph=""
              />
            )}
            <span>
              {alreadyPushed ? `Pushed to ${pushTarget} from ${sourceName}` : handoff.summary}
            </span>
          </p>
          {handoff.detail && !alreadyPushed && <FieldHelp>{handoff.detail}</FieldHelp>}
          {otherRemote && (
            <FieldHelp>
              Checked against {otherRemote.checked}. Cloning {otherRemote.cloned}, the worktree
              comes from {otherRemote.cloned}'s {prep?.branch} if it has one.
            </FieldHelp>
          )}
          {pushing && prep && (
            <div className="space-y-1">
              <FieldHelp>
                {alreadyPushed
                  ? `${sourceName} published ${prep.unpushedCommitCount === 1 ? "this commit" : "these commits"} to ${pushTarget}:`
                  : prep.unpushedCommits.length > 0
                    ? `The push publishes ${prep.unpushedCommitCount === 1 ? "this commit" : "these commits"} to ${pushTarget}:`
                    : `The push publishes ${prep.branch} as it is to ${pushTarget}.`}
              </FieldHelp>
              {prep.unpushedCommits.length > 0 && (
                <ul className="max-h-32 overflow-auto rounded-[var(--radius-md)] border border-border-default px-2 py-1 font-mono text-xs text-text-primary">
                  {prep.unpushedCommits.map((c) => (
                    <li key={c.sha} className="truncate">
                      <span className="text-text-secondary">{c.sha}</span> {c.subject}
                    </li>
                  ))}
                  {prep.unpushedCommitCount > prep.unpushedCommits.length && (
                    <li className="font-sans text-text-secondary">
                      and {prep.unpushedCommitCount - prep.unpushedCommits.length} more
                    </li>
                  )}
                </ul>
              )}
              {prep.headSha && (
                <FieldHelp>
                  {alreadyPushed
                    ? "A retry clones without pushing again."
                    : `Only up to ${prep.headSha.slice(0, 8)}: anything committed after this list was shown isn't pushed.`}
                </FieldHelp>
              )}
            </div>
          )}
          {branchChoices.length > 1 && !alreadyPushed && (
            <RadioChoiceGroup legend="What to do with the branch" legendHidden>
              {branchChoices.map((choice) => (
                <RadioChoiceRow
                  key={choice.plan}
                  name="host-switch-branch"
                  value={choice.plan}
                  checked={branchPlan === choice.plan}
                  onChange={() => choosePlan(choice.plan)}
                  label={choice.label}
                  description={choice.description ?? undefined}
                  disabled={locked}
                />
              ))}
            </RadioChoiceGroup>
          )}
          {uncommittedNote}
          {failureFor("branch")}
        </FormRow>
      );

  // Sent as a copy, the branch has no remote state to weigh: it comes along or it doesn't.
  const copiedBranchSection = placed
    ? placedSection
    : prep?.branch && (
        <FormRow label="Branch">
          <p className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden />
            <span className="truncate font-mono text-xs">{prep.branch}</span>
          </p>
          <FieldHelp>
            {branchTarget()
              ? `It opens in a worktree for ${prep.branch}.`
              : `Its commits come along in the copy, but it opens on the default branch.`}
          </FieldHelp>
          {uncommittedNote}
        </FormRow>
      );

  const fromElsewhere =
    prep !== null && prep.fromHostId !== LOCAL_HOST_ID && prep.defaultRecipeId !== null;
  const recipeHelp =
    recipeId !== NO_RECIPE
      ? `It starts its terminals and agents on ${targetName} once the project opens there. You'll see its commands before anything runs.`
      : fromElsewhere
        ? `None is picked for you: the project's default was set on ${sourceName}. A recipe starts terminals and agents on ${targetName}, after showing you its commands.`
        : `A recipe starts terminals and agents on ${targetName} once the project opens there, after showing you its commands.`;
  const recipeRow = prep && prep.recipes.length > 0 && (
    <FormRow label="Setup">
      <Select value={recipeId} onValueChange={setRecipeId} disabled={busy}>
        <SelectTrigger aria-label={`Setup recipe to offer on ${targetName}`} density="compact">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_RECIPE}>No setup recipe</SelectItem>
          {prep.recipes.map((recipe) => (
            <SelectItem key={recipe.id} value={recipe.id}>
              {recipe.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldHelp>{recipeHelp}</FieldHelp>
    </FormRow>
  );

  const optionsRow = view === "clone" && (
    <FormRow label="Options">
      <CloneOptions
        name="host-switch-depth"
        hostName={targetName}
        depth={depth}
        onDepth={setDepth}
        submodules={
          showSubmodules
            ? { checked: submodules, label: "Initialise submodules", onChange: setSubmodules }
            : null
        }
        disabled={locked}
      />
    </FormRow>
  );

  const fromRow = (
    <FormRow label="From">
      {cloneable.length > 1 ? (
        <Select
          value={cloneUrl}
          onValueChange={(url) => {
            setCloneUrl(url);
            setFailure(null);
            // A push goes where git pushes the branch: cloning another remote drops it.
            const name = cloneable.find((r) => r.url === url)?.name ?? null;
            if (branchPlan === "push-then-worktree" && name !== checkedRemote) {
              setBranchPlan(handoff?.defaultPlan ?? "worktree");
            }
          }}
          disabled={locked}
        >
          <SelectTrigger aria-label="Remote to clone" density="compact">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[var(--radix-select-trigger-width)]">
            {cloneable.map((remote) => (
              <SelectItem
                key={remote.name}
                value={remote.url}
                description={<span className="break-all font-mono">{remote.url}</span>}
              >
                {remote.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <p>{chosenRemote?.name ?? "origin"}</p>
      )}
      <p className="break-all font-mono text-xs text-text-secondary">{cloneUrl}</p>
      {lfsWarning && <Callout severity="warning">{lfsWarning}</Callout>}
    </FormRow>
  );

  const branchStep = (): { name: string; from: string } | null => {
    const target = branchTarget();
    if (!target) return null;
    if (pushing) return { name: target.name, from: "the commits just pushed" };
    if (view === "local-only") return { name: target.name, from: `${sourceName}'s copy` };
    if (otherRemote) {
      return { name: target.name, from: `${otherRemote.cloned}'s version, if it has the branch` };
    }
    return { name: target.name, from: `${checkedRemote ?? "the remote"}'s version` };
  };

  let body: React.ReactNode;
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null;
  let steps: string[] = [];

  if (loadError) {
    body = (
      <Callout severity="error" role="alert">
        {loadError}
      </Callout>
    );
    primary = { label: "Retry", onClick: retryPrepare };
  } else if (!prep) {
    body = showLoading ? (
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner size="sm" /> Checking {projectName} on {sourceName} and {targetName}
      </div>
    ) : null;
  } else if (quietlyOpening) {
    body = (
      <div className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
        <Spinner size="sm" /> Opening {projectName} on {targetName}
      </div>
    );
  } else if (checkoutOffer) {
    const branch = prep.branch ?? "";
    body = (
      <div className="space-y-2 text-sm text-text-primary">
        <p>
          {checkoutOffer.result.projectName} is open on {targetName}, but no worktree there has{" "}
          <span className="font-mono text-xs">{branch}</span> checked out.
        </p>
        {checkoutOffer.result.branchNote && !checkoutOffer.result.canCheckOutBranch && (
          <p className="text-xs text-text-secondary">{checkoutOffer.result.branchNote}</p>
        )}
      </div>
    );
    primary = checkoutOffer.result.canCheckOutBranch
      ? { label: "Check out here", onClick: () => void checkOutHere() }
      : { label: "Open without it", onClick: () => finish(checkoutOffer.result) };
  } else if (view === "existing") {
    body = (
      <div className="space-y-4">
        <ProjectMatchChooser
          hostName={targetName}
          candidates={prep.candidates}
          sourceRemotes={prep.remotes}
          selected={candidateIndex}
          onSelect={setCandidateIndex}
          disabled={busy}
        />
        {branchSection}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {existingFolderLink(
            needsPush
              ? `Push, then use another folder on ${targetName}…`
              : `Use another folder on ${targetName}…`
          )}
          {cloneable.length > 0 && (
            <Button
              variant="link"
              size="inline"
              className="text-xs"
              disabled={busy}
              onClick={() => setView("clone")}
            >
              Clone a fresh copy instead
            </Button>
          )}
        </div>
      </div>
    );
    const candidate = prep.candidates[candidateIndex];
    primary = {
      label:
        candidate?.source === "on-disk"
          ? needsPush
            ? "Push, then use existing folder"
            : "Use existing folder"
          : placed
            ? `Create worktree on ${targetName}`
            : needsPush
              ? "Push, then open"
              : `Open on ${targetName}`,
      onClick: () => void openExisting(),
    };
  } else if (view === "clone") {
    body = (
      <>
        {fromRow}
        {destinationRow}
        {branchSection}
        {recipeRow}
        {optionsRow}
      </>
    );
    primary = {
      label: needsPush
        ? "Push, then clone"
        : placed
          ? "Clone and create worktree"
          : "Clone and open",
      onClick: () => void clone("remote"),
      disabled: !destinationReady,
    };
  } else if (!prep.isGitRepository || prep.isUnborn) {
    body = (
      <p className="text-sm text-text-primary">
        {prep.isGitRepository
          ? `${projectName} has no commits yet, so there's nothing to send to ${targetName}. Make a first commit, then switch again.`
          : `${projectName} isn't a git repository, so it can't be sent to ${targetName}. Projects move between hosts through git.`}
      </p>
    );
  } else {
    body = (
      <>
        <FormRow label="From">
          <p className="[text-wrap:pretty]">
            {prep.remotes.length === 0
              ? `${projectName} has no remote, so ${targetName} has nothing to clone from.`
              : `${projectName}'s remotes are folders on ${sourceName}, which ${targetName} can't clone from.`}
          </p>
          <FieldHelp>
            {sourceName} sends a copy of its committed history instead. The working tree, submodule
            repositories and LFS objects stay on {sourceName}. To clone from a forge, add a remote
            there first, then switch again.
          </FieldHelp>
        </FormRow>
        {destinationRow}
        {copiedBranchSection}
        {recipeRow}
      </>
    );
    primary = {
      label: "Send a copy",
      onClick: () => void clone("bundle"),
      disabled: !destinationReady,
    };
  }

  if (view !== "existing" && primary && !checkoutOffer && !quietlyOpening && !loadError) {
    steps = describeCloneSteps({
      sourceName,
      targetName,
      source:
        view === "clone"
          ? { kind: "remote", remoteName: chosenRemote?.name ?? null }
          : { kind: "bundle" },
      // A folder that can't take the clone isn't where it goes.
      destination:
        folderState.kind === "free" || folderState.kind === "checking" ? destination.trim() : "",
      depth,
      submodules: showSubmodules && submodules,
      push:
        pushing && prep?.branch && pushTarget && pushedSha !== prep.headSha
          ? { commits: prep.unpushedCommitCount, branch: prep.branch, target: pushTarget }
          : null,
      branch: placed ? null : branchStep(),
      placed,
      recipeName,
      newWindow,
      cloned: landed !== null,
    });
  }

  // After a failure the primary repeats what failed, and says so.
  if (primary && !loadError && failure && failure.retryable !== false && retry) {
    const again = retry;
    primary = {
      label: retryLabel(again),
      onClick: () => runRetry(again),
      disabled:
        (again.kind === "clone" || again.kind === "bundle") && !destinationReady ? true : undefined,
    };
  }

  const fraction = status?.fraction != null ? ` · ${Math.round(status.fraction * 100)}%` : "";
  const hint = running ? (
    showProgress ? (
      <span className="flex min-w-0 items-center gap-2" aria-live="polite">
        <Spinner size="xs" />
        <span className="min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty]">
          {status?.message ?? running.label} on {running.hostName}
          {fraction}
          {stillWorkingOp === running.opId && " · Still working…"}
        </span>
      </span>
    ) : undefined
  ) : primary?.disabled && (view === "clone" || view === "local-only") ? (
    (folderHint(folderState, targetName) ?? undefined)
  ) : undefined;

  return (
    // Retry removes the button that held focus while the next look is out.
    <AppDialog
      isOpen
      onClose={closeDialog}
      size="md"
      initialFocus="surface"
      focusResetKey={prepareAttempt}
    >
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<Server className="h-4 w-4 text-text-secondary" />}>
          {title}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="flex flex-col gap-4">
          {failureFor("top")}
          {body}
          <OperationSteps label="What happens" steps={steps} placement="inline" />
        </div>
      </AppDialog.Body>
      <OperationSteps label="What happens" steps={steps} placement="band" />
      <AppDialog.Footer
        hint={hint}
        hintPlacement="above"
        className="flex-wrap"
        // Once the project landed there, switching without it is no longer the alternative.
        leadingAction={
          busy || landed ? undefined : { label: "Switch host only", onClick: justSwitch }
        }
        secondaryAction={{ label: "Cancel", onClick: busy ? cancelRunning : closeDialog }}
        primaryAction={
          primary
            ? {
                label: primary.label,
                onClick: primary.onClick,
                disabled: busy || primary.disabled === true,
              }
            : undefined
        }
      />
    </AppDialog>
  );
}
