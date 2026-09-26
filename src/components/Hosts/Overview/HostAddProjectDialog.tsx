import { useEffect, useId, useState } from "react";
import { FolderPlus } from "lucide-react";
import type { HostSwitchExecuteResult, HostSwitchStatus } from "@shared/types/ipc/hostSwitch";
import type { DestinationCheck, HostCloneDepth } from "@shared/types/ipc/projectMatch";
import type { HostId } from "@shared/types/remoteHosts";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { RadioChoiceGroup, RadioChoiceRow } from "@/components/ui/RadioChoice";
import { Spinner } from "@/components/ui/Spinner";
import { mintOperationId } from "@/clients/operationsClient";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import { pickHostPaths } from "@/components/HostFilePicker/hostFilePickerQueue";
import { describeCloneFailure, destinationInFolder } from "@/components/HostSwitch/hostSwitchModel";

const STATUS_POLL_MS = 300;
const CHECK_DELAY_MS = 300;

interface Failure {
  title: string;
  gitText: string;
  fix: string | null;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-baseline gap-3">
      <span className="text-xs text-text-secondary">{label}</span>
      <div className="min-w-0 text-sm text-text-primary">{children}</div>
    </div>
  );
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

/**
 * Add project… on one host's overview card: a repository URL, cloned by that
 * host with its own credentials into a folder it checked, registered there,
 * then opened. The same host-side clone the switch dialog runs, with no
 * project on this machine behind it.
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
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [checkedInput, setCheckedInput] = useState<string | null>(null);
  // The URL the check was made for: a folder vetted for one repository never clones another.
  const [checkedUrl, setCheckedUrl] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [depth, setDepth] = useState<HostCloneDepth>("full");
  const [submodules, setSubmodules] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [status, setStatus] = useState<HostSwitchStatus | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const submodulesId = useId();
  const urlId = useId();

  const trimmedUrl = url.trim();

  // The host suggests where a clone of this URL goes, until the person picks a folder.
  useEffect(() => {
    if (destinationTouched || trimmedUrl.length === 0) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      window.electron.hostSwitch
        .suggestCloneDestination({ toHostId: hostId, url: trimmedUrl })
        .then((suggested) => {
          if (cancelled) return;
          setDestination(suggested.path);
          setCheck(suggested);
          setCheckedInput(suggested.path);
          setCheckedUrl(trimmedUrl);
          setCheckError(null);
        })
        .catch(() => {
          // Not a URL the host can clone (yet); the folder waits.
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmedUrl, destinationTouched, hostId]);

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
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setCheck(null);
          setCheckedInput(null);
          setCheckError(formatErrorMessage(error, "The host didn't answer."));
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destination, destinationTouched, hostId, trimmedUrl]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      window.electron.hostSwitch
        .status({ opId: running })
        .then(setStatus)
        .catch(() => {});
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [running]);

  const busy = running !== null;
  const ready =
    trimmedUrl.length > 0 &&
    check?.status === "free" &&
    checkedInput === destination.trim() &&
    checkedUrl === trimmedUrl;

  const pickFolder = async () => {
    const picked = await pickHostPaths({
      mode: "directory",
      title: `Choose where to clone on ${hostName}`,
      buttonLabel: "Clone here",
      hostId,
    });
    const folder = picked?.[0];
    if (!folder) return;
    const name = trimmedUrl
      .replace(/\/+$/, "")
      .replace(/\.git$/, "")
      .split(/[/:]/)
      .pop();
    setDestinationTouched(true);
    setDestination(destinationInFolder(folder, destination, name || "project"));
    setCheck(null);
    setCheckedInput(null);
  };

  const clone = async () => {
    if (!ready || !check) return;
    setFailure(null);
    const opId = mintOperationId();
    setRunning(opId);
    setStatus(null);
    try {
      const result = await window.electron.hostSwitch.execute({
        kind: "clone-url",
        opId,
        toHostId: hostId,
        url: trimmedUrl,
        destination: check.path,
        options: { submodules, depth },
      });
      if (result.kind === "git-failed") {
        setFailure(
          describeCloneFailure({
            reason: result.reason,
            message: result.message,
            hostName,
            url: trimmedUrl,
          })
        );
        return;
      }
      if (result.kind === "opened") onOpened(result);
    } catch (error) {
      if (errorCode(error) !== "CANCELLED") {
        setFailure({
          title: `Cloning on ${hostName} didn't finish`,
          gitText: formatErrorMessage(error, "Something went wrong."),
          fix: null,
        });
      }
    } finally {
      setRunning(null);
    }
  };

  const cancel = () => {
    if (!running) return;
    safeFireAndForget(window.electron.hostSwitch.cancel({ opId: running }), {
      context: "Cancelling a clone on a host",
    });
  };

  const hint = running ? (
    <span className="flex items-center gap-2 text-xs text-text-secondary" aria-live="polite">
      <Spinner size="xs" />
      {status?.message ?? "Cloning"}
      {status?.fraction != null && ` · ${Math.round(status.fraction * 100)}%`}
    </span>
  ) : undefined;

  return (
    <AppDialog isOpen onClose={busy ? () => {} : onClose} size="md" initialFocus="none">
      <AppDialog.Header className="py-3">
        <AppDialog.Title icon={<FolderPlus className="h-4 w-4 text-text-secondary" />}>
          Add a project on {hostName}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <div className="flex flex-col gap-3 px-6 py-4">
        <Row label="Clone">
          <Input
            id={urlId}
            density="compact"
            aria-label={`Repository URL to clone on ${hostName}`}
            placeholder="git@github.com:owner/repo.git"
            value={url}
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Row>
        <Row label="Into">
          <div className="flex min-w-0 items-center gap-2">
            <Input
              density="compact"
              aria-label={`Folder on ${hostName}`}
              value={destination}
              spellCheck={false}
              autoComplete="off"
              disabled={busy}
              invalid={check !== null && check.status !== "free"}
              onChange={(event) => {
                setDestinationTouched(true);
                setDestination(event.target.value);
                setCheck(null);
                setCheckedInput(null);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void pickFolder()}
              aria-label={`Choose a folder on ${hostName}`}
            >
              Change…
            </Button>
          </div>
          {checkError && (
            <p role="alert" className="mt-1 text-xs text-status-error">
              Couldn't check this folder on {hostName}: {checkError}
            </p>
          )}
          {check && check.status !== "free" && (
            <p className="mt-1 text-xs text-status-warning">
              {check.detail}
              {check.suggestion && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="underline underline-offset-2 text-text-primary"
                    onClick={() => {
                      setDestinationTouched(true);
                      setDestination(check.suggestion!);
                      setCheck(null);
                      setCheckedInput(null);
                    }}
                  >
                    Use {check.suggestion}
                  </button>
                </>
              )}
            </p>
          )}
        </Row>
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
        <RadioChoiceGroup legend="How much history to clone">
          <RadioChoiceRow
            name="host-add-depth"
            value="full"
            checked={depth === "full"}
            onChange={() => setDepth("full")}
            label="Full clone"
            disabled={busy}
          />
          <RadioChoiceRow
            name="host-add-depth"
            value="shallow"
            checked={depth === "shallow"}
            onChange={() => setDepth("shallow")}
            label="Shallow clone"
            description="Only the latest commit."
            disabled={busy}
          />
          <RadioChoiceRow
            name="host-add-depth"
            value="partial"
            checked={depth === "partial"}
            onChange={() => setDepth("partial")}
            label="Partial clone"
            description="All history; file contents are fetched when needed."
            disabled={busy}
          />
        </RadioChoiceGroup>
        <p className="text-xs text-text-secondary">
          {hostName} clones with its own git credentials; nothing from this machine is sent.
        </p>
        {failure && (
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
        )}
      </div>
      <AppDialog.Footer hint={hint}>
        <div className="flex shrink-0 items-center gap-3">
          {busy ? (
            <Button variant="ghost" size="sm" onClick={cancel}>
              Cancel
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          )}
          <Button
            variant="contrast"
            size="sm"
            onClick={() => void clone()}
            disabled={busy || !ready}
          >
            Clone and open
          </Button>
        </div>
      </AppDialog.Footer>
    </AppDialog>
  );
}
