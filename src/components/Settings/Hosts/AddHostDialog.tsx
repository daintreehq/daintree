import { useEffect, useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { isMac } from "@/lib/platform";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { mintOperationId } from "@/clients/operationsClient";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import type { HostId, OperationId } from "@shared/types/remoteHosts";
import type {
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  InstallHostPayload,
  InstallHostResult,
  LinuxPackagePreference,
} from "@shared/types/ipc/remoteHosts";
import { HostCommand } from "./HostCommand";
import { defaultHostName, deliveryLabel, installLabel, platformLabel } from "./hostLabels";

type Step = "discover" | "check" | "install" | "enable" | "advise";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "discover", label: "Find" },
  { id: "check", label: "Check" },
  { id: "install", label: "Install" },
  { id: "enable", label: "Enable" },
  { id: "advise", label: "Advise" },
];

const SOURCE_LABEL: Record<DiscoveredHost["source"], string> = {
  tailscale: "Tailnet",
  bonjour: "Local network",
  manual: "Entered",
};

interface AddHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Update an existing host: start at the check with its target filled in. */
  existing?: { hostId: HostId; name: string; sshTarget: string } | null;
}

function StepBar({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <ol className="mb-4 flex items-center gap-3 text-xs" aria-label="Steps">
      {STEPS.map((step, i) => (
        <li
          key={step.id}
          aria-current={i === index ? "step" : undefined}
          className={cn(
            i === index ? "font-medium text-text-primary" : "text-text-secondary",
            i > index && "opacity-70"
          )}
        >
          {i + 1}. {step.label}
        </li>
      ))}
    </ol>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="text-right text-text-primary select-text">{value}</span>
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-3 text-xs text-status-error select-text">
      {message}
    </p>
  );
}

export function AddHostDialog({ isOpen, onClose, existing = null }: AddHostDialogProps) {
  const [step, setStep] = useState<Step>(existing ? "check" : "discover");
  const [discovered, setDiscovered] = useState<DiscoveredHost[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverAttempt, setDiscoverAttempt] = useState(0);
  const [target, setTarget] = useState(existing?.sshTarget ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  const [plan, setPlan] = useState<HostInstallPlan | null>(null);
  const [linuxPackage, setLinuxPackage] = useState<LinuxPackagePreference>("deb");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId, setOpId] = useState<OperationId | null>(null);
  const [installResult, setInstallResult] = useState<InstallHostResult | null>(null);
  const [confirmProceed, setConfirmProceed] = useState(false);
  /** Saved to the host list, but the connection that followed failed. */
  const [added, setAdded] = useState<{ hostId: HostId; name: string } | null>(null);
  const install = useRemoteHostsStore((s) => (opId ? (s.installs[opId] ?? null) : null));
  const discovering = !existing && discovered === null && discoverError === null;
  const showDiscovering = useDeferredLoading(discovering, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    if (!isOpen || existing) return;
    let live = true;
    remoteHostsClient.discover().then(
      (found) => {
        if (live) setDiscovered(found);
      },
      (err: unknown) => {
        if (live) setDiscoverError(formatErrorMessage(err, "Discovery failed"));
      }
    );
    return () => {
      live = false;
    };
  }, [isOpen, existing, discoverAttempt]);

  const retryDiscover = () => {
    setDiscovered(null);
    setDiscoverError(null);
    setDiscoverAttempt((n) => n + 1);
  };

  const hostLabel = existing?.name ?? (name.trim() || defaultHostName(target.trim()));

  const run = <T,>(work: () => Promise<T>, then: (value: T) => void) => {
    setBusy(true);
    setError(null);
    work().then(
      (value) => {
        setBusy(false);
        then(value);
      },
      (err: unknown) => {
        setBusy(false);
        setError(formatErrorMessage(err, "Something went wrong"));
      }
    );
  };

  const check = () =>
    run(
      () => remoteHostsClient.probe(target.trim()),
      (result) => {
        setProbe(result);
        if (result.install?.packaging === "appimage") setLinuxPackage("appimage");
        setStep("check");
      }
    );

  const loadPlan = (pkg: LinuxPackagePreference) =>
    run(
      () => remoteHostsClient.planInstall({ sshTarget: target.trim(), linuxPackage: pkg }),
      (next) => {
        setPlan(next);
        setInstallResult(null);
        setStep("install");
      }
    );

  const startInstall = (whileWorking: InstallHostPayload["whileWorking"]) => {
    const id = mintOperationId();
    useRemoteHostsStore.getState().trackInstall(id, target.trim());
    setOpId(id);
    run(
      () =>
        remoteHostsClient.install({
          opId: id,
          sshTarget: target.trim(),
          hostId: existing?.hostId,
          linuxPackage: probe?.platform === "linux" ? linuxPackage : undefined,
          whileWorking,
        }),
      (result) => {
        setInstallResult(result);
        if (result.status === "installed" || result.status === "up-to-date") {
          setProbe(result.probe);
          setStep("enable");
        }
      }
    );
  };

  const startHostMode = () =>
    run(
      () => remoteHostsClient.startHostMode(target.trim()),
      (result) => setProbe(result)
    );

  const connectAdded = (hostId: HostId, hostName: string) =>
    run(
      async () => {
        try {
          await remoteHostsClient.connect(hostId);
          return true;
        } catch (err) {
          // The host is in the list either way; only the connection is retried.
          setAdded({ hostId, name: hostName });
          throw err;
        }
      },
      () => onClose()
    );

  const finish = () => {
    if (existing) {
      onClose();
      return;
    }
    const hostName = name.trim() || defaultHostName(target.trim());
    run(
      () => remoteHostsClient.add({ name: hostName, sshTarget: target.trim() }),
      (descriptor) => {
        if (probe?.hostModeListening) connectAdded(descriptor.id, hostName);
        else onClose();
      }
    );
  };

  const cancelInstall = () => {
    if (opId) void remoteHostsClient.cancelInstall(opId);
  };

  const installRunning = busy && step === "install" && opId !== null;

  let primary: DialogAction | undefined;
  let secondary: DialogAction | undefined = { label: "Cancel", onClick: onClose };
  let body: React.ReactNode;

  if (added) {
    body = (
      <div className="space-y-2 text-sm">
        <p className="text-text-primary">{added.name} was added to your hosts.</p>
        <p className="text-text-secondary">
          Daintree couldn&apos;t connect to it yet. It stays in the list, so you can connect now or
          later from Settings → Hosts.
        </p>
      </div>
    );
    primary = {
      label: "Connect",
      onClick: () => connectAdded(added.hostId, added.name),
      disabled: busy,
      loading: busy,
    };
    secondary = { label: "Close", onClick: onClose };
  } else if (step === "discover") {
    body = (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">On your tailnet and network</p>
          {discoverError !== null ? (
            <div className="flex items-start justify-between gap-3">
              <p role="alert" className="text-sm text-text-secondary select-text">
                Couldn&apos;t look for machines: {discoverError}
              </p>
              <Button variant="outline" size="sm" onClick={retryDiscover}>
                Retry
              </Button>
            </div>
          ) : discovered === null ? (
            showDiscovering ? (
              <p className="flex items-center gap-2 text-sm text-text-secondary">
                <Spinner size="sm" /> Looking for Macs and Linux machines
              </p>
            ) : null
          ) : discovered.length === 0 ? (
            <p className="text-sm text-text-secondary">
              Nothing found. Enter the machine&apos;s SSH target below.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-[var(--radius-lg)] border border-border-default">
              {discovered.map((host) => (
                <li key={`${host.source}:${host.sshTarget}`}>
                  <button
                    type="button"
                    disabled={host.alreadyAdded}
                    aria-pressed={target === host.sshTarget}
                    onClick={() => {
                      setTarget(host.sshTarget);
                      setName(host.name);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
                      "hover:bg-overlay-soft disabled:cursor-default disabled:hover:bg-transparent",
                      target === host.sshTarget && "bg-overlay-subtle"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-primary">
                        {host.name}
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {host.sshTarget} · {platformLabel(host.platform, null)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {host.alreadyAdded ? "Added" : SOURCE_LABEL[host.source]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-text-secondary">
            Listed machines answered on the network. Whether Daintree is ready there is checked
            next.
          </p>
        </div>
        <Field>
          <FieldLabel>SSH target</FieldLabel>
          <Input
            value={target}
            placeholder="user@studio-03"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setTarget(e.target.value)}
          />
          <FieldDescription>
            Anything `ssh` accepts here: user@host, a tailnet name, or an ~/.ssh/config alias
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            placeholder={target ? defaultHostName(target) : "studio-03"}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>
    );
    primary = {
      label: "Check host",
      onClick: check,
      disabled: busy || target.trim().length === 0,
      loading: busy,
    };
  } else if (step === "check") {
    body = !probe ? (
      <p className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner size="sm" /> Checking {target}
      </p>
    ) : (
      <div>
        <Line label="SSH" value={probe.reachable ? "Works" : "Didn't connect"} />
        {!probe.reachable && probe.sshError && (
          <pre className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text">
            {probe.sshError}
          </pre>
        )}
        {probe.reachable && (
          <>
            <Line label="Platform" value={platformLabel(probe.platform, probe.arch)} />
            <Line label="Installed" value={installLabel(probe.install)} />
            <Line
              label="Matches this machine"
              value={
                probe.matchesClient === true
                  ? "Same build"
                  : probe.matchesClient === false
                    ? "Different build"
                    : "Can't tell"
              }
            />
            <Line label="Host mode" value={probe.hostModeListening ? "Listening" : "Off"} />
          </>
        )}
        {!probe.reachable && (
          <p className="mt-3 text-xs text-text-secondary">
            Daintree connects with your own `ssh` and never asks for a password. On a Mac, turn on
            Remote Login in System Settings → General → Sharing.
          </p>
        )}
      </div>
    );
    if (probe && !probe.reachable) {
      primary = { label: "Check again", onClick: check, disabled: busy, loading: busy };
    } else if (probe?.matchesClient === true) {
      primary = { label: "Continue", onClick: () => setStep("enable") };
    } else if (probe) {
      primary = {
        label: probe.install ? "Plan update" : "Plan install",
        onClick: () => loadPlan(linuxPackage),
        disabled: busy,
        loading: busy,
      };
    } else {
      primary = { label: "Check host", onClick: check, disabled: busy, loading: busy };
    }
    if (!existing) secondary = { label: "Back", onClick: () => setStep("discover") };
  } else if (step === "install") {
    const progress = install?.progress ?? null;
    body = plan ? (
      <div className="space-y-3">
        {probe?.platform === "linux" && (
          <div className="flex items-center justify-between gap-4">
            <span className="text-sm text-text-secondary">Package</span>
            <SegmentedRadioGroup<LinuxPackagePreference>
              aria-label="Package"
              options={[
                { value: "deb", label: ".deb" },
                { value: "appimage", label: "AppImage" },
              ]}
              value={linuxPackage}
              disabled={busy}
              onChange={(value) => {
                setLinuxPackage(value);
                loadPlan(value);
              }}
            />
          </div>
        )}
        {plan.kind === "unsupported" ? (
          <p className="text-sm text-text-secondary">{plan.reason}</p>
        ) : plan.kind === "up-to-date" ? (
          <p className="text-sm text-text-secondary">The host already runs this build.</p>
        ) : (
          <>
            <p className="text-sm text-text-primary">
              Installs Daintree {plan.version} — the exact build running here.
            </p>
            <p className="text-sm text-text-secondary">{deliveryLabel(plan)}.</p>
            {plan.packaging === "deb" && (
              <p className="text-xs text-text-secondary">
                The package needs sudo, so the last step is one command you run on the host. The
                AppImage installs without root but needs libfuse2.
              </p>
            )}
            {plan.restartsHost && (
              <p className="text-xs text-text-secondary">
                Daintree is running there. Updating restarts it, which ends its terminals.
              </p>
            )}
          </>
        )}
        {progress && installResult === null && (
          <div className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
            <Spinner size="sm" />
            {progress.message ?? progress.stage}
          </div>
        )}
        {installResult?.status === "agents-working" && (
          <div className="space-y-2">
            <p className="text-sm text-text-primary">
              {installResult.working === null
                ? "Daintree is running on the host and its agent activity can't be seen from here."
                : `The host reports ${installResult.working} working agent${installResult.working === 1 ? "" : "s"}.`}{" "}
              Nothing was changed.
            </p>
            <div className="flex gap-2">
              {installResult.working !== null && (
                <Button variant="outline" size="sm" onClick={() => startInstall("wait-for-idle")}>
                  Update when idle
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setConfirmProceed(true)}>
                Update now and end its terminals
              </Button>
            </div>
          </div>
        )}
        {installResult?.status === "needs-user-command" && (
          <div className="space-y-2">
            <HostCommand
              label="Run this on the host to install the package, then check again"
              command={installResult.command.command}
            />
          </div>
        )}
      </div>
    ) : null;
    if (installRunning) {
      primary = { label: "Installing", onClick: () => {}, disabled: true, loading: true };
      secondary = { label: "Stop", onClick: cancelInstall };
    } else if (installResult?.status === "needs-user-command") {
      primary = { label: "Check again", onClick: check, disabled: busy, loading: busy };
    } else if (plan?.kind === "up-to-date") {
      primary = { label: "Continue", onClick: () => setStep("enable") };
    } else if (plan?.kind === "install" && installResult?.status !== "agents-working") {
      primary = {
        label: probe?.install ? "Update host" : "Install on host",
        onClick: () => startInstall("refuse"),
        disabled: busy,
      };
    }
  } else if (step === "enable") {
    body = probe?.hostModeListening ? (
      <p className="text-sm text-text-primary">Host mode is on. This machine can connect.</p>
    ) : (
      <div className="space-y-2 text-sm">
        <p className="text-text-primary">Host mode is off on {name || target}.</p>
        <p className="text-text-secondary">
          {probe?.platform === "darwin"
            ? "Daintree can start it there in the logged-in session. If it has never run on that Mac, open it once at the machine: macOS asks to approve a first launch."
            : probe?.advice.hostModeUnit
              ? "Daintree can start its Host mode service there."
              : "Open Daintree on that machine and turn on “Allow this machine to be a host”. That also sets it to start at login."}
        </p>
      </div>
    );
    primary = probe?.hostModeListening
      ? { label: "Continue", onClick: () => setStep("advise") }
      : probe?.platform === "darwin" || probe?.advice.hostModeUnit
        ? { label: "Start Host mode", onClick: startHostMode, disabled: busy, loading: busy }
        : { label: "Check again", onClick: check, disabled: busy, loading: busy };
    secondary = probe?.hostModeListening
      ? { label: "Cancel", onClick: onClose }
      : { label: "Skip", onClick: () => setStep("advise") };
  } else {
    body = (
      <div className="space-y-4 text-sm">
        <div>
          <p className="font-medium text-text-primary">Sleep</p>
          <p className="text-text-secondary">
            {probe?.advice.sleepDisabled === true
              ? "The host is set not to sleep when idle."
              : probe?.advice.sleepObserved
                ? `Observed: ${probe.platform === "darwin" ? `sleep ${probe.advice.sleepObserved}` : `sleep.target ${probe.advice.sleepObserved}`}. A sleeping host drops its connection.`
                : "A sleeping host drops its connection."}
          </p>
        </div>
        <div>
          <p className="font-medium text-text-primary">Keychain</p>
          <p className="text-text-secondary">
            {probe?.platform === "linux"
              ? probe.advice.keyring === "running"
                ? "A keyring process was running for the SSH user when checked. Whether plugin secrets can be stored there is known once Host mode runs its own keyring check on that machine."
                : probe.advice.keyring === "not-running"
                  ? "No keyring process was seen running for the SSH user when checked. Host mode runs its own keyring check on that machine."
                  : "The host's keyring wasn't checked. Host mode runs its own keyring check on that machine."
              : "Plugin secrets live in the host's own keychain. Credentials aren't copied between machines: each host signs in for itself."}
          </p>
        </div>
        {probe?.platform === "linux" && probe.advice.linger === false && (
          <p className="text-text-secondary">
            Lingering is off, so the Host mode service stops when you log out there.
          </p>
        )}
        {isMac() && (
          <div>
            <p className="font-medium text-text-primary">Local network</p>
            <p className="text-text-secondary">
              macOS may ask whether Daintree can find devices on your local network. Allow it to
              reach hosts on your LAN; tailnet hosts work either way.
            </p>
          </div>
        )}
        {(probe?.suggestedCommands ?? []).map((c) => (
          <HostCommand key={c.command} label={c.label} command={c.command} />
        ))}
      </div>
    );
    primary = {
      label: existing ? "Done" : "Add host",
      onClick: finish,
      disabled: busy,
      loading: busy,
    };
  }

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="md" data-testid="add-host-dialog">
      <AppDialog.Header>
        <AppDialog.Title>{existing ? `Update ${existing.name}` : "Add host"}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <StepBar current={step} />
        {body}
        {error && <ErrorLine message={error} />}
      </AppDialog.Body>
      <AppDialog.Footer primaryAction={primary} secondaryAction={secondary} />
      <ConfirmDialog
        isOpen={confirmProceed}
        onClose={() => setConfirmProceed(false)}
        zIndex="nested"
        variant="destructive"
        title={`Update '${hostLabel}' now?`}
        description={`Daintree on ${hostLabel} restarts to update. Every terminal there ends, and the agents working in them stop mid-task.`}
        confirmLabel="Update and end terminals"
        onConfirm={() => {
          setConfirmProceed(false);
          startInstall("proceed");
        }}
      />
    </AppDialog>
  );
}
