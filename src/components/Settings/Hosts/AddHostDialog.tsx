import { useEffect, useRef, useState } from "react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { isMac } from "@/lib/platform";
import { remoteHostsClient } from "@/clients/remoteHostsClient";
import { remoteConnectionKind } from "@/lib/remoteHosts";
import { mintOperationId } from "@/clients/operationsClient";
import { useRemoteHostsStore } from "@/store/remoteHostsStore";
import { clientErrorText, isClientAppError } from "@/utils/clientAppError";
import { safeFireAndForget } from "@/utils/safeFireAndForget";
import {
  formatHostConnection,
  isReservedHostName,
  sameHostAccount,
  sameHostMachine,
  sameHostName,
  sshConnection,
  sshTargetOf,
  wslConnection,
  wslDistroOf,
  type HostConnection,
  type HostConnectionState,
  type HostId,
  type HostListEntry,
  type OperationId,
} from "@shared/types/remoteHosts";
import type {
  DiscoveredHost,
  HostInstallPlan,
  HostProbeResult,
  HostRestartImpact,
  InstallHostPayload,
  InstallHostResult,
  LinuxPackagePreference,
} from "@shared/types/ipc/remoteHosts";
import { HostCommand } from "./HostCommand";
import {
  awaitFirstConnect,
  requestHostCopySettings,
  takeFirstConnect,
} from "./hostCopySettingsRequests";
import {
  buildMatchLabel,
  stagedUpdateLabel,
  defaultHostName,
  deliveryLabel,
  localNameSuggestion,
  shellWord,
  sshRefusalAdvice,
  hostModeSwitchedOn,
  installLabel,
  platformLabel,
  canWaitForIdle,
  restartConfirmLabel,
  restartImpactLines,
  restartTerminalCount,
  SSH_TARGET_HINT,
} from "./hostLabels";
import { pluralize } from "@/lib/pluralize";

type Step = "discover" | "check" | "install" | "enable" | "advise";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "discover", label: "Find" },
  { id: "check", label: "Check" },
  { id: "install", label: "Install" },
  { id: "enable", label: "Enable" },
  { id: "advise", label: "Advise" },
];

/**
 * Machines not yet added first, then WSL's default distro, then by name as
 * people number them (studio-2 before studio-10).
 */
function sortDiscovered(found: DiscoveredHost[]): DiscoveredHost[] {
  return [...found].sort(
    (a, b) =>
      Number(a.alreadyAdded) - Number(b.alreadyAdded) ||
      Number(b.wsl?.isDefault === true) - Number(a.wsl?.isDefault === true) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
}

const SOURCE_LABEL: Record<DiscoveredHost["source"], string> = {
  tailscale: "Tailnet",
  netbird: "NetBird",
  bonjour: "Local network",
  manual: "Entered",
  wsl: "WSL",
};

/** What the dialog's one field holds for a connection: an ssh target, or a WSL distro. */
function addressOf(connection: HostConnection): string {
  return sshTargetOf(connection) ?? wslDistroOf(connection) ?? "";
}

/** A distro name as typed in a command line: quoted when it holds a space. */
function wslCommandArg(distro: string): string {
  return distro.includes(" ") ? `"${distro}"` : distro;
}

/** A distro that can't run a Host, in words; null when it can. */
function wslRefusal(host: DiscoveredHost): string | null {
  return host.wsl && host.wsl.version !== 2 ? "WSL 1 can't run Daintree" : null;
}

interface AddHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** Update an existing host: start at the check with its target filled in. */
  existing?: { hostId: HostId; name: string; connection: HostConnection } | null;
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

/** Why a name can't be a host's, said before anything is installed or switched on there. */
function nameProblem(name: string, others: HostListEntry[]): string | null {
  if (!name) return null;
  if (isReservedHostName(name)) return `"${name}" is what Daintree calls this machine`;
  const clash = others.find((host) => sameHostName(host.descriptor.name, name));
  return clash ? `Another host is already called "${clash.descriptor.name}"` : null;
}

type SavedHost = { hostId: HostId; name: string };

/** How setup ended: what the link reported once it settled, or that Host mode was skipped. */
type Outcome = HostConnectionState | "skipped";

function isUsable(state: HostConnectionState): boolean {
  return state.status === "connected" || state.status === "driven-elsewhere";
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
  // On Windows a host is a WSL distro on this PC; elsewhere a machine reached over ssh.
  // An existing host keeps its own kind: its address is never read as another kind's.
  const viaWsl = (existing?.connection.kind ?? remoteConnectionKind()) === "wsl";
  const makeConnection = (address: string) =>
    viaWsl ? wslConnection(address) : sshConnection(address);
  const [target, setTarget] = useState(existing ? addressOf(existing.connection) : "");
  // What this dialog adds or updates.
  const connectionFor = () => makeConnection(target.trim());
  const [name, setName] = useState(existing?.name ?? "");
  const [probe, setProbe] = useState<HostProbeResult | null>(null);
  const [plan, setPlan] = useState<HostInstallPlan | null>(null);
  // The AppImage is the Linux build the release feed publishes a checksum for.
  const [linuxPackage, setLinuxPackage] = useState<LinuxPackagePreference>("appimage");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opId, setOpId] = useState<OperationId | null>(null);
  const [installResult, setInstallResult] = useState<InstallHostResult | null>(null);
  const [confirmProceed, setConfirmProceed] = useState(false);
  /** Installing the update the host downloaded itself, rather than this machine's build. */
  const [applying, setApplying] = useState<{ version: string } | null>(null);
  /** The user chose to put this machine's older build over the host's newer one. */
  const [downgrading, setDowngrading] = useState(false);
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);
  /** Linux: the host refused `loginctl enable-linger`, in its words. */
  const [lingerRefused, setLingerRefused] = useState<string | null>(null);
  /**
   * In the host list from the moment Host mode is on there: closing the dialog
   * after that leaves a record of the host, never Host mode on with none.
   */
  const [saved, setSaved] = useState<SavedHost | null>(null);
  const saving = useRef<Promise<SavedHost> | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Enable was skipped: setup ends saved but not connected. */
  const [skipped, setSkipped] = useState(false);
  const install = useRemoteHostsStore((s) => (opId ? (s.installs[opId] ?? null) : null));
  const knownHosts = useRemoteHostsStore((s) => s.hosts);
  const discovering = !existing && discovered === null && discoverError === null;
  const showDiscovering = useDeferredLoading(discovering, UI_DOHERTY_THRESHOLD);

  useEffect(() => {
    if (!isOpen || existing) return;
    let live = true;
    remoteHostsClient.discover().then(
      (found) => {
        if (live) setDiscovered(sortDiscovered(found));
      },
      (err: unknown) => {
        if (live) setDiscoverError(clientErrorText(err, "Discovery failed"));
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

  const hostLabel =
    existing?.name ?? saved?.name ?? (name.trim() || defaultHostName(target.trim()));
  const savedHost: SavedHost | null = existing
    ? { hostId: existing.hostId, name: existing.name }
    : saved;

  // Checked as it's typed, against the same rules the host list applies on save:
  // finding out at the end came after the app was copied and Host mode turned on.
  const others = knownHosts.filter((entry) => entry.descriptor.id !== existing?.hostId);
  const typed = target.trim() ? makeConnection(target.trim()) : null;
  const nameError = existing || saved || !typed ? null : nameProblem(hostLabel, others);
  const duplicate =
    existing || saved || !typed
      ? null
      : (others.find((entry) => sameHostAccount(entry.descriptor.connection, typed)) ?? null);
  // Another account on a machine already added is a host of its own: a warning, not a block.
  const sameMachine =
    existing || !typed || duplicate
      ? null
      : (others.find((entry) => sameHostMachine(entry.descriptor.connection, typed)) ?? null);

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
        setError(
          isClientAppError(err) && err.userMessage
            ? err.userMessage
            : clientErrorText(err, "Something went wrong")
        );
      }
    );
  };

  /** Add the host to the list once; every later step reuses that record. */
  const save = (): Promise<SavedHost> => {
    if (savedHost) return Promise.resolve(savedHost);
    saving.current ??= remoteHostsClient.add({ name: hostLabel, connection: connectionFor() }).then(
      (descriptor) => {
        const record = { hostId: descriptor.id, name: descriptor.name };
        setSaved(record);
        awaitFirstConnect(descriptor.id);
        return record;
      },
      (err: unknown) => {
        saving.current = null;
        throw err;
      }
    );
    return saving.current;
  };

  /** On to Enable; a host already switched on there is saved now. */
  const toEnable = (seen: HostProbeResult | null) => {
    setStep("enable");
    if (hostModeSwitchedOn(seen)) run(save, () => {});
  };

  const check = (nextTarget?: string) => {
    if (nextTarget !== undefined) setTarget(nextTarget);
    const connection = nextTarget !== undefined ? makeConnection(nextTarget) : connectionFor();
    run(
      () => remoteHostsClient.probe(connection),
      (result) => {
        setProbe(result);
        setLinuxPackage(result.install?.packaging === "deb" ? "deb" : "appimage");
        setApplying(null);
        setDowngrading(false);
        setInstallResult(null);
        setStep("check");
      }
    );
  };

  const loadPlan = (pkg: LinuxPackagePreference, downgrade = downgrading) =>
    run(
      () =>
        remoteHostsClient.planInstall({
          connection: connectionFor(),
          linuxPackage: pkg,
          ...(downgrade ? { allowDowngrade: true } : {}),
        }),
      (next) => {
        setPlan(next);
        setApplying(null);
        setInstallResult(null);
        setStep("install");
      }
    );

  const startInstall = (
    whileWorking: InstallHostPayload["whileWorking"],
    confirmed?: HostRestartImpact,
    staged = applying
  ) => {
    const id = mintOperationId();
    useRemoteHostsStore.getState().trackInstall(id, connectionFor());
    setOpId(id);
    // A refusal from an earlier attempt says nothing about this one.
    setInstallResult(null);
    run(
      () =>
        remoteHostsClient.install({
          opId: id,
          connection: connectionFor(),
          hostId: savedHost?.hostId,
          linuxPackage: probe?.platform === "linux" ? linuxPackage : undefined,
          whileWorking,
          ...(confirmed ? { confirmed } : {}),
          ...(staged ? { applyStaged: staged } : {}),
          ...(!staged && plan?.downgrade ? { allowDowngrade: true } : {}),
        }),
      (result) => {
        setInstallResult(result);
        if (
          result.status === "installed" ||
          result.status === "up-to-date" ||
          result.status === "staged-applied"
        ) {
          setProbe(result.probe);
          toEnable(result.probe);
        }
      }
    );
  };

  /** Install what the host downloaded for itself, by restarting it, behind the same confirmation. */
  const startApply = (version: string) => {
    const staged = { version };
    setApplying(staged);
    setPlan(null);
    setInstallResult(null);
    setStep("install");
    startInstall("refuse", undefined, staged);
  };

  // This machine's own updater says what it found, as from its menu.
  const updateThisMachine = () => {
    safeFireAndForget(window.electron.update.checkForUpdates(), {
      context: "Checking for an update to match a newer host",
    });
  };

  const startHostMode = () =>
    run(
      () => remoteHostsClient.startHostMode(connectionFor()),
      (result) => {
        setProbe(result.probe);
        setLingerRefused(result.lingerRefused);
        // Host mode is on there now: the host is saved before anything else can
        // go wrong. A failed save is its own error, never a reason to switch it on again.
        if (hostModeSwitchedOn(result.probe)) run(save, () => {});
      }
    );

  /** Connect and end on what the link reported, not on the dial having started. */
  const connectSaved = (host: SavedHost) =>
    run(
      () => remoteHostsClient.connectAndSettle(host.hostId),
      (state) => {
        if (!isUsable(state)) {
          setOutcome(state);
          return;
        }
        onClose();
        // A host's first connection, once: offer to copy this machine's
        // settings so it doesn't start from defaults.
        if (takeFirstConnect(host.hostId)) requestHostCopySettings(host.hostId);
      }
    );

  const finish = () => {
    if (existing) {
      onClose();
      return;
    }
    run(save, (host) => {
      if (skipped || !probe?.hostModeListening) setOutcome("skipped");
      else connectSaved(host);
    });
  };

  const cancelInstall = () => {
    if (opId) void remoteHostsClient.cancelInstall(opId);
  };

  const installRunning = busy && step === "install" && opId !== null;
  // Work that changes the host settles with the dialog in view: closing it left
  // an install or Host mode setup running with nothing to say how it ended.
  const locked = busy && (step === "install" || step === "enable" || step === "advise");

  // A restart for a downgrade is named as one, wherever it is confirmed.
  const restartVerb: "Update" | "Downgrade" = !applying && plan?.downgrade ? "Downgrade" : "Update";

  let primary: DialogAction | undefined;
  // Once the host is saved, closing keeps it: nothing is cancelled any more.
  let secondary: DialogAction | undefined =
    saved && !existing
      ? { label: "Close", onClick: onClose, disabled: locked }
      : { label: "Cancel", onClick: onClose, disabled: locked };
  let leading: DialogAction | undefined;
  let body: React.ReactNode;

  if (outcome && savedHost) {
    const close: DialogAction = { label: "Close", onClick: onClose, disabled: busy };
    if (outcome === "skipped") {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">Saved, not connected</p>
          <p className="text-text-secondary">
            {savedHost.name} is in your host list. Host mode isn&apos;t on there, so this machine
            can&apos;t connect yet. Set it up from its details in Settings → Hosts.
          </p>
        </div>
      );
      primary = { label: "Close", onClick: onClose };
      secondary = undefined;
    } else if (outcome.status === "unreachable" && outcome.hostModeOff) {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">
            {savedHost.name} is saved, but Host mode is off there
          </p>
          <p className="text-text-secondary">
            {viaWsl ? "The distribution started" : "SSH reached it"}, and Daintree isn&apos;t
            running in Host mode there. Set it up to connect.
          </p>
        </div>
      );
      primary = {
        label: "Set up…",
        onClick: () => {
          setOutcome(null);
          setSkipped(false);
          // Checked again: the probe that said Host mode was on is what the link just contradicted.
          check();
        },
        disabled: busy,
      };
      secondary = close;
    } else if (outcome.status === "version-mismatch") {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">
            {savedHost.name} is saved, but needs a compatible Daintree build
          </p>
          <p className="text-text-secondary">
            It runs a different build, so this machine can&apos;t connect until it&apos;s updated.
          </p>
        </div>
      );
      primary = {
        label: "Update…",
        onClick: () => {
          setOutcome(null);
          loadPlan(linuxPackage);
        },
        disabled: busy,
        loading: busy,
      };
      secondary = close;
    } else if (outcome.status === "unreachable") {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">Couldn&apos;t connect to {savedHost.name}</p>
          {outcome.detail && (
            <pre
              role="alert"
              className="whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text"
            >
              {outcome.detail}
            </pre>
          )}
          <p className="text-text-secondary">
            It stays in your host list, so you can connect now or later from Settings → Hosts.
          </p>
        </div>
      );
      primary = {
        label: "Retry",
        onClick: () => connectSaved(savedHost),
        disabled: busy,
        loading: busy,
      };
      secondary = close;
    } else if (outcome.status === "disconnected") {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">{savedHost.name} is saved, not connected</p>
          <p className="text-text-secondary">
            Its connection closed before it was up. It stays in your host list.
          </p>
        </div>
      );
      primary = {
        label: "Connect",
        onClick: () => connectSaved(savedHost),
        disabled: busy,
        loading: busy,
      };
      secondary = close;
    } else {
      body = (
        <div className="space-y-2 text-sm">
          <p className="font-medium text-text-primary">{savedHost.name} is saved</p>
          <p className="text-text-secondary">
            It&apos;s still connecting. Its status shows in Settings → Hosts.
          </p>
        </div>
      );
      primary = { label: "Close", onClick: onClose };
      secondary = undefined;
    }
  } else if (step === "discover" && viaWsl) {
    const picked = discovered?.find((host) => addressOf(host.connection) === target) ?? null;
    body = (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">WSL distributions</p>
          {discoverError !== null ? (
            <div className="flex items-start justify-between gap-3">
              <p role="alert" className="text-sm text-text-secondary select-text">
                Couldn&apos;t list WSL distributions: {discoverError}
              </p>
              <Button variant="outline" size="sm" onClick={retryDiscover}>
                Retry
              </Button>
            </div>
          ) : discovered === null ? (
            <p
              className={cn(
                "flex items-center gap-2 text-sm text-text-secondary",
                !showDiscovering && "invisible"
              )}
              aria-hidden={!showDiscovering}
            >
              <Spinner size="sm" /> Listing WSL distributions
            </p>
          ) : discovered.length === 0 ? (
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-text-secondary select-text">
                No WSL distributions are installed. Install one with <code>wsl --install</code>,
                then look again.
              </p>
              <Button variant="outline" size="sm" onClick={retryDiscover}>
                Look again
              </Button>
            </div>
          ) : (
            <ul
              className="divide-y divide-border-subtle rounded-[var(--radius-lg)] border border-border-default"
              data-testid="add-host-wsl-distros"
            >
              {discovered.map((host) => {
                const refusal = wslRefusal(host);
                const address = addressOf(host.connection);
                return (
                  <li key={address}>
                    <button
                      type="button"
                      disabled={host.alreadyAdded || refusal !== null || busy}
                      aria-pressed={target === address}
                      onClick={() => {
                        setTarget(address);
                        setName(host.name);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
                        "hover:bg-overlay-soft disabled:cursor-default disabled:hover:bg-transparent",
                        target === address && "bg-overlay-subtle"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-text-primary">
                          {host.name}
                        </span>
                        <span className="block truncate text-xs text-text-secondary">
                          {host.wsl?.version ? `WSL ${host.wsl.version}` : "WSL"}
                          {host.wsl?.isDefault ? " · Default" : ""}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs text-text-secondary">
                        {host.alreadyAdded ? "Added" : (refusal ?? "")}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {discovered !== null && discovered.length > 0 && (
            <p className="mt-2 text-xs text-text-secondary">
              Projects, terminals and agents run inside the distribution you pick, with its own git
              and tools. Whether Daintree is ready there is checked next.
            </p>
          )}
        </div>
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            placeholder={target || "Ubuntu"}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && <FieldError>{nameError}</FieldError>}
        </Field>
      </div>
    );
    primary = {
      label: "Check distribution",
      onClick: () => check(),
      disabled:
        busy ||
        picked === null ||
        picked.alreadyAdded ||
        wslRefusal(picked) !== null ||
        nameError !== null ||
        duplicate !== null,
      loading: busy,
    };
  } else if (step === "discover") {
    body = (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">Machines found</p>
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
            // Holds its line from the start, so the heading never stands alone and nothing jumps when it shows.
            <p
              className={cn(
                "flex items-center gap-2 text-sm text-text-secondary",
                !showDiscovering && "invisible"
              )}
              aria-hidden={!showDiscovering}
            >
              <Spinner size="sm" /> Looking for Macs and Linux machines
            </p>
          ) : discovered.length === 0 ? (
            <p className="text-sm text-text-secondary">
              No machines answered on your tailnet or local network. Enter an SSH target below.
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-[var(--radius-lg)] border border-border-default">
              {discovered.map((host) => (
                <li key={`${host.source}:${formatHostConnection(host.connection)}`}>
                  <button
                    type="button"
                    disabled={host.alreadyAdded || busy}
                    data-known-machine={host.knownMachine && !host.alreadyAdded ? "" : undefined}
                    aria-pressed={target === sshTargetOf(host.connection)}
                    onClick={() => {
                      setTarget(sshTargetOf(host.connection) ?? "");
                      setName(host.name);
                    }}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left",
                      "hover:bg-overlay-soft disabled:cursor-default disabled:hover:bg-transparent",
                      target === sshTargetOf(host.connection) && "bg-overlay-subtle"
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-text-primary">
                        {host.name}
                      </span>
                      <span className="block truncate text-xs text-text-secondary">
                        {formatHostConnection(host.connection)} ·{" "}
                        {platformLabel(host.platform, null)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-text-secondary">
                      {host.alreadyAdded
                        ? "Added"
                        : host.knownMachine
                          ? "Added as another account"
                          : SOURCE_LABEL[host.source]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {discovered !== null && discovered.length > 0 && (
            <p className="mt-2 text-xs text-text-secondary">
              Pick one to fill in its SSH target, or enter one below. Whether Daintree is ready
              there is checked next.
            </p>
          )}
        </div>
        <Field>
          <FieldLabel>SSH target</FieldLabel>
          <Input
            value={target}
            placeholder="user@devbox.local"
            disabled={busy}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setTarget(e.target.value)}
          />
          <FieldDescription>{SSH_TARGET_HINT}</FieldDescription>
          {duplicate && (
            <FieldError>
              {formatHostConnection(typed!)} is already in your host list as &quot;
              {duplicate.descriptor.name}&quot;
            </FieldError>
          )}
        </Field>
        {sameMachine && (
          <p className="text-xs text-text-secondary" data-testid="add-host-same-machine">
            &quot;{sameMachine.descriptor.name}&quot; already reaches this machine as{" "}
            {formatHostConnection(sameMachine.descriptor.connection)}. This one is saved as a
            separate host.
          </p>
        )}
        <Field>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            placeholder={target ? defaultHostName(target) : "devbox"}
            onChange={(e) => setName(e.target.value)}
          />
          {nameError && <FieldError>{nameError}</FieldError>}
        </Field>
      </div>
    );
    primary = {
      label: "Check host",
      onClick: () => check(),
      disabled: busy || target.trim().length === 0 || nameError !== null || duplicate !== null,
      loading: busy,
    };
  } else if (step === "check") {
    // Setup starts a WSL distro's Host as a systemd user service, which has
    // nothing to run under without it; a Host already listening needs no setup.
    const noSystemd =
      viaWsl &&
      probe?.platform === "linux" &&
      probe.advice.systemd === false &&
      !probe.hostModeListening;
    const localSuggestion =
      // Only while adding: an existing host keeps its saved target, which a
      // reconnect after install or Host mode would still dial.
      !viaWsl && !existing && !saved && probe && !probe.reachable
        ? localNameSuggestion(target.trim(), probe.sshError)
        : null;
    const refusal = !viaWsl && probe && !probe.reachable ? sshRefusalAdvice(probe.sshError) : null;
    const hostNewer = probe?.reachable === true && probe.hostBuild?.order === "newer";
    // Quitting installs it, so Daintree can restart the host into it from here.
    const stagedHere =
      probe?.reachable === true && probe.hostModeListening && probe.stagedUpdate?.installsOnQuit
        ? probe.stagedUpdate
        : null;
    const canApply = stagedHere?.ready === true;
    // A host behind this machine that has the update already only needs to restart into it.
    const applyIsPrimary = stagedHere !== null && !hostNewer && probe?.matchesClient !== true;
    body = !probe ? (
      <p className="flex items-center gap-2 text-sm text-text-secondary">
        <Spinner size="sm" /> Checking {target}
      </p>
    ) : (
      <div>
        <Line
          label={viaWsl ? "WSL" : "SSH"}
          value={probe.reachable ? (viaWsl ? "Starts" : "Works") : "Didn't connect"}
        />
        {!probe.reachable && probe.sshError && (
          <pre className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text">
            {probe.sshError}
          </pre>
        )}
        {localSuggestion && (
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-text-secondary">
              On a local network, a machine usually answers by its .local name.
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => check(localSuggestion)}
            >
              Try {localSuggestion}
            </Button>
          </div>
        )}
        {probe.reachable && (
          <>
            <Line label="Platform" value={platformLabel(probe.platform, probe.arch)} />
            <Line label="Installed" value={installLabel(probe.install)} />
            {probe.install && <Line label="Matches this machine" value={buildMatchLabel(probe)} />}
            {probe.stagedUpdate && (
              <Line label="Downloaded update" value={stagedUpdateLabel(probe.stagedUpdate)} />
            )}
            <Line label="Host mode" value={probe.hostModeListening ? "Listening" : "Off"} />
            {hostNewer && (
              <div className="mt-3 space-y-2" data-testid="add-host-newer">
                <p className="text-sm text-text-primary">
                  {hostLabel} has Daintree {probe.hostBuild?.version ?? "a later release"}, which is
                  newer than this machine&apos;s build. Update this machine to match it.
                </p>
                <p className="text-xs text-text-secondary">
                  Installing this machine&apos;s build there instead is a downgrade: settings and
                  data the newer build saved may not open in an older one.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setDowngrading(true);
                    loadPlan(linuxPackage, true);
                  }}
                >
                  Downgrade {hostLabel}…
                </Button>
              </div>
            )}
            {probe.stagedUpdate && !probe.stagedUpdate.installsOnQuit && (
              <p className="mt-3 text-xs text-text-secondary">
                {hostLabel} installs it from Restart to update on its own screen, where the package
                install asks for an administrator password.
              </p>
            )}
            {canApply && !applyIsPrimary && (
              <div className="mt-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => startApply(probe.stagedUpdate!.version)}
                >
                  Install downloaded update
                </Button>
              </div>
            )}
            {noSystemd && (
              <div className="mt-3 space-y-2" data-testid="add-host-no-systemd">
                <p role="alert" className="text-xs text-status-error">
                  {viaWsl
                    ? `${target} runs without systemd, which Daintree's Host mode needs.`
                    : "This machine runs without systemd, which Daintree's Host mode needs on Linux."}
                </p>
                {viaWsl && (
                  <>
                    <p className="text-xs text-text-secondary">
                      Turn it on in that distribution&apos;s <code>/etc/wsl.conf</code> (a{" "}
                      <code>[boot]</code> section with <code>systemd=true</code>), then restart it
                      and check again.
                    </p>
                    <HostCommand
                      label="Restart the distribution"
                      command={`wsl --terminate ${wslCommandArg(target)}`}
                    />
                  </>
                )}
              </div>
            )}
          </>
        )}
        {!probe.reachable &&
          (viaWsl ? (
            <p className="mt-3 text-xs text-text-secondary">
              Daintree runs programs in the distribution with <code>wsl.exe</code>. Check that{" "}
              <code>wsl -d {wslCommandArg(target)}</code> opens a shell there.
            </p>
          ) : refusal ? (
            <div className="mt-3 space-y-2" data-testid="add-host-ssh-refusal">
              {refusal === "untrusted-host-key" && (
                <>
                  <p className="text-xs text-text-secondary">
                    ssh couldn&apos;t verify this machine&apos;s host key, and Daintree never
                    accepts one for you. If you recognise the machine, connect once in a terminal
                    and answer yes to trust it, then check again.
                  </p>
                  <HostCommand label="Connect once" command={`ssh ${shellWord(target.trim())}`} />
                </>
              )}
              {refusal === "changed-host-key" && (
                <p className="text-xs text-text-secondary">
                  ssh says this machine&apos;s host key differs from the one on file. If you
                  didn&apos;t expect that, stop here. If you did, remove the old entry from the
                  known_hosts line ssh named above, connect once in a terminal to trust the new key,
                  then check again.
                </p>
              )}
              {refusal === "login-refused" && (
                <>
                  <p className="text-xs text-text-secondary">
                    This machine refused the login, and Daintree can&apos;t type a password. Set up
                    key login so your own ssh gets in, then check again.
                  </p>
                  <HostCommand
                    label="Set up key login"
                    command={`ssh-copy-id ${shellWord(target.trim())}`}
                  />
                </>
              )}
            </div>
          ) : (
            <p className="mt-3 text-xs text-text-secondary">
              Daintree connects with your own ssh and never asks for a password. On a Mac, turn on
              Remote Login in System Settings → General → Sharing.
            </p>
          ))}
      </div>
    );
    if (probe && (!probe.reachable || noSystemd)) {
      primary = { label: "Check again", onClick: () => check(), disabled: busy, loading: busy };
    } else if (probe?.matchesClient === true) {
      primary = { label: "Continue", onClick: () => toEnable(probe), disabled: busy };
    } else if (probe && hostNewer) {
      primary = {
        label: "Update this machine",
        onClick: updateThisMachine,
        disabled: busy,
      };
      leading = { label: "Continue anyway", onClick: () => toEnable(probe), disabled: busy };
    } else if (probe && applyIsPrimary) {
      primary = canApply
        ? {
            label: "Install downloaded update",
            onClick: () => startApply(stagedHere!.version),
            disabled: busy,
          }
        : // Still being handed to macOS's updater: a restart now would install nothing.
          { label: "Check again", onClick: () => check(), disabled: busy, loading: busy };
      leading = { label: "Continue anyway", onClick: () => toEnable(probe), disabled: busy };
    } else if (probe) {
      primary = {
        label: probe.install ? "Plan update" : "Plan install",
        onClick: () => loadPlan(linuxPackage),
        disabled: busy,
        loading: busy,
      };
      // A different build still connects, best effort, with a warning.
      if (probe.install) {
        leading = { label: "Continue anyway", onClick: () => toEnable(probe), disabled: busy };
      }
    } else {
      primary = { label: "Check host", onClick: () => check(), disabled: busy, loading: busy };
    }
    // Not while a check runs: its result would land against an edited target.
    // Nor once saved: the record names this target, so it stays.
    if (!existing && !saved)
      secondary = { label: "Back", onClick: () => setStep("discover"), disabled: busy };
  } else if (step === "install") {
    const progress = install?.progress ?? null;
    body =
      plan || applying ? (
        <div className="space-y-3">
          {plan && probe?.platform === "linux" && (
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
          {applying ? (
            <p className="text-sm text-text-primary">
              Installs Daintree {applying.version}, which {hostLabel} already downloaded, by
              restarting Daintree there.
            </p>
          ) : !plan ? null : plan.kind === "host-newer" ? (
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">{plan.reason}</p>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setDowngrading(true);
                  loadPlan(linuxPackage, true);
                }}
              >
                Downgrade {hostLabel}…
              </Button>
            </div>
          ) : plan.kind === "unsupported" ? (
            <p className="text-sm text-text-secondary">{plan.reason}</p>
          ) : plan.kind === "up-to-date" ? (
            <p className="text-sm text-text-secondary">The host already runs this build.</p>
          ) : (
            <>
              {plan.downgrade ? (
                <div className="space-y-1" data-testid="add-host-downgrade">
                  <p className="text-sm text-text-primary">
                    Installs Daintree {plan.version}, the build running here, over the newer{" "}
                    {probe?.hostBuild?.version ?? "build"} on {hostLabel}: a downgrade.
                  </p>
                  <p className="text-xs text-text-secondary">
                    Settings and data the newer build saved may not open in this one.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-text-primary">
                  Installs Daintree {plan.version} — the exact build running here.
                </p>
              )}
              <p className="text-sm text-text-secondary">{deliveryLabel(plan)}.</p>
              {plan.packaging === "deb" && (
                <p className="text-xs text-text-secondary">
                  The package needs sudo, so the last step is one command you run on the host.{" "}
                  {probe?.advice.fuse === false
                    ? "The AppImage installs without root; with no FUSE on the host, it runs unpacked."
                    : "The AppImage installs without root but needs FUSE."}
                </p>
              )}
              {plan.packaging === "appimage" && probe?.advice.fuse === false && (
                <p className="text-xs text-text-secondary">
                  No FUSE was found on {hostLabel}, so the AppImage runs unpacked each time it
                  starts, which makes starting slower.
                </p>
              )}
              {plan.restartsHost && (
                <p className="text-xs text-text-secondary">
                  Daintree is running there. Updating restarts it, which ends its terminals.
                </p>
              )}
            </>
          )}
          {installResult?.status === "host-newer" && (
            <p className="text-sm text-text-secondary">
              {hostLabel} now has a newer build than this machine, so nothing was installed. Check
              again to see it.
            </p>
          )}
          {progress && installResult === null && (
            <div className="flex items-center gap-2 text-sm text-text-secondary" aria-live="polite">
              <Spinner size="sm" />
              {progress.message ?? progress.stage}
            </div>
          )}
          {installResult?.status === "needs-confirmation" && (
            <div className="space-y-2" data-testid="host-restart-impact">
              <p className="text-sm text-text-primary">
                {restartVerb === "Downgrade" ? "Downgrading" : "Updating"} restarts Daintree on{" "}
                {hostLabel}, which ends:
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-text-secondary">
                {restartImpactLines(installResult.impact).map((line, index) => (
                  <li key={`${index}:${line}`}>{line}</li>
                ))}
              </ul>
              <p className="text-xs text-text-secondary">
                Nothing was changed. Agent states are observed, so one shown idle may still be busy.
              </p>
              <div className="flex gap-2">
                {canWaitForIdle(installResult.impact) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startInstall("wait-for-idle", installResult.impact)}
                  >
                    {restartVerb} when idle
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={() => setConfirmProceed(true)}>
                  {restartVerb} now…
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
      // The one way out while it runs: the dialog stays until the stop settles.
      secondary = { label: "Stop", onClick: cancelInstall };
    } else if (
      installResult?.status === "needs-user-command" ||
      installResult?.status === "host-newer" ||
      // An install of what the host downloaded that stopped: what is there now decides what's next.
      (applying && installResult?.status !== "needs-confirmation")
    ) {
      primary = { label: "Check again", onClick: () => check(), disabled: busy, loading: busy };
    } else if (plan?.kind === "up-to-date") {
      primary = { label: "Continue", onClick: () => toEnable(probe), disabled: busy };
    } else if (plan?.kind === "unsupported") {
      // What stopped it (a download waiting there, AppImages to sort out) is fixed at the host.
      primary = { label: "Check again", onClick: () => check(), disabled: busy, loading: busy };
    } else if (plan?.kind === "host-newer") {
      primary = {
        label: "Update this machine",
        onClick: updateThisMachine,
        disabled: busy,
      };
      leading = { label: "Check again", onClick: () => check(), disabled: busy };
    } else if (plan?.kind === "install" && installResult?.status !== "needs-confirmation") {
      // An attempt that failed may have failed on what changed at the host.
      if (error) leading = { label: "Check again", onClick: () => check(), disabled: busy };
      primary = plan.downgrade
        ? {
            label: `Downgrade ${hostLabel}…`,
            onClick: () => setConfirmDowngrade(true),
            disabled: busy,
          }
        : {
            label: probe?.install ? "Update host" : "Install on host",
            onClick: () => startInstall("refuse"),
            disabled: busy,
          };
    }
  } else if (step === "enable") {
    const switchedOn = hostModeSwitchedOn(probe);
    body = switchedOn ? (
      <p className="text-sm text-text-primary">
        Host mode is on at {hostLabel} and starts {viaWsl ? "with it" : "at login there"}. This
        machine can connect.
      </p>
    ) : (
      <div className="space-y-2 text-sm">
        <p className="text-text-primary">
          {probe?.hostModeListening
            ? `Host mode is listening on ${hostLabel} for now, but isn't switched on there, so it stops when Daintree quits.`
            : `Host mode is off on ${hostLabel}.`}
        </p>
        <p className="text-text-secondary">
          {probe?.platform === "darwin"
            ? "Daintree turns on Host mode there in the logged-in session and sets it to start at login. If it has never run on that Mac, open it once at the machine: macOS asks to approve a first launch."
            : viaWsl
              ? "Daintree installs its Host mode service there (a systemd user unit), starts it, and turns on Host mode, so it starts whenever the distribution does."
              : "Daintree installs its Host mode service there (a systemd user unit), starts it, and turns on Host mode with start at login. It also asks the host to let the service run after you log out."}
        </p>
      </div>
    );
    primary = switchedOn
      ? { label: "Continue", onClick: () => setStep("advise") }
      : { label: "Turn on Host mode", onClick: startHostMode, disabled: busy, loading: busy };
    if (!switchedOn) {
      secondary = {
        label: "Skip",
        onClick: () => {
          setSkipped(true);
          setStep("advise");
        },
        disabled: busy,
      };
    }
  } else {
    body = (
      <div className="space-y-4 text-sm">
        {viaWsl ? (
          <div>
            <p className="font-medium text-text-primary">Running</p>
            <p className="text-text-secondary">
              Daintree keeps {hostLabel} running while it&apos;s open on this PC. After you quit,
              WSL stops it about 15 seconds after nothing else is using it, and its terminals and
              agents stop with it.
            </p>
          </div>
        ) : (
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
        )}
        <div>
          <p className="font-medium text-text-primary">Keychain</p>
          <p className="text-text-secondary">
            {probe?.hostModeState?.keychain.checked
              ? `Checked by Daintree on ${hostLabel}: ${probe.hostModeState.keychain.detail}.`
              : probe?.platform === "linux"
                ? probe.advice.keyring === "running"
                  ? `A keyring process was running for the ${viaWsl ? "distribution's" : "SSH"} user when checked. Whether plugin secrets can be stored there is known once Host mode runs its own keyring check on that machine.`
                  : probe.advice.keyring === "not-running"
                    ? `No keyring process was seen running for the ${viaWsl ? "distribution's" : "SSH"} user when checked. Host mode runs its own keyring check on that machine.`
                    : "The host's keyring wasn't checked. Host mode runs its own keyring check on that machine."
                : "Plugin secrets live in the host's own keychain. Credentials aren't copied between machines: each host signs in for itself."}
          </p>
        </div>
        {lingerRefused !== null ? (
          <div>
            <p className="font-medium text-text-primary">Running after logout</p>
            <p className="text-text-secondary">
              Daintree asked {hostLabel} to let its Host mode service run with nobody logged in
              (loginctl enable-linger), and the host refused:
            </p>
            <pre className="mt-1 whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text">
              {lingerRefused}
            </pre>
            <p className="text-text-secondary">
              Until someone allowed to runs the command below there, the service stops when the last
              login session on {hostLabel} ends.
            </p>
          </div>
        ) : (
          probe?.platform === "linux" &&
          probe.advice.linger === false && (
            <p className="text-text-secondary">
              Lingering is off, so the Host mode service stops when you log out there.
            </p>
          )
        )}
        {(isMac() || probe?.platform === "darwin") && (
          <div>
            <p className="font-medium text-text-primary">Local network</p>
            {isMac() && (
              <p className="text-text-secondary">
                macOS may ask whether Daintree can find devices on your local network. Whether a
                connection needs it depends on how macOS routes to that host, not on its address, so
                allow it if you use hosts on your network. If it&apos;s denied, connections macOS
                treats as local fail until Daintree is turned on in System Settings → Privacy &amp;
                Security → Local Network.
              </p>
            )}
            {probe?.platform === "darwin" && (
              <p className="text-text-secondary">
                {hostLabel} asks the same on its own screen, for everything its terminals and agents
                run. Until someone allows Daintree there, or turns it on in that Mac&apos;s Local
                Network settings, they can&apos;t reach other machines on your network, and names
                like .local can take half a minute to look up.
              </p>
            )}
          </div>
        )}
        {(probe?.suggestedCommands ?? []).map((c) => (
          <HostCommand key={c.command} label={c.label} command={c.command} />
        ))}
      </div>
    );
    primary = {
      label: existing || saved ? "Done" : "Add host",
      onClick: finish,
      disabled: busy,
      loading: busy,
    };
  }

  const confirmImpact =
    installResult?.status === "needs-confirmation" ? installResult.impact : null;
  const confirmTerminals = confirmImpact ? restartTerminalCount(confirmImpact) : null;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      dismissible={!locked}
      size="md"
      data-testid="add-host-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>{existing ? `Update ${existing.name}` : "Add host"}</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        <StepBar current={step} />
        {body}
        {saved && !existing && !outcome && (
          <p className="mt-3 text-xs text-text-secondary">
            {saved.name} is saved in your host list. Closing leaves it there.
          </p>
        )}
        {error && <ErrorLine message={error} />}
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={primary}
        secondaryAction={secondary}
        leadingAction={leading}
      />
      <ConfirmDialog
        isOpen={confirmProceed && confirmImpact !== null}
        onClose={() => setConfirmProceed(false)}
        zIndex="nested"
        variant="destructive"
        title={`${restartVerb} '${hostLabel}' now?`}
        description={
          confirmTerminals === null
            ? `Daintree on ${hostLabel} restarts to ${restartVerb.toLowerCase()}. Every terminal there ends, and any agent in one stops mid-task.`
            : confirmTerminals === 0
              ? `Daintree on ${hostLabel} restarts to ${restartVerb.toLowerCase()}, which ends everything listed. If anything new starts before the restart, the ${restartVerb.toLowerCase()} stops and asks again.`
              : `Daintree on ${hostLabel} restarts to ${restartVerb.toLowerCase()}. ${pluralize(confirmTerminals, "terminal")} there ${confirmTerminals === 1 ? "ends" : "end"}, and any agent in one stops mid-task. If anything new starts before the restart, the ${restartVerb.toLowerCase()} stops and asks again.`
        }
        confirmLabel={
          confirmImpact
            ? restartConfirmLabel(confirmImpact, restartVerb)
            : `${restartVerb} and end terminals`
        }
        onConfirm={() => {
          setConfirmProceed(false);
          if (confirmImpact) startInstall("proceed", confirmImpact);
        }}
      />
      <ConfirmDialog
        isOpen={confirmDowngrade && plan?.downgrade === true}
        onClose={() => setConfirmDowngrade(false)}
        zIndex="nested"
        variant="destructive"
        title={`Downgrade '${hostLabel}'?`}
        description={`Daintree on ${hostLabel} goes back from ${probe?.hostBuild?.version ?? "its newer build"} to ${plan?.version ?? "this machine's build"}. Settings and data the newer build saved may not open in the older one.`}
        confirmLabel="Downgrade host"
        onConfirm={() => {
          setConfirmDowngrade(false);
          startInstall("refuse");
        }}
      />
    </AppDialog>
  );
}
