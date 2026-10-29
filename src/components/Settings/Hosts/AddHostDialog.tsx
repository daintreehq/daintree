import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check } from "lucide-react";
import { AppDialog, type DialogAction } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/Callout";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { SearchField } from "@/components/ui/SearchField";
import { SegmentedRadioGroup } from "@/components/ui/SegmentedRadioGroup";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/utils";
import { SEVERITY_GLYPH } from "@/lib/statusSeverity";
import { UI_DOHERTY_THRESHOLD } from "@/lib/animationUtils";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { isMac } from "@/lib/platform";
import { appClient } from "@/clients/appClient";
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
  type OperationProgress,
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
import { SshRefusalHelp } from "./SshRefusalHelp";
import {
  awaitFirstConnect,
  requestHostCopySettings,
  takeFirstConnect,
} from "./hostCopySettingsRequests";
import {
  checkVerdict,
  installFailureLead,
  shortCommit,
  stagedUpdateLabel,
  defaultHostName,
  deliveryLabel,
  localNameSuggestion,
  namedProgressMessage,
  sshRefusalAdvice,
  hostModeSwitchedOn,
  installLabel,
  platformLabel,
  canWaitForIdle,
  restartConfirmLabel,
  restartImpactLines,
  verdictCopy,
  SSH_TARGET_HINT,
} from "./hostLabels";

type Step = "discover" | "check" | "install" | "enable" | "advise" | "done";

const STEPS: Array<{ id: Step; label: string }> = [
  { id: "discover", label: "Find" },
  { id: "check", label: "Check" },
  { id: "install", label: "Install" },
  { id: "enable", label: "Enable" },
  { id: "advise", label: "Advise" },
];

/**
 * Machines not yet added first, then WSL's default distro, then connected
 * peers ahead of idle ones, then by name as people number them (studio-2
 * before studio-10).
 */
function sortDiscovered(found: DiscoveredHost[]): DiscoveredHost[] {
  return [...found].sort(
    (a, b) =>
      Number(a.alreadyAdded) - Number(b.alreadyAdded) ||
      Number(b.wsl?.isDefault === true) - Number(a.wsl?.isDefault === true) ||
      Number(b.online) - Number(a.online) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
  );
}

/** Above this many machines the list gets a filter: a mesh can hold dozens of peers. */
const FILTER_THRESHOLD = 8;

function matchesQuery(host: DiscoveredHost, needle: string): boolean {
  return (
    host.name.toLowerCase().includes(needle) ||
    formatHostConnection(host.connection).toLowerCase().includes(needle)
  );
}

const SOURCE_LABEL: Record<DiscoveredHost["source"], string> = {
  tailscale: "Tailnet",
  netbird: "NetBird",
  bonjour: "Local network",
  manual: "Entered",
  wsl: "WSL",
};

function sourceLabel(host: DiscoveredHost): string {
  const label = SOURCE_LABEL[host.source];
  return host.netbirdStatus ? `${label} · ${host.netbirdStatus}` : label;
}

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
  /**
   * An existing host: checked as soon as the dialog opens. `intent` is why the
   * user came — "Set up…" (Host mode is off there) or "Check for update" — and
   * names the dialog.
   */
  existing?: {
    hostId: HostId;
    name: string;
    connection: HostConnection;
    intent?: "update" | "setup";
  } | null;
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

/** A screen's one headline: what was found or what is about to happen, naming the machine. */
function Verdict({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">{title}</h3>
      {children && (
        <div className="text-sm text-pretty text-text-secondary select-text">{children}</div>
      )}
    </div>
  );
}

/** What the check read off the machine: the detail under the verdict, never the lead. */
function ProbeSummary({
  probe,
  via,
  local,
}: {
  probe: HostProbeResult;
  via: string;
  local: string | null;
}) {
  const rows: Array<[string, string]> = [
    [via, probe.reachable ? "Works" : "Didn't connect"],
    ...(probe.reachable
      ? ([
          ["Platform", platformLabel(probe.platform, probe.arch)],
          ["Installed there", installLabel(probe.install)],
          ...(local ? [["This machine", `Daintree ${local}`]] : []),
          ...(probe.stagedUpdate
            ? [["Downloaded update", stagedUpdateLabel(probe.stagedUpdate)]]
            : []),
          ["Host mode", probe.hostModeListening ? "Listening" : "Off"],
        ] as Array<[string, string]>)
      : []),
  ];
  return (
    <dl
      className="mt-4 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 border-t border-border-subtle pt-3 text-xs"
      data-testid="add-host-summary"
    >
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-text-secondary">{label}</dt>
          <dd className="min-w-0 text-text-primary select-text [overflow-wrap:anywhere]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

type StageId = "prepare" | "wait" | "stop" | "install" | "start" | "reconnect";

const STAGE_ORDER: StageId[] = ["prepare", "wait", "stop", "install", "start", "reconnect"];

/** The installer's reported stages, grouped into the steps the dialog names. */
const STAGE_OF: Record<string, StageId> = {
  checking: "prepare",
  packing: "prepare",
  downloading: "prepare",
  copying: "prepare",
  verifying: "prepare",
  "waiting-for-idle": "wait",
  stopping: "stop",
  installing: "install",
  restarting: "start",
  reconnecting: "reconnect",
};

/**
 * The run's steps, done, current and to come, with the installer's own
 * words for the current one. A failed run keeps its list, marking where it
 * stopped.
 */
function InstallStages({
  stages,
  progress,
  host,
  failed,
  started,
  halted,
  applying,
}: {
  stages: Array<{ id: StageId; label: string }>;
  /** Installing what the host downloaded itself. */
  applying: boolean;
  progress: OperationProgress | null;
  host: string;
  failed: boolean;
  /** Past the loading gate: until then no step is marked current. */
  started: boolean;
  /** Stopped where it was, by the user: the step it reached shows without a spinner. */
  halted: boolean;
}) {
  const reported = progress?.stage ? STAGE_OF[progress.stage] : undefined;
  const current = started
    ? Math.max(
        0,
        stages.findIndex((stage) => stage.id === reported)
      )
    : -1;
  const detail = progress?.message ? namedProgressMessage(progress.message, host) : null;
  // Where the installer's words add to the step's: how the build travels, who
  // it's waiting on, a downloaded update the host installs itself. Elsewhere
  // they repeat the step.
  const detailed: StageId[] = ["prepare", "wait", ...(applying ? (["install"] as const) : [])];
  const ErrorGlyph = SEVERITY_GLYPH.error;
  return (
    <ol className="space-y-2" data-testid="host-install-stages">
      {stages.map((stage, index) => {
        const state =
          index < current
            ? "done"
            : index === current
              ? failed
                ? "failed"
                : halted
                  ? "halted"
                  : "current"
              : "upcoming";
        return (
          <li
            key={stage.id}
            className="flex items-start gap-2.5"
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {state === "done" ? (
                <Check className="size-3.5 text-text-secondary" aria-hidden="true" />
              ) : state === "current" ? (
                <Spinner size="sm" className="text-text-primary" />
              ) : state === "failed" ? (
                <ErrorGlyph className="size-3.5 text-status-error" aria-hidden="true" />
              ) : state === "halted" ? (
                <span className="size-2 rounded-none bg-text-secondary" aria-hidden="true" />
              ) : (
                <span className="size-1.5 rounded-full bg-text-secondary" aria-hidden="true" />
              )}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  "text-sm [overflow-wrap:anywhere]",
                  state === "current" || state === "failed" || state === "halted"
                    ? "font-medium text-text-primary"
                    : state === "done"
                      ? "text-text-primary"
                      : "text-text-secondary"
                )}
              >
                {stage.label}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </p>
              {state === "current" &&
                detail &&
                detailed.includes(stage.id) &&
                progress?.stage !== "copying" && (
                  <p className="text-xs text-text-secondary">{detail}</p>
                )}
            </div>
          </li>
        );
      })}
    </ol>
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
    <Callout severity="error" role="alert" className="mt-4 select-text">
      {message}
    </Callout>
  );
}

/** This machine's own updater, as far as it has said anything since "Update this machine". */
type LocalUpdate =
  | { phase: "checking" }
  | { phase: "quiet" }
  | { phase: "failed"; message: string }
  | { phase: "downloading"; version: string | null; percent: number | null }
  | { phase: "ready"; version: string };

/** How long a check of this machine's updater spins before it is said to be quiet. */
const LOCAL_UPDATE_QUIET_MS = 10_000;

/** What "Update this machine" led to, under the verdict that offered it. */
function LocalUpdateStatus({ update }: { update: LocalUpdate }) {
  const showSpinner = useDeferredLoading(update.phase === "checking", UI_DOHERTY_THRESHOLD);
  // Ready is the verdict itself, said by the headline above.
  if (update.phase === "ready") return null;
  if (update.phase === "failed") {
    return (
      <Callout
        severity="error"
        title="Couldn't check for an update to this machine"
        className="mt-4"
      >
        {update.message}
      </Callout>
    );
  }
  if (update.phase === "downloading") {
    const name = update.version ? `Daintree ${update.version}` : "the update";
    return (
      <div className="mt-4 space-y-2" role="status">
        <p className="flex items-center justify-between gap-3 text-sm text-text-secondary">
          <span>Downloading {name} to this machine</span>
          {update.percent !== null && (
            <span className="text-xs tabular-nums text-text-secondary">
              {Math.round(update.percent)}%
            </span>
          )}
        </p>
        <ProgressBar
          value={update.percent}
          label={`Downloading ${name} to this machine`}
          size="thin"
        />
        <p className="text-xs text-text-secondary">It keeps downloading if you close this.</p>
      </div>
    );
  }
  return (
    <div className="mt-4 space-y-1" role="status">
      <p className="flex items-center gap-2 text-sm text-text-primary">
        {update.phase === "checking" && (
          <Spinner size="sm" className={cn(!showSpinner && "invisible")} />
        )}
        {update.phase === "checking"
          ? "Checking for an update to this machine"
          : "This machine's updater hasn't reported an update yet"}
      </p>
      <p className={cn("text-xs text-text-secondary", update.phase === "checking" && "pl-5.5")}>
        {update.phase === "checking"
          ? "One it finds downloads here, with its progress."
          : "It keeps looking in the background. Its update notice appears once one has downloaded."}
      </p>
    </div>
  );
}

export function AddHostDialog({ isOpen, onClose, existing = null }: AddHostDialogProps) {
  const [step, setStep] = useState<Step>(existing ? "check" : "discover");
  const [discovered, setDiscovered] = useState<DiscoveredHost[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverAttempt, setDiscoverAttempt] = useState(0);
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const targetInputRef = useRef<HTMLInputElement>(null);
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
  /** How the last install was asked to treat running work; it decides whether waiting is a step. */
  const [installMode, setInstallMode] = useState<InstallHostPayload["whileWorking"] | null>(null);
  /** Why the last install stopped, in its own words; the run's steps stay on screen beside it. */
  const [installError, setInstallError] = useState<string | null>(null);
  /** It stopped because the user pressed Stop: an outcome they chose, not a failure. */
  const [installStopped, setInstallStopped] = useState(false);
  /** An install request is in flight: not any request, since a recheck runs on the same step. */
  const [installing, setInstalling] = useState(false);
  /** Installing the update the host downloaded itself, rather than this machine's build. */
  const [applying, setApplying] = useState<{ version: string } | null>(null);
  /** The user chose to put this machine's older build over the host's newer one. */
  const [downgrading, setDowngrading] = useState(false);
  const [localVersion, setLocalVersion] = useState<string | null>(null);
  const [localUpdate, setLocalUpdate] = useState<LocalUpdate | null>(null);
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
  // The package choice is disabled while it re-plans, which drops focus; it's
  // handed back to the chosen package once the plan settles.
  const packageGroup = useRef<HTMLDivElement>(null);
  const [refocusPackage, setRefocusPackage] = useState(false);

  const knownHosts = useRemoteHostsStore((s) => s.hosts);
  const discovering = !existing && discovered === null && discoverError === null;
  const showDiscovering = useDeferredLoading(discovering, UI_DOHERTY_THRESHOLD);
  // An existing host's first check, before there is anything to show.
  const checking = step === "check" && probe === null && busy;
  const showChecking = useDeferredLoading(checking, UI_DOHERTY_THRESHOLD);
  // The run's screen answers the press at once; its spinner and bar wait out
  // the gate, since a run that stops to ask comes back within it.
  const showRun = useDeferredLoading(installing && step === "install", UI_DOHERTY_THRESHOLD);

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

  // This machine's version, so a verdict can say which side is ahead in numbers.
  useEffect(() => {
    if (!isOpen) return;
    let live = true;
    Promise.resolve()
      .then(() => appClient.getVersionInfo())
      .then(
        (info) => {
          if (live) setLocalVersion(info.appVersion);
        },
        () => {}
      );
    return () => {
      live = false;
    };
  }, [isOpen]);

  // What this machine's updater says after "Update this machine": the dialog
  // reports it rather than leaving the press with nothing to show.
  const watchingLocal = localUpdate !== null;
  useEffect(() => {
    if (!watchingLocal) return;
    const update = window.electron.update;
    const offs = [
      update.onUpdateAvailable?.((info) =>
        setLocalUpdate((now) =>
          now?.phase === "ready"
            ? now
            : { phase: "downloading", version: info.version, percent: null }
        )
      ),
      update.onDownloadProgress?.((info) =>
        setLocalUpdate((now) =>
          now?.phase === "ready"
            ? now
            : {
                phase: "downloading",
                version: now?.phase === "downloading" ? now.version : null,
                percent: info.percent,
              }
        )
      ),
      update.onUpdateDownloaded?.((info) =>
        setLocalUpdate({ phase: "ready", version: info.version })
      ),
    ];
    // Nothing heard is not "nothing found": the updater only reports what it finds.
    const quiet = setTimeout(
      () => setLocalUpdate((now) => (now?.phase === "checking" ? { phase: "quiet" } : now)),
      LOCAL_UPDATE_QUIET_MS
    );
    return () => {
      clearTimeout(quiet);
      for (const off of offs) off?.();
    };
  }, [watchingLocal]);

  // Once the group is enabled again, after the commit that re-enables it.
  useEffect(() => {
    if (!refocusPackage || busy) return;
    setRefocusPackage(false);
    // Only focus that fell out with the disabled group: anyone who moved on keeps their place.
    if (document.activeElement && document.activeElement !== document.body) return;
    packageGroup.current
      ?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')
      ?.focus();
  }, [refocusPackage, busy]);

  const retryDiscover = () => {
    setDiscovered(null);
    setDiscoverError(null);
    setDiscoveryQuery("");
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

  const run = <T,>(
    work: () => Promise<T>,
    then: (value: T) => void,
    failed: (message: string, err: unknown) => void = (message) => setError(message)
  ) => {
    setBusy(true);
    setError(null);
    work().then(
      (value) => {
        setBusy(false);
        then(value);
      },
      (err: unknown) => {
        setBusy(false);
        failed(
          isClientAppError(err) && err.userMessage
            ? err.userMessage
            : clientErrorText(err, "Something went wrong"),
          err
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

  /**
   * On to Enable; a host already switched on there is saved now. An existing
   * host with Host mode on for good has nothing left to set up, so it ends on
   * what the update did.
   */
  const toEnable = (seen: HostProbeResult | null) => {
    if (existing && hostModeSwitchedOn(seen)) {
      setStep("done");
      return;
    }
    setStep("enable");
    if (hostModeSwitchedOn(seen)) run(save, () => {});
  };

  const check = (nextTarget?: string) => {
    if (nextTarget !== undefined) setTarget(nextTarget);
    // Asked from past the check (a failed or stopped run, a command handed
    // over): the screen becomes the check, not the run it came from.
    if (step === "install" || step === "done") {
      setStep("check");
      setProbe(null);
      setInstallResult(null);
      setInstallError(null);
    }
    const connection = nextTarget !== undefined ? makeConnection(nextTarget) : connectionFor();
    run(
      () => remoteHostsClient.probe(connection),
      (result) => {
        setProbe(result);
        setLinuxPackage(result.install?.packaging === "deb" ? "deb" : "appimage");
        setApplying(null);
        setDowngrading(false);
        setInstallResult(null);
        setInstallError(null);
        setStep("check");
      }
    );
  };

  // An existing host is checked as the dialog opens: its target is already known.
  const autoChecked = useRef(false);
  const checkOnOpen = useEffectEvent(() => check());
  const existingId = existing?.hostId ?? null;
  useEffect(() => {
    if (!isOpen || existingId === null || autoChecked.current) return;
    autoChecked.current = true;
    checkOnOpen();
  }, [isOpen, existingId]);

  const loadPlan = (
    pkg: LinuxPackagePreference,
    downgrade = downgrading,
    settled: () => void = () => {}
  ) =>
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
        settled();
      },
      (message) => {
        setError(message);
        settled();
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
    setInstallMode(whileWorking);
    // A refusal or failure from an earlier attempt says nothing about this one.
    setInstallResult(null);
    setInstallError(null);
    setInstalling(true);
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
        setInstalling(false);
        setInstallResult(result);
        if (
          result.status === "installed" ||
          result.status === "up-to-date" ||
          result.status === "staged-applied"
        ) {
          setProbe(result.probe);
          toEnable(result.probe);
        }
      },
      (message, err) => {
        setInstalling(false);
        setInstallError(message);
        setInstallStopped(isClientAppError(err) && err.code === "CANCELLED");
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

  // This machine's own updater looks, as from its menu; the dialog then says
  // what it reports, starting from a download already under way.
  const updateThisMachine = () => {
    setLocalUpdate({ phase: "checking" });
    window.electron.update.checkForUpdates().then(
      () => {},
      (err: unknown) =>
        setLocalUpdate({
          phase: "failed",
          message: clientErrorText(err, "This machine's updater didn't answer"),
        })
    );
    window.electron.update.getLatest?.().then(
      (latest) => {
        if (!latest) return;
        setLocalUpdate((now) =>
          now?.phase === "ready" || now?.phase === "downloading"
            ? now
            : latest.downloaded
              ? { phase: "ready", version: latest.version }
              : { phase: "downloading", version: latest.version, percent: null }
        );
      },
      () => {}
    );
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

  const installRunning = installing && step === "install";
  // Work that changes the host settles with the dialog in view: closing it left
  // an install or Host mode setup running with nothing to say how it ended.
  const locked = busy && (step === "install" || step === "enable" || step === "advise");

  // A restart for a downgrade is named as one, wherever it is confirmed.
  const restartVerb: "Update" | "Downgrade" = !applying && plan?.downgrade ? "Downgrade" : "Update";
  const verbing = applying
    ? "Installing the downloaded update"
    : restartVerb === "Downgrade"
      ? "Downgrading"
      : "Updating";
  // A button names the machine while the name fits one; the heading above it always does.
  const buttonHost = hostLabel.length <= 20 ? hostLabel : "host";
  const targetVersion = applying?.version ?? plan?.version ?? null;
  const fresh = !probe?.install;
  const runTitle = applying
    ? `Restarting ${hostLabel} into Daintree ${applying.version}`
    : plan?.downgrade
      ? `Downgrading ${hostLabel} to Daintree ${targetVersion}`
      : fresh
        ? `Installing Daintree ${targetVersion} on ${hostLabel}`
        : `Updating ${hostLabel} to Daintree ${targetVersion}`;
  const stoppedTitle = applying
    ? `Stopped restarting ${hostLabel}`
    : plan?.downgrade
      ? `Stopped downgrading ${hostLabel}`
      : fresh
        ? `Stopped installing Daintree on ${hostLabel}`
        : `Stopped updating ${hostLabel}`;
  const failedTitle = applying
    ? `Couldn't restart ${hostLabel} into Daintree ${applying.version}`
    : plan?.downgrade
      ? `Couldn't downgrade ${hostLabel}`
      : fresh
        ? `Couldn't install Daintree on ${hostLabel}`
        : `Couldn't update ${hostLabel}`;

  let primary: DialogAction | undefined;
  // Once the host is saved, closing keeps it: nothing is cancelled any more.
  let secondary: DialogAction | undefined =
    saved && !existing
      ? { label: "Close", onClick: onClose, disabled: locked }
      : { label: "Cancel", onClick: onClose, disabled: locked };
  let leading: DialogAction | undefined;
  let hint: string | undefined;
  let body: React.ReactNode;

  /**
   * The footer while the host is ahead: "Update this machine" until it's
   * pressed, then what this machine's updater has reached. A download carries
   * on after the dialog closes; a ready one restarts from here as from its
   * notice, where main asks first if anything would end.
   */
  const localFooter = (): {
    primary: DialogAction;
    secondary: DialogAction | undefined;
    offerDowngrade: boolean;
  } => {
    if (!localUpdate) {
      return {
        primary: { label: "Update this machine", onClick: updateThisMachine, disabled: busy },
        secondary,
        offerDowngrade: true,
      };
    }
    if (localUpdate.phase === "failed") {
      return {
        primary: { label: "Retry", onClick: updateThisMachine },
        secondary: { label: "Close", onClick: onClose },
        offerDowngrade: true,
      };
    }
    if (localUpdate.phase === "ready") {
      return {
        primary: {
          label: "Restart to update",
          onClick: () =>
            safeFireAndForget(window.electron.update.quitAndInstall(), {
              context: "Restarting this machine into its update to match a newer host",
            }),
        },
        secondary: { label: "Later", onClick: onClose },
        offerDowngrade: false,
      };
    }
    return {
      primary: { label: "Close", onClick: onClose },
      secondary: undefined,
      // Downloading is the way forward; only an updater that found nothing leaves the downgrade.
      offerDowngrade: localUpdate.phase !== "downloading",
    };
  };
  // Said once per screen, politely: the verdict or outcome the user was waiting for.
  let announce = "";
  // A new screen hands focus to its answer: the primary, or Cancel where the
  // answer ends someone's work.
  let screen: string = step;
  let focusCancel = false;

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
    const query = discoveryQuery.trim();
    const needle = query.toLowerCase();
    const filterable = discovered !== null && discovered.length > FILTER_THRESHOLD;
    const shown =
      discovered === null
        ? []
        : needle
          ? discovered.filter((host) => matchesQuery(host, needle))
          : discovered;
    const pick = (host: DiscoveredHost) => {
      setTarget(sshTargetOf(host.connection) ?? "");
      setName(host.name);
    };
    const pickOnlyMatch = (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
      const only = shown.length === 1 ? shown[0]! : null;
      if (!only || only.alreadyAdded || busy) return;
      event.preventDefault();
      pick(only);
      targetInputRef.current?.focus();
    };
    body = (
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium text-text-primary">Machines found</p>
          {filterable && (
            <SearchField
              fieldClassName="mb-2"
              value={discoveryQuery}
              onChange={(e) => setDiscoveryQuery(e.target.value)}
              onClear={() => setDiscoveryQuery("")}
              onKeyDown={pickOnlyMatch}
              // It mounts when the results arrive; a target already being typed keeps the keyboard.
              autoFocus={target.trim() === ""}
              placeholder="Filter by name or address"
              aria-label="Filter machines"
              spellCheck={false}
              autoCapitalize="off"
            />
          )}
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
          ) : shown.length === 0 ? (
            <p className="text-sm text-text-secondary" role="status">
              No machines match &quot;{query}&quot;. Enter an SSH target below if it isn&apos;t
              listed.
            </p>
          ) : (
            <ul
              className="max-h-64 divide-y divide-border-subtle overflow-y-auto rounded-[var(--radius-lg)] border border-border-default"
              data-testid="add-host-discovered"
            >
              {shown.map((host) => (
                <li key={`${host.source}:${formatHostConnection(host.connection)}`}>
                  <button
                    type="button"
                    disabled={host.alreadyAdded || busy}
                    data-known-machine={host.knownMachine && !host.alreadyAdded ? "" : undefined}
                    aria-pressed={target === sshTargetOf(host.connection)}
                    onClick={() => pick(host)}
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
                          : sourceLabel(host)}
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
            ref={targetInputRef}
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
    const verdict = probe ? checkVerdict(probe) : null;
    const verdictText =
      probe && verdict
        ? verdictCopy(verdict, probe, hostLabel, localVersion, localUpdate !== null)
        : null;
    // Once this machine is updating, the verdict is about it: no instruction to do what's under way.
    // Once this machine's update is ready, that is the news; restarting into it is the next step.
    const copy =
      verdict === "newer" && localUpdate?.phase === "ready"
        ? {
            title: `Daintree ${localUpdate.version} is ready on this machine`,
            detail: `${hostLabel} runs Daintree ${probe!.hostBuild?.version ?? localUpdate.version}, newer than this machine's ${localVersion ?? "build"}.`,
          }
        : verdictText;
    const stagedHere =
      probe?.reachable === true && probe.hostModeListening && probe.stagedUpdate?.installsOnQuit
        ? probe.stagedUpdate
        : null;
    // A download the host could restart into while something else is the
    // verdict: offered beside it, never instead of it.
    const applyAside =
      stagedHere?.ready === true && verdict !== "staged-ready" && verdict !== "newer";
    // Continuing with the build as it is only means something while there is
    // still Host mode to set up; otherwise it's the same as closing.
    const continueAnyway: DialogAction | undefined =
      probe?.install && (!existing || !hostModeSwitchedOn(probe))
        ? { label: "Continue anyway", onClick: () => toEnable(probe), disabled: busy }
        : undefined;
    const downgrade: DialogAction = {
      label: `Downgrade ${buttonHost}…`,
      intent: "destructive",
      onClick: () => {
        setDowngrading(true);
        loadPlan(linuxPackage, true);
      },
      disabled: busy,
    };
    body = !probe ? (
      checking ? (
        <div aria-hidden={!showChecking} className={cn("space-y-1", !showChecking && "invisible")}>
          <p className="flex items-center gap-2 text-sm font-medium text-text-primary [overflow-wrap:anywhere]">
            <Spinner size="sm" />
            Checking {hostLabel}
          </p>
          <p className="pl-5.5 text-xs text-text-secondary select-text [overflow-wrap:anywhere]">
            {viaWsl ? `Starting the ${target} distribution` : `Over SSH as ${target}`}
          </p>
        </div>
      ) : null
    ) : (
      <div>
        {verdict === "unreachable" ? (
          <>
            <Verdict title={copy!.title}>
              {viaWsl ? "The distribution didn't start." : `SSH as ${target} didn't connect.`}
            </Verdict>
            {probe.sshError && (
              <pre className="mt-3 whitespace-pre-wrap rounded-[var(--radius-md)] bg-surface-input p-2 text-xs text-text-secondary select-text">
                {probe.sshError}
              </pre>
            )}
            {localSuggestion && (
              <p className="mt-3 text-xs text-text-secondary">
                On a local network, a machine usually answers by its .local name.
              </p>
            )}
            {viaWsl ? (
              <p className="mt-3 text-xs text-text-secondary">
                Daintree runs programs in the distribution with <code>wsl.exe</code>. Check that{" "}
                <code>wsl -d {wslCommandArg(target)}</code> opens a shell there.
              </p>
            ) : (
              <SshRefusalHelp refusal={refusal} target={target} testId="add-host-ssh-refusal" />
            )}
          </>
        ) : (
          <Verdict title={copy!.title}>
            <p>{copy!.detail}</p>
            {verdict === "newer" && localUpdate?.phase === "ready" && (
              <p className="mt-2">
                Restarting Daintree here installs it, and this machine then matches {hostLabel}.
                Check {hostLabel} again once it&apos;s back.
              </p>
            )}
            {probe.stagedUpdate && !probe.stagedUpdate.installsOnQuit && (
              <p className="mt-2 text-xs">
                {hostLabel} has downloaded Daintree {probe.stagedUpdate.version}, which installs
                from Restart to update on its own screen, where the package install asks for an
                administrator password.
              </p>
            )}
            {applyAside && (
              <p className="mt-2 text-xs">
                {hostLabel} has also downloaded Daintree {stagedHere!.version}, which installs when
                Daintree restarts there.
              </p>
            )}
          </Verdict>
        )}
        {verdict === "newer" && localUpdate && <LocalUpdateStatus update={localUpdate} />}
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
                  <code>[boot]</code> section with <code>systemd=true</code>), then restart it and
                  check again.
                </p>
                <HostCommand
                  label="Restart the distribution"
                  command={`wsl --terminate ${wslCommandArg(target)}`}
                />
              </>
            )}
          </div>
        )}
        {probe.reachable && (
          <ProbeSummary probe={probe} via={viaWsl ? "WSL" : "SSH"} local={localVersion} />
        )}
      </div>
    );
    const checkAgain: DialogAction = {
      label: "Check again",
      onClick: () => check(),
      disabled: busy,
      loading: busy,
    };
    screen = `check:${verdict ?? (checking ? "checking" : "none")}:${localUpdate?.phase === "ready" ? "local-ready" : ""}`;
    announce =
      verdict === "newer" && localUpdate?.phase === "failed"
        ? `Couldn't check for an update to this machine. ${localUpdate.message}`
        : (copy?.title ?? (checking && showChecking ? `Checking ${hostLabel}` : ""));
    if (!probe) {
      // The first check is running, or it couldn't run at all (said below).
      primary = checking ? undefined : checkAgain;
    } else if (verdict === "unreachable" || noSystemd) {
      primary = checkAgain;
      if (localSuggestion) {
        leading = {
          label: `Try ${localSuggestion}`,
          onClick: () => check(localSuggestion),
          disabled: busy,
        };
      }
    } else if (verdict === "newer") {
      const local = localFooter();
      primary = local.primary;
      secondary = local.secondary;
      leading = local.offerDowngrade ? downgrade : undefined;
      // A restart of this machine is offered, never landed on.
      focusCancel = localUpdate?.phase === "ready";
    } else if (verdict === "staged-ready") {
      primary = {
        label: "Install downloaded update",
        onClick: () => startApply(stagedHere!.version),
        disabled: busy,
      };
      leading = continueAnyway;
    } else if (verdict === "staged-preparing") {
      // Still being handed to macOS's updater: a restart now would install nothing.
      primary = checkAgain;
      leading = continueAnyway;
    } else if (verdict === "update" || verdict === "not-installed") {
      primary = {
        label: probe.install ? "Review update" : "Review install",
        onClick: () => loadPlan(linuxPackage),
        disabled: busy,
        loading: busy,
      };
      // A different build still connects, best effort, with a warning.
      leading = continueAnyway;
    } else if (verdict === "up-to-date" && existing) {
      primary = { label: "Done", onClick: onClose };
      secondary = undefined;
    } else {
      // Host mode is left to set up there, or (adding) it's on and only needs saving.
      primary = {
        label:
          verdict === "host-mode-off" || verdict === "host-mode-temporary"
            ? "Set up Host mode…"
            : "Continue",
        onClick: () => toEnable(probe),
        disabled: busy,
      };
    }
    if (applyAside && !leading) {
      leading = {
        label: "Install downloaded update",
        onClick: () => startApply(stagedHere!.version),
        disabled: busy,
      };
    }
    // Not while a check runs: its result would land against an edited target.
    // Nor once saved: the record names this target, so it stays.
    if (!existing && !saved)
      secondary = { label: "Back", onClick: () => setStep("discover"), disabled: busy };
  } else if (step === "install") {
    const progress = install?.progress ?? null;
    const impact = installResult?.status === "needs-confirmation" ? installResult.impact : null;
    const userCommand =
      installResult?.status === "needs-user-command" ? installResult.command : null;
    const hostBuild = probe?.hostBuild?.version ?? probe?.install?.version ?? null;
    const runShown = installRunning || (installError !== null && opId !== null);
    if (runShown) {
      const reconnects = savedHost !== null && probe?.hostModeListening === true;
      const restarts = applying !== null || plan?.restartsHost === true;
      const ids: StageId[] = [
        "prepare",
        ...(installMode === "wait-for-idle" ? (["wait"] as const) : []),
        ...(restarts ? (["stop"] as const) : []),
        ...(plan?.packaging === "deb" && !applying ? [] : (["install"] as const)),
        ...(restarts ? (["start"] as const) : []),
        ...(restarts && reconnects ? (["reconnect"] as const) : []),
      ];
      // A stage the plan didn't foresee still shows, in its place.
      const reported = progress?.stage ? STAGE_OF[progress.stage] : undefined;
      if (reported && !ids.includes(reported)) {
        ids.push(reported);
        ids.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));
      }
      const version = targetVersion ? `Daintree ${targetVersion}` : "the new build";
      const label: Record<StageId, string> = {
        prepare: applying
          ? `Check ${hostLabel}`
          : plan?.delivery === "host-fetch"
            ? `Download ${version} on ${hostLabel}`
            : `Copy ${version} to ${hostLabel}`,
        wait: `Wait for ${hostLabel}'s agents to go idle`,
        stop: `Stop Daintree on ${hostLabel}`,
        install: `Install ${version}`,
        start: `Start Daintree on ${hostLabel}`,
        reconnect: `Reconnect to ${hostLabel}`,
      };
      const ended = installError !== null && !installRunning;
      const failed = ended && !installStopped;
      // A stop's own "Install cancelled" is the headline; what it put back, if anything, is the note.
      const stoppedNote =
        ended && installStopped
          ? installError!.replace(/^Install cancelled\.?\s*/, "") || null
          : null;
      const title = !ended ? runTitle : installStopped ? stoppedTitle : failedTitle;
      // A stage that reports none (waiting for idle) is indeterminate, never the last figure.
      const fraction = progress?.fraction ?? null;
      const detail = progress?.message ? namedProgressMessage(progress.message, hostLabel) : null;
      body = (
        <div className="space-y-4">
          <Verdict title={title} />
          {ended && (failed || stoppedNote) ? (
            <Callout
              severity={failed ? "error" : "neutral"}
              role={failed ? "alert" : undefined}
              title={
                failed ? (installFailureLead(installError!, hostLabel) ?? undefined) : undefined
              }
              className="select-text"
            >
              {namedProgressMessage(stoppedNote ?? installError!, hostLabel)}
            </Callout>
          ) : ended ? null : (
            <ProgressBar
              value={fraction === null ? null : Math.round(fraction * 100)}
              label={title}
              valueText={detail ?? undefined}
              className={cn(!showRun && "invisible")}
            />
          )}
          <InstallStages
            stages={ids.map((id) => ({ id, label: label[id] }))}
            progress={progress}
            host={hostLabel}
            failed={failed}
            started={ended || showRun}
            halted={ended && !failed}
            applying={applying !== null}
          />
        </div>
      );
      screen = ended ? "install:ended" : "install:running";
      announce = ended ? title : (detail ?? title);
    } else if (impact) {
      screen = "install:impact";
      focusCancel = true;
      const question = `Restart Daintree on ${hostLabel}?`;
      announce = question;
      body = (
        <div className="space-y-3" data-testid="host-restart-impact">
          <Verdict title={question} />
          {/* The dialog's description while it asks: what the restart ends. */}
          <AppDialog.Description as="div" className="space-y-3">
            <p>{verbing} restarts it, which ends what&apos;s running there:</p>
            <ul className="list-disc space-y-1 pl-5 text-text-primary">
              {restartImpactLines(impact).map((line, index) => (
                <li key={`${index}:${line}`}>{line}</li>
              ))}
            </ul>
            <p className="text-xs text-pretty">
              {canWaitForIdle(impact)
                ? `${restartVerb} when idle waits until no agent is seen working or waiting there, then restarts it and ends these terminals. `
                : ""}
              Agent states are observed, so one shown idle may still be busy. Nothing has changed
              yet.
            </p>
          </AppDialog.Description>
        </div>
      );
    } else if (userCommand) {
      const title = `Finish installing Daintree ${targetVersion} on ${hostLabel}`;
      screen = "install:command";
      announce = title;
      body = (
        <div className="space-y-4">
          <Verdict title={title} />
          <HostCommand label={`Run this on ${hostLabel}`} command={userCommand.command} />
          <p className="text-xs text-text-secondary">
            The .deb package is on {hostLabel}, and installing it needs sudo, which Daintree never
            runs for you. Check again once the command has finished.
          </p>
        </div>
      );
    } else if (installResult?.status === "host-newer" || plan?.kind === "host-newer") {
      body = (
        <div>
          <Verdict title={`${hostLabel} is ahead of this machine`}>
            {installResult?.status === "host-newer"
              ? "It moved to a newer build while this was being prepared, so nothing was installed. Check again to see it."
              : (plan?.reason ?? "It runs a newer build than this machine.")}
          </Verdict>
          {localUpdate && <LocalUpdateStatus update={localUpdate} />}
        </div>
      );
    } else if (plan?.kind === "unsupported") {
      body = (
        <Verdict title={`Can't ${probe?.install ? "update" : "install on"} ${hostLabel} from here`}>
          {plan.reason}
        </Verdict>
      );
    } else if (plan?.kind === "up-to-date") {
      body = (
        <Verdict title={`${hostLabel} already runs this build`}>
          {hostBuild ? `It runs Daintree ${hostBuild}, the same as this machine.` : null}
        </Verdict>
      );
    } else if (plan) {
      const verbed = plan.downgrade ? "Downgrading" : probe?.install ? "Updating" : "Installing";
      const from = probe?.install && hostBuild ? ` from Daintree ${hostBuild}` : "";
      const title = plan.downgrade
        ? `Downgrade ${hostLabel}${from} to ${from ? "" : "Daintree "}${plan.version}`
        : probe?.install
          ? `Update ${hostLabel}${from} to ${from ? "" : "Daintree "}${plan.version}`
          : `Install Daintree ${plan.version} on ${hostLabel}`;
      const commit = shortCommit(plan.commit);
      screen = `install:plan:${plan.downgrade ? "downgrade" : "install"}`;
      announce = title;
      // Its primary is the downgrade itself, which goes ahead when nothing is running there.
      focusCancel = plan.downgrade;
      body = (
        <div className="space-y-4">
          <Verdict title={title}>
            This puts this machine&apos;s exact build there: Daintree {plan.version}
            {commit ? ` (${commit})` : ""}.
          </Verdict>
          {plan.downgrade && (
            <Callout severity="danger" title="This is a downgrade" data-testid="add-host-downgrade">
              Settings and data that {hostBuild ? `Daintree ${hostBuild}` : "the newer build"} saved
              on {hostLabel} may not open in {plan.version}.
            </Callout>
          )}
          {probe?.platform === "linux" && (
            <div ref={packageGroup} className="flex items-center justify-between gap-4">
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
                  loadPlan(value, downgrading, () => setRefocusPackage(true));
                }}
              />
            </div>
          )}
          <ul className="space-y-1.5 text-sm text-text-secondary">
            {plan.restartsHost && plan.packaging !== "deb" && (
              <li className="text-text-primary">
                Daintree is running there. {verbed} restarts it, which ends its terminals; if any
                are running, you&apos;ll see them before anything stops.
              </li>
            )}
            <li>{deliveryLabel(plan, hostLabel)}.</li>
            {plan.packaging === "deb" && (
              <li>
                The package needs sudo, so the last step is one command you run on {hostLabel}.{" "}
                {probe?.advice.fuse === false
                  ? "The AppImage installs without root; with no FUSE there, it runs unpacked."
                  : "The AppImage installs without root but needs FUSE."}
              </li>
            )}
            {plan.packaging === "appimage" && probe?.advice.fuse === false && (
              <li>
                No FUSE was found on {hostLabel}, so the AppImage runs unpacked each time it starts,
                which makes starting slower.
              </li>
            )}
          </ul>
        </div>
      );
    } else {
      body = null;
    }

    const checkAgain: DialogAction = {
      label: "Check again",
      onClick: () => check(),
      disabled: busy,
      loading: busy && !installRunning,
    };
    if (installRunning) {
      // The one way out while it runs: the dialog stays until the stop settles.
      // Past the point of no return (the restart, and a downloaded update's
      // whole stop-install-start), the installer finishes whatever a stop says.
      const stage = install?.progress?.stage ?? null;
      const settling =
        stage !== null &&
        (applying
          ? ["stopping", "installing", "restarting", "reconnecting"]
          : ["restarting", "reconnecting"]
        ).includes(stage);
      primary = undefined;
      secondary = { label: "Stop", onClick: cancelInstall, disabled: settling };
      if (settling) hint = `Daintree is restarting on ${hostLabel}. This finishes on its own.`;
    } else if (runShown) {
      // Ended. A stop the user chose, or a download the host may have swapped
      // under it, is looked at again; this machine's build is retried as it
      // was, behind the same checks.
      primary =
        applying || installStopped
          ? checkAgain
          : { label: "Retry", onClick: () => startInstall("refuse"), disabled: busy };
      if (!applying && !installStopped) {
        leading = { label: "Check again", onClick: () => check(), disabled: busy };
      }
      secondary = { label: "Close", onClick: onClose, disabled: busy };
    } else if (impact) {
      const endNow: DialogAction = {
        label: restartConfirmLabel(impact, restartVerb),
        intent: "destructive",
        onClick: () => startInstall("proceed", impact),
        disabled: busy,
      };
      if (canWaitForIdle(impact)) {
        primary = {
          label: `${restartVerb} when idle`,
          onClick: () => startInstall("wait-for-idle", impact),
          disabled: busy,
        };
        leading = endNow;
      } else {
        primary = endNow;
      }
    } else if (
      userCommand ||
      installResult?.status === "host-newer" ||
      plan?.kind === "unsupported" ||
      // An install of what the host downloaded that stopped: what is there now decides what's next.
      applying
    ) {
      primary = checkAgain;
    } else if (plan?.kind === "up-to-date") {
      primary = { label: existing ? "Done" : "Continue", onClick: () => toEnable(probe) };
    } else if (plan?.kind === "host-newer") {
      const local = localFooter();
      primary = local.primary;
      secondary = local.secondary;
      if (local.offerDowngrade)
        leading = {
          label: `Downgrade ${buttonHost}…`,
          intent: "destructive",
          onClick: () => {
            setDowngrading(true);
            loadPlan(linuxPackage, true);
          },
          disabled: busy,
        };
    } else if (plan?.kind === "install") {
      // An attempt that failed may have failed on what changed at the host.
      if (error) leading = { label: "Check again", onClick: () => check(), disabled: busy };
      primary = {
        label: plan.downgrade
          ? `Downgrade ${buttonHost}`
          : probe?.install
            ? `Update ${buttonHost}`
            : `Install on ${buttonHost}`,
        intent: plan.downgrade ? "destructive" : undefined,
        onClick: () => startInstall("refuse"),
        disabled: busy,
        loading: busy,
      };
    }
  } else if (step === "done") {
    const result =
      installResult?.status === "installed" || installResult?.status === "staged-applied"
        ? installResult
        : null;
    const runs = probe?.hostBuild?.version ?? probe?.install?.version ?? targetVersion;
    const title = applying
      ? `${hostLabel} restarted into Daintree ${applying.version}`
      : result === null
        ? `${hostLabel} is up to date`
        : plan?.downgrade
          ? `Downgraded ${hostLabel} to Daintree ${runs}`
          : `Updated ${hostLabel} to Daintree ${runs}`;
    body = (
      <div>
        <Verdict title={title}>
          {result === null
            ? "It already ran this build, so nothing was changed."
            : result.reconnected === true
              ? "Daintree is running there again, and this machine has reconnected to it."
              : result.reconnected === false
                ? "Daintree is running there again. This machine reconnected, and it reports a different build from this one."
                : `Daintree is running there again. This machine hasn't reconnected yet; ${hostLabel}'s status shows in Settings → Hosts.`}
        </Verdict>
        {probe?.reachable && (
          <ProbeSummary probe={probe} via={viaWsl ? "WSL" : "SSH"} local={localVersion} />
        )}
      </div>
    );
    primary = { label: "Done", onClick: onClose };
    secondary = undefined;
    announce = title;
  } else if (step === "enable") {
    const switchedOn = hostModeSwitchedOn(probe);
    const installed =
      installResult?.status === "installed" || installResult?.status === "staged-applied";
    const enableBody = switchedOn ? (
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
    body = installed ? (
      <div className="space-y-4">
        <Callout severity="success" role="status">
          Daintree {probe?.install?.version ?? targetVersion} is installed on {hostLabel}.
        </Callout>
        {enableBody}
      </div>
    ) : (
      enableBody
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

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      dismissible={!locked}
      size="md"
      initialFocus={step === "discover" ? undefined : focusCancel ? "cancel" : "confirm"}
      focusResetKey={screen}
      data-testid="add-host-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title>
          {existing
            ? `${existing.intent === "setup" ? "Set up" : "Update"} ${existing.name}`
            : "Add host"}
        </AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>
      <AppDialog.Body>
        {/* An existing host's flow branches on what the check finds: no fixed steps to show. */}
        {!existing && step !== "done" && <StepBar current={step} />}
        {body}
        {saved && !existing && !outcome && (
          <p className="mt-3 text-xs text-text-secondary">
            {saved.name} is saved in your host list. Closing leaves it there.
          </p>
        )}
        {error && <ErrorLine message={error} />}
        <p role="status" className="sr-only">
          {announce}
        </p>
      </AppDialog.Body>
      <AppDialog.Footer
        primaryAction={primary}
        secondaryAction={secondary}
        leadingAction={leading}
        hint={hint}
      />
    </AppDialog>
  );
}
