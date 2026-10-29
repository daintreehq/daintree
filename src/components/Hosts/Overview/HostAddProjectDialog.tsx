import { useEffect, useId, useRef, useState } from "react";
import { FolderPlus, RefreshCw } from "lucide-react";
import type { HostSwitchExecuteResult, HostSwitchStatus } from "@shared/types/ipc/hostSwitch";
import type { DestinationCheck, HostCloneDepth } from "@shared/types/ipc/projectMatch";
import type { HostId } from "@shared/types/remoteHosts";
import { AppDialog } from "@/components/ui/AppDialog";
import { clientErrorCode, clientErrorText } from "@/utils/clientAppError";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/Spinner";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { UI_DOHERTY_THRESHOLD, UI_STILL_WORKING_MS } from "@/lib/animationUtils";
import { mintOperationId } from "@/clients/operationsClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { pickHostPaths } from "@/components/HostFilePicker/hostFilePickerQueue";
import {
  describeAddSteps,
  describeCloneFailure,
  describeStepFailure,
  destinationInFolder,
} from "@/components/HostSwitch/hostSwitchModel";
import { GitFailureCallout, type HostGitFailure } from "@/components/HostSwitch/GitFailureCallout";
import {
  CloneOptions,
  DestinationField,
  folderHint,
  folderStateOf,
  FormRow,
  OperationSteps,
  type FolderState,
} from "@/components/HostSwitch/hostCloneForm";

const STATUS_POLL_MS = 300;
const CHECK_DELAY_MS = 300;

interface Failure extends HostGitFailure {
  /** Atop the form (opening a folder), or under the folder the clone went for. */
  near: "top" | "destination";
  action?: { label: string; run: () => void } | null;
}

/** The folder name a clone of `url` gets, as git would name it. */
function repoName(url: string): string {
  return (
    url
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop() || "project"
  );
}

/**
 * Add project… on one host's overview card: a repository URL, cloned by that
 * host with its own credentials into a folder it checked, registered there,
 * then opened. The same host-side clone the switch dialog runs, with no
 * project on this machine behind it. A repository already on the host is
 * picked there instead and opened as it is.
 */
export function HostAddProjectDialog({
  hostId,
  hostName,
  onClose,
  onOpened,
}: {
  hostId: HostId;
  hostName: string;
  onClose: () => void;
  onOpened: (result: Extract<HostSwitchExecuteResult, { kind: "opened" }>) => void;
}) {
  const [url, setUrl] = useState("");
  const [destination, setDestination] = useState("");
  // Set once the person edits the folder; a new URL then no longer moves it.
  const [destinationTouched, setDestinationTouched] = useState(false);
  // A folder chosen with Change…: the clone's own folder in it follows the URL until one is typed.
  const [pickedFolder, setPickedFolder] = useState<string | null>(null);
  // Whether the person typed the folder's name, rather than it coming from the URL or the host.
  const [nameTyped, setNameTyped] = useState(false);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [checkedInput, setCheckedInput] = useState<string | null>(null);
  // The URL the check was made for: a folder vetted for one repository never clones another.
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkAttempt, setCheckAttempt] = useState(0);
  // Why the host couldn't suggest a folder for this URL: it can't clone it (`rejected`),
  // or it didn't answer, which a Retry asks again.
  const [urlError, setUrlError] = useState<{
    url: string;
    message: string;
    rejected: boolean;
  } | null>(null);
  // A Retry for this URL's suggestion: asked again even once the folder was edited, and
  // then it only vouches for the URL, never moves the folder.
  const [retryFor, setRetryFor] = useState<{ url: string; attempt: number } | null>(null);
  const urlStatusId = useId();
  const [depth, setDepth] = useState<HostCloneDepth>("full");
  const [submodules, setSubmodules] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  /** An open of a folder already on the host, which Cancel stops waiting for (it can't be undone there). */
  const openingOp = useRef<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [status, setStatus] = useState<HostSwitchStatus | null>(null);
  const [stillWorkingOp, setStillWorkingOp] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The dialog went away: whatever the host answers now opens nothing. */
  const closed = useRef(false);
  /** The clone Cancel stopped: a success that arrives anyway opens nothing. */
  const stoppedOp = useRef<string | null>(null);
  const failureRef = useRef<HTMLDivElement>(null);

  const trimmedUrl = url.trim();

  // The host suggests where a clone of this URL goes, until the person picks a folder.
  useEffect(() => {
    if (trimmedUrl.length === 0) return;
    if (destinationTouched && retryFor?.url !== trimmedUrl) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.electron.hostSwitch
        .suggestCloneDestination({ toHostId: hostId, url: trimmedUrl })
        .then((suggested) => {
          if (cancelled) return;
          setUrlError(null);
          setRetryFor(null);
          if (destinationTouched) return;
          setDestination(suggested.path);
          setCheck(suggested);
          setCheckedInput(suggested.path);
          setCheckedUrl(trimmedUrl);
          setCheckError(null);
        })
        .catch((error: unknown) => {
          // Said at the URL, and the folder waits: a URL the host refused, or a host that didn't answer.
          if (!cancelled) {
            setUrlError({
              url: trimmedUrl,
              message: clientErrorText(error, "It isn't a git URL."),
              rejected: clientErrorCode(error) === "VALIDATION",
            });
          }
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedUrl, destinationTouched, hostId, retryFor]);

  // A folder the person typed or picked is checked on the host.
  useEffect(() => {
    if (!destinationTouched) return;
    const target = destination.trim();
    setCheckError(null);
    if (target.length === 0) {
      setCheck(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      window.electron.hostSwitch
        .checkDestination({
          toHostId: hostId,
          path: target,
          remoteUrls: trimmedUrl ? [trimmedUrl] : [],
        })
        .then((result) => {
          if (cancelled) return;
          setCheck(result);
          setCheckedInput(target);
          setCheckedUrl(trimmedUrl);
          // The host answered, so a suggestion it didn't answer no longer stands in the way;
          // a URL it refused still does.
          setUrlError((error) => (error && !error.rejected ? null : error));
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setCheck(null);
          setCheckedInput(null);
          setCheckError(clientErrorText(error, "The host didn't answer."));
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, destinationTouched, hostId, trimmedUrl, checkAttempt]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      window.electron.hostSwitch
        .status({ opId: running })
        .then(setStatus)
        .catch(() => {});
    }, STATUS_POLL_MS);
    const slow = setTimeout(() => setStillWorkingOp(running), UI_STILL_WORKING_MS);
    return () => {
      clearInterval(timer);
      clearTimeout(slow);
    };
  }, [running]);

  // A failure lands beside its field, which may be scrolled away.
  useEffect(() => {
    if (failure) failureRef.current?.scrollIntoView({ block: "nearest" });
  }, [failure]);

  const busy = running !== null;
  const showProgress = useDeferredLoading(busy, UI_DOHERTY_THRESHOLD);
  const urlProblem = urlError !== null && urlError.url === trimmedUrl ? urlError : null;
  const urlRejected = urlProblem?.rejected === true;
  // The host is still answering for this URL: its suggestion, then the folder it names.
  const suggesting =
    trimmedUrl.length > 0 && !destinationTouched && checkedUrl !== trimmedUrl && !urlProblem;
  const folder: FolderState = suggesting
    ? { kind: "checking" }
    : folderStateOf({
        value: destination,
        check: checkedUrl === trimmedUrl ? check : null,
        checkedInput,
        checkError,
      });
  const ready = trimmedUrl.length > 0 && !urlProblem && folder.kind === "free";

  const pickFolder = async () => {
    const picked = await pickHostPaths({
      mode: "directory",
      title: `Choose where to clone on ${hostName}`,
      buttonLabel: "Clone here",
      hostId,
    });
    const chosen = picked?.[0];
    if (!chosen) return;
    setDestinationTouched(true);
    // A name the person typed stays; any other is the URL's, and follows it.
    setPickedFolder(nameTyped ? null : chosen);
    setDestination(
      nameTyped
        ? destinationInFolder(chosen, destination, repoName(trimmedUrl))
        : destinationInFolder(chosen, "", repoName(trimmedUrl))
    );
    setCheck(null);
    setCheckedInput(null);
    setFailure(null);
  };

  const changeUrl = (next: string) => {
    setUrl(next);
    setFailure(null);
    if (pickedFolder !== null) {
      setDestination(destinationInFolder(pickedFolder, "", repoName(next.trim())));
      setCheck(null);
      setCheckedInput(null);
    }
  };

  const changeFolder = (next: string) => {
    setDestinationTouched(true);
    setPickedFolder(null);
    setNameTyped(true);
    setDestination(next);
    setCheck(null);
    setCheckedInput(null);
    setFailure(null);
  };

  const useSuggestion = (path: string) => {
    setDestinationTouched(true);
    setPickedFolder(null);
    setNameTyped(false);
    setDestination(path);
    setCheck(null);
    setCheckedInput(null);
    setFailure(null);
  };

  const clone = async () => {
    if (!ready || !check) return;
    setFailure(null);
    const opId = mintOperationId();
    stoppedOp.current = null;
    setRunning(opId);
    setStatus(null);
    const result = await window.electron.hostSwitch
      .execute({
        kind: "clone-url",
        opId,
        toHostId: hostId,
        url: trimmedUrl,
        destination: check.path,
        options: { submodules, depth },
      })
      .catch((error: unknown) => {
        const code = clientErrorCode(error) ?? null;
        if (code !== "CANCELLED" && !closed.current && stoppedOp.current !== opId) {
          setFailure({
            ...describeStepFailure({
              label: "Cloning",
              code,
              message: clientErrorText(error, "Something went wrong."),
              hostName,
            }),
            gitText: null,
            near: "destination",
          });
        }
        return null;
      });
    if (closed.current) return;
    setRunning(null);
    if (stoppedOp.current === opId) return;
    if (result?.kind === "git-failed") {
      setFailure({
        ...describeCloneFailure({
          reason: result.reason,
          message: result.message,
          hostName,
          url: trimmedUrl,
        }),
        near: "destination",
      });
      return;
    }
    if (result?.kind === "opened") onOpened(result);
  };

  /** A repository already on the host: picked there, opened (and registered) as it is. */
  const openFolder = async () => {
    const picked = await pickHostPaths({
      mode: "directory",
      title: `Open a project folder on ${hostName}`,
      buttonLabel: "Open",
      hostId,
    });
    const chosen = picked?.[0];
    if (!chosen || closed.current) return;
    await openFolderAt(chosen);
  };

  const openFolderAt = async (chosen: string) => {
    setFailure(null);
    const opId = mintOperationId();
    openingOp.current = opId;
    setOpening(chosen);
    setRunning(opId);
    setStatus(null);
    const result = await window.electron.hostSwitch
      .execute({ kind: "open-folder", opId, toHostId: hostId, path: chosen })
      .catch((error: unknown) => {
        const code = clientErrorCode(error) ?? null;
        if (openingOp.current === opId && code !== "CANCELLED") {
          // The host looked and said no, or the request never got an answer.
          const refused = code === "VALIDATION" || code === "NOT_FOUND";
          setFailure({
            title: refused
              ? `${hostName} can't open this folder`
              : `Opening the folder on ${hostName} didn't finish`,
            fix: refused
              ? "Choose a folder that holds a git repository."
              : `Check that ${hostName} is still connected, then retry.`,
            detail: clientErrorText(error, "Something went wrong."),
            gitText: null,
            near: "top",
            action: refused
              ? { label: "Choose another folder…", run: () => void openFolder() }
              : { label: "Retry", run: () => void openFolderAt(chosen) },
          });
        }
        return null;
      });
    // Stopped waiting meanwhile: whatever the host answers now, nothing opens.
    if (openingOp.current !== opId) return;
    openingOp.current = null;
    setOpening(null);
    setRunning(null);
    if (result?.kind === "opened") onOpened(result);
  };

  const cancel = () => {
    if (!running) return;
    if (openingOp.current !== null) {
      openingOp.current = null;
      setOpening(null);
      setRunning(null);
      return;
    }
    stoppedOp.current = running;
    safeFireAndForget(window.electron.hostSwitch.cancel({ opId: running }), {
      context: "Cancelling a clone on a host",
    });
  };

  /** Closing mid-step stops the clone (or the wait for an open) first, and nothing opens after. */
  const closeDialog = () => {
    if (busy) cancel();
    closed.current = true;
    onClose();
  };

  const failureFor = (slot: Failure["near"]) => {
    if (failure?.near !== slot) return null;
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

  const steps = describeAddSteps({
    hostName,
    destination:
      folder.kind === "free" || folder.kind === "checking" || folder.kind === "failed"
        ? destination.trim()
        : "",
    depth,
    submodules,
    opening,
    // No suggestion is coming for a URL the host couldn't answer for.
    chosen: destinationTouched || urlProblem !== null,
  });

  const fraction = status?.fraction != null ? ` · ${Math.round(status.fraction * 100)}%` : "";
  const stillWorking = stillWorkingOp !== null && stillWorkingOp === running;
  const progress = opening
    ? `Opening the folder on ${hostName}${stillWorking ? " · Still working…" : ""}. Stopping only stops waiting: ${hostName} may still add it.`
    : `${status?.message ?? "Cloning"} on ${hostName}${fraction}${stillWorking ? " · Still working…" : ""}`;
  const hint = busy ? (
    showProgress ? (
      <span className="flex min-w-0 items-center gap-2" aria-live="polite">
        <Spinner size="xs" />
        <span className="min-w-0 [text-wrap:pretty]">{progress}</span>
      </span>
    ) : undefined
  ) : ready ? undefined : trimmedUrl.length === 0 ? (
    "Enter a repository URL"
  ) : urlRejected ? (
    `${hostName} can't clone this URL`
  ) : urlProblem ? (
    `Couldn't ask ${hostName} where to clone it`
  ) : (
    (folderHint(folder, hostName) ?? undefined)
  );

  return (
    <AppDialog isOpen onClose={closeDialog} size="md" initialFocus="surface">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<FolderPlus className="h-4 w-4 text-text-secondary" />}>
          Add a project on {hostName}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary [text-wrap:pretty]">
            Clone a repository onto {hostName}, or open a folder that's already there.
          </p>
          {failureFor("top")}
          <FormRow label="Repository">
            <Input
              density="compact"
              className="h-7 font-mono"
              aria-describedby={urlStatusId}
              aria-label={`Repository URL to clone on ${hostName}`}
              placeholder="git@github.com:owner/repo.git"
              value={url}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              invalid={urlRejected}
              onChange={(event) => changeUrl(event.target.value)}
            />
            <div id={urlStatusId} aria-live="polite" className="empty:hidden">
              {urlProblem?.rejected && (
                <Callout severity="error">
                  {hostName} can't clone this URL. {urlProblem.message}
                </Callout>
              )}
              {urlProblem && !urlProblem.rejected && (
                <Callout
                  severity="error"
                  action={
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        setRetryFor((last) => ({
                          url: trimmedUrl,
                          attempt: (last?.attempt ?? 0) + 1,
                        }))
                      }
                    >
                      <RefreshCw aria-hidden="true" />
                      Retry
                    </Button>
                  }
                >
                  Couldn't ask {hostName} where to clone it: {urlProblem.message}
                </Callout>
              )}
            </div>
          </FormRow>
          <FormRow label="Into">
            <DestinationField
              hostName={hostName}
              value={destination}
              state={folder}
              disabled={busy}
              placeholder={
                trimmedUrl.length > 0
                  ? `Choose a folder on ${hostName}`
                  : `Suggested by ${hostName} once there's a URL`
              }
              onChange={changeFolder}
              onPick={() => void pickFolder()}
              onUseSuggestion={useSuggestion}
              sameRepository={{
                label: "Open this folder",
                onUse: () => void openFolderAt(check?.path ?? destination.trim()),
              }}
              onRetry={() => setCheckAttempt((n) => n + 1)}
            />
            {failureFor("destination")}
          </FormRow>
          <FormRow label="Options">
            <CloneOptions
              name="host-add-depth"
              hostName={hostName}
              depth={depth}
              onDepth={setDepth}
              submodules={{
                checked: submodules,
                label: "Initialise submodules, if it has any",
                onChange: setSubmodules,
              }}
              disabled={busy}
            />
          </FormRow>
          <OperationSteps label="What happens" steps={steps} placement="inline" />
        </div>
      </AppDialog.Body>
      <OperationSteps label="What happens" steps={steps} placement="band" />
      <AppDialog.Footer
        hint={hint}
        hintPlacement="above"
        className="flex-wrap"
        leadingAction={
          busy ? undefined : { label: "Open a folder…", onClick: () => void openFolder() }
        }
        secondaryAction={{
          label: opening ? "Stop waiting" : "Cancel",
          onClick: busy ? cancel : closeDialog,
        }}
        primaryAction={
          // Opening a folder that's there isn't a clone: the only answer is to stop waiting.
          opening
            ? undefined
            : {
                label: failure?.near === "destination" ? "Retry clone" : "Clone and open",
                onClick: () => void clone(),
                disabled: busy || !ready,
              }
        }
      />
    </AppDialog>
  );
}
