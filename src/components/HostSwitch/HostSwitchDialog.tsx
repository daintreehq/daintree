import { useEffect, useId, useMemo, useState } from "react";
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
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { mintOperationId } from "@/clients/operationsClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { clientPlatform, localHostLabel } from "@/components/Hosts/hostModel";
import { useHostList } from "@/components/Hosts/hostList";
import { switchToHost } from "@/components/Hosts/hostSwitching";
import { ProjectMatchChooser } from "./ProjectMatchChooser";
import {
  describeBranchHandoff,
  describeCloneFailure,
  hostDisplayName,
  initialView,
  type BranchPlan,
} from "./hostSwitchModel";
import type { HostSwitchRequest } from "./hostSwitchRequests";

const STATUS_POLL_MS = 300;
const DESTINATION_CHECK_DELAY_MS = 300;
const NO_RECIPE = "__none__";

type View = "existing" | "clone" | "local-only";

interface Failure {
  title: string;
  gitText: string;
  fix: string | null;
}

interface CheckoutOffer {
  result: Extract<HostSwitchExecuteResult, { kind: "opened" }>;
}

/** One step through the switch service; a failure other than a cancel is shown, not thrown. */
type StepPayload = HostSwitchExecutePayload extends infer P
  ? P extends HostSwitchExecutePayload
    ? Omit<P, "opId">
    : never
  : never;

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function runStep(
  opId: string,
  payload: StepPayload,
  label: string,
  onFailure: (failure: Failure) => void
): Promise<HostSwitchExecuteResult | null> {
  return window.electron.hostSwitch.execute({ ...payload, opId }).catch((error: unknown) => {
    if (errorCode(error) !== "CANCELLED") {
      onFailure({
        title: `${label} didn't finish`,
        gitText: formatErrorMessage(error, "Something went wrong."),
        fix: null,
      });
    }
    return null;
  });
}

function currentHostId(): string {
  return window.__DAINTREE_HOST_ID__?.id ?? LOCAL_HOST_ID;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-3">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="min-w-0 text-sm text-text-primary">{children}</div>
    </div>
  );
}

function FailureBlock({ failure }: { failure: Failure }) {
  return (
    <div
      role="alert"
      className="space-y-2 rounded-[var(--radius-md)] border border-status-error/40 bg-status-error/10 px-3 py-2.5"
    >
      <p className="text-sm font-medium text-text-primary">{failure.title}</p>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-secondary select-text">
        {failure.gitText}
      </pre>
      {failure.fix && <p className="text-sm text-text-primary">{failure.fix}</p>}
    </div>
  );
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
}: {
  request: HostSwitchRequest;
  onClose: () => void;
}) {
  const { hosts } = useHostList();
  const localLabel = localHostLabel(clientPlatform());
  const fromHostId = currentHostId();
  const sourceName = hostDisplayName(fromHostId, hosts, localLabel);
  const targetName = hostDisplayName(request.toHostId, hosts, localLabel);

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [recipeId, setRecipeId] = useState<string>(NO_RECIPE);
  const [running, setRunning] = useState<{ opId: string; label: string } | null>(null);
  const [status, setStatus] = useState<HostSwitchStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [checkoutOffer, setCheckoutOffer] = useState<CheckoutOffer | null>(null);
  const submodulesId = useId();
  const showLoading = useDeferredLoading(prep === null && loadError === null, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    let cancelled = false;
    window.electron.hostSwitch
      .prepare({
        fromHostId,
        toHostId: request.toHostId,
        projectId: request.projectId,
        worktreePath: request.worktreePath,
      })
      .then((prepared) => {
        if (cancelled) return;
        setPrep(prepared);
        setView(initialView(prepared));
        setBranchPlan(describeBranchHandoff(prepared, "").defaultPlan);
        setCloneUrl(prepared.cloneUrl ?? prepared.remotes[0]?.url ?? "");
        setDestination(prepared.destination?.path ?? "");
        setDestinationCheck(prepared.destination);
        setCheckedInput(prepared.destination?.path ?? null);
        setSubmodules(prepared.hasSubmodules);
        setRecipeId(prepared.defaultRecipeId ?? NO_RECIPE);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(formatErrorMessage(error, "Couldn't look at the project."));
      });
    return () => {
      cancelled = true;
    };
  }, [fromHostId, request.toHostId, request.projectId, request.worktreePath]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      window.electron.hostSwitch
        .status({ opId: running.opId })
        .then(setStatus)
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

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
          setCheckError(formatErrorMessage(error, "The host didn't answer."));
        });
    }, DESTINATION_CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, prep, view, remoteUrls, request.toHostId, targetName, checkAttempt]);

  const handoff = prep ? describeBranchHandoff(prep, sourceName) : null;
  const destinationReady =
    destinationCheck?.status === "free" && checkedInput === destination.trim();

  const branchTarget = (): HostBranchTarget | null => {
    if (!prep?.branch || branchPlan === "no-worktree") return null;
    return { name: prep.branch, remoteBranch: prep.remoteBranch ?? prep.branch };
  };

  const branchRemoteUrl = (): string | null => {
    const check = prep?.branchCheck;
    const remoteName = check && "remote" in check ? check.remote : null;
    return prep?.remotes.find((r) => r.name === remoteName)?.url ?? prep?.cloneUrl ?? null;
  };

  const execute = (
    label: string,
    payload: StepPayload
  ): Promise<HostSwitchExecuteResult | null> => {
    const opId = mintOperationId();
    setRunning({ opId, label });
    setStatus(null);
    return runStep(opId, payload, label, setFailure).finally(() => setRunning(null));
  };

  /** The source-side push the user chose, before anything happens on the target. */
  const pushIfChosen = async (): Promise<boolean> => {
    if (branchPlan !== "push-then-worktree" || !prep?.branch) return true;
    const check = prep.branchCheck;
    const remote = check && "remote" in check ? check.remote : null;
    if (!remote) return false;
    const result = await execute(`Pushing ${prep.branch}`, {
      kind: "push",
      fromHostId,
      projectId: prep.projectId,
      worktreePath: prep.worktreePath,
      branch: prep.branch,
      remote,
      remoteBranch: prep.remoteBranch ?? prep.branch,
    });
    if (result?.kind === "git-failed") {
      setFailure({
        title: `Couldn't push ${prep.branch} from ${sourceName}`,
        gitText: result.message,
        fix: null,
      });
      return false;
    }
    return result?.kind === "pushed";
  };

  const finish = (result: Extract<HostSwitchExecuteResult, { kind: "opened" }>) => {
    onClose();
    void switchToHost(result.hostId, false, result.projectId);
  };

  const handleOpened = (result: HostSwitchExecuteResult | null) => {
    if (!result) return;
    if (result.kind === "git-failed") {
      setFailure(
        result.step === "push"
          ? {
              title: `Couldn't push from ${sourceName}`,
              gitText: result.message,
              fix: null,
            }
          : describeCloneFailure({
              reason: result.reason,
              message: result.message,
              hostName: targetName,
              url: view === "local-only" ? null : cloneUrl,
            })
      );
      return;
    }
    if (result.kind !== "opened") return;
    if (!result.worktreePath && branchTarget() && (result.canCheckOutBranch || result.branchNote)) {
      setCheckoutOffer({ result });
      return;
    }
    finish(result);
  };

  const clone = async (source: "remote" | "bundle") => {
    if (!destinationReady || !prep || !destinationCheck) return;
    setFailure(null);
    if (!(await pushIfChosen())) return;
    const result = await execute(source === "bundle" ? "Sending a copy" : "Cloning", {
      kind: "clone",
      fromHostId,
      toHostId: request.toHostId,
      projectId: prep.projectId,
      source: source === "bundle" ? { kind: "bundle" } : { kind: "remote", url: cloneUrl },
      destination: destinationCheck.path,
      branch: branchTarget(),
      options: { submodules: source === "remote" && submodules, depth },
      setupRecipeId: recipeId === NO_RECIPE ? null : recipeId,
    });
    handleOpened(result);
  };

  const openExisting = async () => {
    const candidate = prep?.candidates[candidateIndex];
    if (!prep || !candidate) return;
    setFailure(null);
    if (!(await pushIfChosen())) return;
    const result = await execute("Opening", {
      kind: "open",
      toHostId: request.toHostId,
      candidate: { projectId: candidate.projectId, path: candidate.path },
      remoteUrls,
      branch: branchTarget(),
      branchRemoteUrl: branchRemoteUrl(),
    });
    handleOpened(result);
  };

  const checkOutHere = async () => {
    const offer = checkoutOffer;
    const target = branchTarget();
    if (!offer || !target) return;
    setFailure(null);
    const result = await execute(`Checking out ${target.name}`, {
      kind: "checkout",
      toHostId: request.toHostId,
      projectId: offer.result.projectId,
      branch: target,
      branchRemoteUrl: branchRemoteUrl(),
    });
    if (result?.kind === "opened" && !result.worktreePath && result.branchNote) {
      setFailure({
        title: `Couldn't check out ${target.name} on ${targetName}`,
        gitText: result.branchNote,
        fix: null,
      });
      return;
    }
    if (result?.kind === "opened") finish(result);
  };

  const justSwitch = () => {
    onClose();
    void switchToHost(request.toHostId, false);
  };

  const cancelRunning = () => {
    if (!running) return;
    safeFireAndForget(window.electron.hostSwitch.cancel({ opId: running.opId }), {
      context: "Cancelling a host switch step",
    });
  };

  const projectName = prep?.projectName ?? "This project";
  const title =
    view === "existing"
      ? `Open ${projectName} on ${targetName}`
      : `${projectName} isn't on ${targetName} yet`;
  const busy = running !== null;
  const lfsWarning =
    prep?.usesLfs && !prep.targetGitLfsAvailable
      ? `This repository uses Git LFS, and git lfs isn't installed on ${targetName}. Files kept in LFS would arrive as pointer files; install it there first.`
      : null;

  const destinationField = (
    <Row label="Into">
      <Input
        density="compact"
        aria-label={`Folder on ${targetName}`}
        value={destination}
        spellCheck={false}
        autoComplete="off"
        disabled={busy}
        invalid={destinationCheck !== null && destinationCheck.status !== "free"}
        onChange={(event) => {
          setDestination(event.target.value);
          setDestinationCheck(null);
          setCheckedInput(null);
        }}
      />
      {checkError && (
        <p role="alert" className="mt-1 text-xs text-status-error">
          Couldn't check this folder on {targetName}: {checkError}{" "}
          <button
            type="button"
            className="underline underline-offset-2 text-text-primary"
            disabled={busy}
            onClick={() => setCheckAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </p>
      )}
      {destinationCheck && destinationCheck.status !== "free" && (
        <p className="mt-1 text-xs text-status-warning">
          {destinationCheck.detail}
          {destinationCheck.suggestion && (
            <>
              {" "}
              <button
                type="button"
                className="underline underline-offset-2 text-text-primary"
                onClick={() => {
                  setDestination(destinationCheck.suggestion!);
                  setDestinationCheck(null);
                  setCheckedInput(null);
                }}
              >
                Use {destinationCheck.suggestion}
              </button>
            </>
          )}
        </p>
      )}
    </Row>
  );

  const branchSection = handoff && (
    <Row label="Branch">
      <div className="space-y-2">
        <p className="flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-secondary" aria-hidden />
          <span className="truncate font-mono text-xs">{prep?.branch ?? "(detached)"}</span>
        </p>
        <p className={handoff.tone === "attention" ? "text-status-warning" : "text-text-secondary"}>
          {handoff.summary}
        </p>
        {handoff.detail && <p className="text-xs text-text-secondary">{handoff.detail}</p>}
        {branchPlan === "push-then-worktree" && prep && (
          <div className="space-y-1">
            <p className="text-xs text-text-secondary">
              {prep.unpushedCommits.length > 0
                ? `The push publishes ${prep.unpushedCommits.length === 1 ? "this commit" : "these commits"}:`
                : "The push publishes the branch as it is."}
            </p>
            {prep.unpushedCommits.length > 0 && (
              <ul className="max-h-32 overflow-auto rounded-[var(--radius-md)] border border-border-default px-2 py-1 font-mono text-xs text-text-primary">
                {prep.unpushedCommits.map((c) => (
                  <li key={c.sha} className="truncate">
                    <span className="text-text-secondary">{c.sha}</span> {c.subject}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {handoff.choices.length > 0 && (
          <RadioChoiceGroup legend="What to do with the branch" legendHidden>
            {handoff.choices.map((choice) => (
              <RadioChoiceRow
                key={choice.plan}
                name="host-switch-branch"
                value={choice.plan}
                checked={branchPlan === choice.plan}
                onChange={() => setBranchPlan(choice.plan)}
                label={choice.label}
                description={choice.description ?? undefined}
                disabled={busy}
              />
            ))}
          </RadioChoiceGroup>
        )}
        {prep?.hasUncommittedChanges && (
          <p className="text-xs text-text-secondary">
            Uncommitted changes on {sourceName} stay there.
          </p>
        )}
      </div>
    </Row>
  );

  const cloneOptions = prep && (
    <>
      {view === "clone" && (
        <label htmlFor={submodulesId} className="flex items-center gap-2 text-sm text-text-primary">
          <Checkbox
            id={submodulesId}
            size="sm"
            checked={submodules}
            disabled={busy}
            onCheckedChange={(checked) => setSubmodules(checked === true)}
          />
          Initialise submodules
        </label>
      )}
      {prep.recipes.length > 0 && (
        <Row label="Setup">
          <Select value={recipeId} onValueChange={setRecipeId} disabled={busy}>
            <SelectTrigger aria-label="Recipe to run after cloning" className="h-8">
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
        </Row>
      )}
      {view === "clone" && (
        <div>
          <button
            type="button"
            className="text-xs text-text-secondary underline-offset-2 hover:underline"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            Advanced
          </button>
          {advancedOpen && (
            <RadioChoiceGroup legend="How much history to clone" className="mt-2">
              <RadioChoiceRow
                name="host-switch-depth"
                value="full"
                checked={depth === "full"}
                onChange={() => setDepth("full")}
                label="Full clone"
                disabled={busy}
              />
              <RadioChoiceRow
                name="host-switch-depth"
                value="shallow"
                checked={depth === "shallow"}
                onChange={() => setDepth("shallow")}
                label="Shallow clone"
                description="Only the latest commit."
                disabled={busy}
              />
              <RadioChoiceRow
                name="host-switch-depth"
                value="partial"
                checked={depth === "partial"}
                onChange={() => setDepth("partial")}
                label="Partial clone"
                description="All history; file contents are fetched when needed."
                disabled={busy}
              />
            </RadioChoiceGroup>
          )}
        </div>
      )}
    </>
  );

  let body: React.ReactNode;
  let primary: { label: string; onClick: () => void; disabled?: boolean } | null = null;

  if (loadError) {
    body = <p className="text-sm text-status-error">{loadError}</p>;
  } else if (!prep) {
    body = showLoading ? (
      <div className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner size="sm" /> Checking {projectName} on {sourceName} and {targetName}
      </div>
    ) : null;
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
      ? { label: `Check out ${branch} here`, onClick: () => void checkOutHere() }
      : { label: "Open without it", onClick: () => finish(checkoutOffer.result) };
  } else if (view === "existing") {
    body = (
      <div className="space-y-4">
        <ProjectMatchChooser
          candidates={prep.candidates}
          sourceRemotes={prep.remotes}
          selected={candidateIndex}
          onSelect={setCandidateIndex}
          disabled={busy}
        />
        {branchSection}
        {prep.remotes.length > 0 && (
          <button
            type="button"
            className="text-xs text-text-secondary underline-offset-2 hover:underline"
            disabled={busy}
            onClick={() => setView("clone")}
          >
            Clone a fresh copy instead
          </button>
        )}
      </div>
    );
    const candidate = prep.candidates[candidateIndex];
    primary = {
      label:
        candidate?.source === "on-disk"
          ? "Use existing folder"
          : branchPlan === "push-then-worktree"
            ? "Push, then open"
            : `Open on ${targetName}`,
      onClick: () => void openExisting(),
    };
  } else if (view === "clone") {
    body = (
      <div className="space-y-3">
        <Row label="Clone">
          {prep.remotes.length > 1 ? (
            <Select value={cloneUrl} onValueChange={setCloneUrl} disabled={busy}>
              <SelectTrigger aria-label="Remote to clone" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {prep.remotes.map((remote) => (
                  <SelectItem key={remote.name} value={remote.url}>
                    {remote.name} · {remote.url}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="break-all font-mono text-xs">{cloneUrl}</span>
          )}
        </Row>
        {destinationField}
        {branchSection}
        {lfsWarning && <p className="text-xs text-status-warning">{lfsWarning}</p>}
        {cloneOptions}
      </div>
    );
    primary = {
      label: branchPlan === "push-then-worktree" ? "Push, then clone" : "Clone and open",
      onClick: () => void clone("remote"),
      disabled: !destinationReady,
    };
  } else {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-text-primary">
          {projectName} has no remote, so there's nothing for {targetName} to clone from.
        </p>
        <p className="text-sm text-text-secondary">
          Send a copy of the repository: its committed history only. The working tree, submodule
          repositories and LFS objects stay on {sourceName}. Or add a remote first (publish it to a
          forge), then switch again.
        </p>
        {destinationField}
        {cloneOptions}
      </div>
    );
    primary = {
      label: "Send a copy of the repository",
      onClick: () => void clone("bundle"),
      disabled: !destinationReady,
    };
  }

  const hint = running ? (
    <span className="flex items-center gap-2 text-xs text-text-secondary" aria-live="polite">
      <Spinner size="xs" />
      {status?.message ?? running.label}
      {status?.fraction != null && ` · ${Math.round(status.fraction * 100)}%`}
    </span>
  ) : undefined;

  return (
    <AppDialog isOpen onClose={busy ? () => {} : onClose} size="md" initialFocus="none">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<Server className="h-4 w-4 text-text-secondary" />}>
          {title}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="flex flex-col gap-4 px-6 py-4">
        {body}
        {failure && <FailureBlock failure={failure} />}
      </div>
      <AppDialog.Footer hint={hint}>
        <div className="flex shrink-0 items-center gap-3">
          {busy ? (
            <Button variant="ghost" size="sm" onClick={cancelRunning}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={justSwitch}>
              Just switch host
            </Button>
          )}
          {primary && (
            <Button
              variant="contrast"
              size="sm"
              onClick={primary.onClick}
              disabled={busy || primary.disabled === true}
            >
              {primary.label}
            </Button>
          )}
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
