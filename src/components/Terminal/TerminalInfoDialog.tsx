import { useCallback, useEffect, useId, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { SkeletonBone } from "@/components/ui/Skeleton";
import type { TerminalInfoPayload } from "@/types/electron";
import { actionService } from "@/services/ActionService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";

const SYNC_MODE_POLL_MS = 250;

/**
 * One vocabulary per kind of absence, because three were doing the work of one.
 *
 * The old surface used "N/A" for a field that has no value, for a field whose value
 * could not be read, and for a question we simply cannot answer — three different
 * facts that a support engineer reads differently. `—` means the field does not apply
 * to this terminal, "Unknown" means we could not determine it, "Unavailable" means the
 * source could not be reached.
 */
const NONE = "—";
const UNKNOWN = "Unknown";
const UNAVAILABLE = "Unavailable";

/**
 * Section header treatment, matching `GitPushConfirmDialog` and `McpConfirmDialog`.
 *
 * Uppercase micro-label rather than sentence-case prose: it is a rail marker, not a
 * sentence, and at 11px it reads as structure instead of competing with the rows for
 * the same tab stop of the eye.
 */
const MICRO_LABEL = "text-[11px] font-semibold uppercase tracking-wider text-daintree-text/60";

/**
 * The label rail.
 *
 * Fixed width, not `auto`: with `auto` the longest label in a group sets the rail for
 * every group, so one 30-character label ("Synchronized output") pushes every value on
 * the surface right and the rail stops being a rail. A fixed rail means labels wrap and
 * values keep one predictable left edge, which is the entire point.
 */
const ROW_GRID = "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2";

interface TerminalInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  terminalId: string;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

function formatTimestamp(timestamp: number): string {
  if (timestamp === 0) return "Never";
  const date = new Date(timestamp);
  return date.toLocaleString();
}

function formatRelativeTime(timestamp: number): string {
  if (timestamp === 0) return "Never";
  const now = Date.now();
  const diff = now - timestamp;
  return `${formatDuration(diff)} ago`;
}

function formatSyncMode(value: boolean | null): string {
  if (value === null) return UNAVAILABLE;
  return value ? "On" : "Off";
}

function formatYesNo(value: boolean | undefined): string {
  if (value === undefined) return UNKNOWN;
  return value ? "Yes" : "No";
}

/** Prefer an agent's product name over its slug; fall back to the slug we were given. */
function agentLabel(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined;
  return getAgentConfig(agentId)?.name ?? agentId;
}

type RowValue = string | number | null | undefined;

interface RowProps {
  label: string;
  value: RowValue;
  mono?: boolean;
  /** Render a delayed skeleton instead of the fallback while the remote read is in flight. */
  pending?: boolean;
  /** What to show when the value is absent. Defaults to the not-applicable dash. */
  fallback?: string;
}

/**
 * One label/value pair.
 *
 * A fragment of `<dt>`/`<dd>` rather than a wrapper element, so the pairs are direct
 * grid children of their `<dl>` and every row in a group shares one rail. The
 * alternative — a `<div>` per pair — needs `display: contents` to participate in the
 * grid, which has a documented history of dropping the row from the accessibility tree.
 */
function Row({ label, value, mono = false, pending = false, fallback = NONE }: RowProps) {
  const hasValue = value !== undefined && value !== null && value !== "";
  const display = hasValue ? String(value) : fallback;

  return (
    <>
      <dt className="text-daintree-text/70 select-none min-w-0 break-words">{label}</dt>
      <dd className="min-w-0 text-daintree-text">
        {!hasValue && pending ? (
          <SkeletonBone className="h-4 w-32" />
        ) : (
          <TruncatedTooltip content={display}>
            <span
              className={cn(
                "block select-text",
                // `anywhere`, not `break-all`: a path breaks at its separators where it
                // can and mid-token only where it must, so the leaf directory — the
                // informative half — survives instead of being ellipsed away.
                mono ? "font-mono text-xs [overflow-wrap:anywhere] tabular-nums" : "break-words",
                !hasValue && "text-daintree-text/70"
              )}
            >
              {display}
            </span>
          </TruncatedTooltip>
        )}
      </dd>
    </>
  );
}

interface ChipRowProps {
  label: string;
  items: string[] | undefined;
  pending?: boolean;
}

function ChipRow({ label, items, pending = false }: ChipRowProps) {
  const isEmpty = !items || items.length === 0;

  return (
    <>
      <dt className="text-daintree-text/70 select-none min-w-0 break-words">{label}</dt>
      <dd className="min-w-0">
        {isEmpty && pending ? (
          <SkeletonBone className="h-4 w-40" />
        ) : isEmpty ? (
          <span className="text-daintree-text/70">{NONE}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {items.map((item, i) => (
              <code
                key={`${i}-${item}`}
                className="bg-overlay-subtle border border-border-default font-mono text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] select-text [overflow-wrap:anywhere]"
              >
                {item}
              </code>
            ))}
          </div>
        )}
      </dd>
    </>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className={MICRO_LABEL}>{title}</h3>
      <dl className={cn(ROW_GRID, "text-sm")}>{children}</dl>
    </section>
  );
}

/**
 * A group that starts closed.
 *
 * PTY internals and buffer sizes are wanted perhaps once a year, and while they sit
 * permanently open they cost every reader a scroll past them to reach anything else.
 * Collapsed they are one keystroke away — and they stay in the copied payload whatever
 * their open state, because a support engineer pasting diagnostics into an issue must
 * never have to know which sections they left expanded.
 */
function DisclosureGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  return (
    <section>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-1.5 rounded-[var(--radius-sm)] py-1 text-left",
          "transition-colors duration-150 ease-out hover:bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
        )}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "w-3 h-3 shrink-0 text-daintree-text/40 transition-transform duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        <span className={MICRO_LABEL}>{title}</span>
      </button>
      <div id={panelId} hidden={!expanded}>
        <dl className={cn(ROW_GRID, "text-sm pt-2 pl-[1.125rem]")}>{children}</dl>
      </div>
    </section>
  );
}

export function TerminalInfoDialog({ isOpen, onClose, terminalId }: TerminalInfoDialogProps) {
  const [info, setInfo] = useState<TerminalInfoPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncMode, setSyncMode] = useState<boolean | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const errorDetailId = useId();
  const panelRaw = usePanelStore((state) => state.panelsById[terminalId]);
  const panel = panelRaw && isPtyPanel(panelRaw) ? panelRaw : undefined;
  const { copied, copy } = useCopyWithFeedback({ announcement: "Diagnostics copied" });

  useEffect(() => {
    if (!isOpen) {
      setInfo(null);
      setError(null);
      setLoading(false);
      setSyncMode(null);
      setShowErrorDetail(false);
      return;
    }

    let isMounted = true;

    const fetchInfo = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await actionService.dispatch(
          "terminal.info.get",
          { terminalId },
          { source: "user" }
        );
        if (!result.ok) {
          throw new Error(result.error.message);
        }
        if (isMounted) {
          setInfo(result.result as TerminalInfoPayload);
        }
      } catch (err) {
        const message = formatErrorMessage(err, "Failed to load terminal info");
        if (isMounted) {
          setError(message);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchInfo();

    return () => {
      isMounted = false;
    };
  }, [isOpen, terminalId, reloadKey]);

  useEffect(() => {
    if (!isOpen) return;
    // Immediate read on open so the dialog reflects the current sync-mode
    // before the first poll lands.
    setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId));
  }, [isOpen, terminalId]);

  // xterm 6 mutates terminal.modes asynchronously as the parser consumes
  // BSU/ESU sequences, and there is no change event. Poll at the same cadence
  // as REFLOW_THROTTLE_MS (250ms) — enough resolution to catch most BSU blocks
  // while the dialog is open. Visibility-gated so the poll pauses while the
  // window is hidden and snaps back on restore.
  useVisibilityAwareInterval(
    () => setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId)),
    SYNC_MODE_POLL_MS,
    isOpen
  );

  const launchAgentId = panel?.launchAgentId ?? info?.launchAgentId;
  const command = panel?.command ?? info?.command;
  const worktreeId = panel?.worktreeId ?? info?.worktreeId;
  const titleMode = panel?.titleMode ?? info?.titleMode;
  const spawnSource = panel?.spawnedBy;
  // An assistant-launched run arrives over the MCP bridge like any other, so
  // the transport answer stays "Yes" — what changed is that we can now say who
  // was on the other end of it (#11808). Kept as two rows rather than one:
  // folding the actor into the transport row would drop the fact that this is
  // still an MCP dispatch, which is the useful half when debugging routing.
  const startedByAssistant = spawnSource === "assistant";
  const startedViaMcp =
    spawnSource === "mcp" || startedByAssistant ? "Yes" : spawnSource ? "No" : UNKNOWN;
  const uiStartedAt = panel?.startedAt;
  const location = panel?.location;
  const agentPresetId = panel?.agentPresetId ?? info?.agentPresetId;
  const agentPresetColor = panel?.agentPresetColor ?? info?.agentPresetColor;
  const originalPresetId = panel?.originalPresetId ?? info?.originalAgentPresetId;
  const agentSessionId = panel?.agentSessionId ?? info?.agentSessionId;

  const title = panel?.title ?? info?.title;
  const cwd = info?.cwd ?? panel?.cwd;
  const detectedAgentId = info?.detectedAgentId ?? panel?.detectedAgentId;
  const everDetectedAgent = info?.everDetectedAgent ?? panel?.everDetectedAgent;
  const agentState = info?.agentState ?? panel?.agentState;
  const exitCode = panel?.exitCode ?? info?.exitCode;
  const agentLaunchFlags = info?.agentLaunchFlags ?? panel?.agentLaunchFlags;
  const agentModelId = info?.agentModelId ?? panel?.agentModelId;

  // `runtimeStatus` over `hasPty`: the store's own contract note in
  // `src/store/fleetEligibility.ts` records that `hasPty` lags after backend
  // snapshots and reconnects for panels preserved past exit, while
  // `runtimeStatus` is the renderer's authoritative liveness signal. It is also
  // local, so it survives the payload read failing — which is exactly the case
  // where liveness matters most.
  const runtimeStatus = panel?.runtimeStatus;
  const hasExited = runtimeStatus === "exited" || info?.hasPty === false;
  const liveness = hasExited
    ? exitCode != null
      ? `Exited · code ${exitCode}`
      : "Exited"
    : runtimeStatus === "error"
      ? "Error"
      : panel || info
        ? "Running"
        : UNKNOWN;

  // The remote read is in flight and has never landed. Rows the payload owns show a
  // delayed skeleton; rows the panel store owns are already correct and never flicker.
  const pending = loading && !info && !error;

  const agentName = agentLabel(detectedAgentId ?? launchAgentId);
  const runningLabel = info?.ptyForegroundProcess ?? (hasExited ? NONE : undefined);

  // "Launch Context" reflects how the panel was configured at spawn time.
  const showAgentLaunchSection = !!(
    launchAgentId ||
    (agentLaunchFlags && agentLaunchFlags.length > 0) ||
    agentModelId ||
    agentPresetId ||
    originalPresetId
  );
  // "Live State" reflects what's running right now. Shown for agent launches,
  // while a runtime agent is detected, or once an agent has ever been detected
  // in this session (so plain terminals that ran `claude` still show the exit).
  const showAgentLiveSection = !!(launchAgentId || detectedAgentId || everDetectedAgent);

  const formatArgsForClipboard = (args: string[] | undefined): string => {
    if (args === undefined) return UNKNOWN;
    if (args.length === 0) return "(none)";
    return args.join(" ");
  };

  /**
   * The full payload, built from data rather than from the DOM.
   *
   * Deliberately independent of which disclosures are open and of whether the remote
   * read succeeded: a support engineer pasting this into an issue must get everything
   * the app knows, and on a terminal whose PTY record is gone the panel-store half is
   * the only half there is.
   */
  const buildDiagnostics = useCallback((): string => {
    const launchSection = showAgentLaunchSection
      ? `

Agent — launch context:
  Launch agent: ${launchAgentId ?? NONE}
  Command: ${command ?? NONE}
  Launch flags: ${formatArgsForClipboard(agentLaunchFlags)}
  Model: ${agentModelId ?? NONE}
  Preset: ${agentPresetId ?? NONE}
  Preset color: ${agentPresetColor ?? NONE}
  Original preset: ${originalPresetId ?? NONE}`
      : "";

    const liveSection = showAgentLiveSection
      ? `

Agent — live state:
  Detected agent ID: ${detectedAgentId ?? (everDetectedAgent ? "None — agent has exited" : "Not detected yet")}
  Agent state: ${agentState ?? NONE}
  Session ID: ${agentSessionId ?? NONE}`
      : "";

    const agentSection = launchSection + liveSection;

    return `Terminal Diagnostic Information
=====================================

Status:
  Liveness: ${liveness}
  Runtime status: ${runtimeStatus ?? UNKNOWN}
  Foreground process: ${info?.ptyForegroundProcess ?? NONE}
  Exit code: ${exitCode != null ? exitCode : NONE}
${info ? "" : `  NOTE: the live terminal record could not be read${error ? ` (${error})` : ""}; the values below come from the panel store only.\n`}
Session metadata:
  ID: ${info?.id ?? terminalId}
  Kind: ${info?.kind || panel?.kind || "terminal"}
  Title: ${title ?? NONE}
  Title mode: ${titleMode ?? "default"}
  Project ID: ${info?.projectId || NONE}
  Worktree ID: ${worktreeId || NONE}
  CWD: ${cwd ?? NONE}
  Location: ${location ?? NONE}
  Spawn source: ${spawnSource ?? NONE}
${startedByAssistant ? "  Started by: Daintree Assistant\n" : ""}  Started via MCP: ${startedViaMcp}
  UI created at: ${uiStartedAt != null ? formatTimestamp(uiStartedAt) : NONE}

Spawn command:
  Shell: ${info?.shell || NONE}
  Command: ${command ?? NONE}
  Args: ${formatArgsForClipboard(info?.spawnArgs)}${agentSection}

Terminal internals:
  Agent launch hint: ${launchAgentId ? "Yes" : "No"}
  PTY active: ${formatYesNo(info?.hasPty)}
  Analysis enabled: ${formatYesNo(info?.analysisEnabled)}
  Resize strategy: ${info?.resizeStrategy || "default"}
  Dimensions: ${info?.ptyCols != null && info?.ptyRows != null ? `${info.ptyCols} × ${info.ptyRows}` : UNAVAILABLE}
  Shell PID: ${info?.ptyPid ?? UNAVAILABLE}
  TTY device: ${info?.ptyTty ?? UNAVAILABLE}

Runtime statistics:
  Running time: ${info ? formatDuration(Date.now() - info.spawnedAt) : UNAVAILABLE}
  Spawned at: ${info ? formatTimestamp(info.spawnedAt) : UNAVAILABLE}
  Restart count: ${info?.restartCount ?? UNAVAILABLE}

Activity metrics:
  Last input: ${info ? `${formatRelativeTime(info.lastInputTime)} (${formatTimestamp(info.lastInputTime)})` : UNAVAILABLE}
  Last output: ${info ? `${formatRelativeTime(info.lastOutputTime)} (${formatTimestamp(info.lastOutputTime)})` : UNAVAILABLE}
  Agent state: ${agentState || NONE}
  Last state change: ${info?.lastStateChange != null ? formatRelativeTime(info.lastStateChange) : NONE}
  Activity tier: ${info?.activityTier ?? UNAVAILABLE}

Performance & diagnostics:
  Output buffer size: ${info?.outputBufferSize ?? UNAVAILABLE} lines
  Semantic buffer: ${info?.semanticBufferLines ?? UNAVAILABLE} lines
  Synchronized output (DEC 2026): ${formatSyncMode(syncMode)}
`;
  }, [
    agentLaunchFlags,
    agentModelId,
    agentPresetColor,
    agentPresetId,
    agentSessionId,
    agentState,
    command,
    cwd,
    detectedAgentId,
    error,
    everDetectedAgent,
    exitCode,
    info,
    launchAgentId,
    liveness,
    location,
    originalPresetId,
    panel?.kind,
    runtimeStatus,
    showAgentLaunchSection,
    showAgentLiveSection,
    spawnSource,
    startedByAssistant,
    startedViaMcp,
    syncMode,
    terminalId,
    title,
    titleMode,
    uiStartedAt,
    worktreeId,
  ]);

  const handleCopy = useCallback(() => {
    void copy(buildDiagnostics());
  }, [buildDiagnostics, copy]);

  return (
    <AppDialog isOpen={isOpen} onClose={onClose} size="lg" data-testid="terminal-info-dialog">
      <AppDialog.Header>
        <AppDialog.Title icon={<Info className="h-5 w-5" />}>Terminal information</AppDialog.Title>
        <AppDialog.CloseButton />
      </AppDialog.Header>

      <AppDialog.Body>
        <div className="space-y-6" data-testid="terminal-info-body">
          {/*
           * The overview answers the first four ranked questions before anything else:
           * is it alive, what is running in it, how long has it been going, and which
           * terminal is this. It is never collapsed and never skeletoned away — every
           * value in it has a panel-store source, so it is correct on the first frame
           * and correct even when the remote read fails outright.
           */}
          <section
            className="rounded-[var(--radius-lg)] border border-border-default bg-overlay-subtle px-4 py-3 space-y-3"
            data-testid="terminal-info-overview"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-base font-semibold text-daintree-text min-w-0 break-words select-text">
                {title ?? "Terminal"}
              </h3>
              {/*
               * Words, not a tint. A coloured status pill is the obvious move and it is
               * the wrong one here: `forced-colors: active` replaces every fill with a
               * system colour, so a pill that carries its meaning in green-vs-red reads
               * as one indistinguishable shape on Windows high contrast. "Exited · code
               * 3" survives that intact, and it needs no accent.
               */}
              <span
                className="text-sm font-medium text-daintree-text shrink-0 tabular-nums select-text"
                data-testid="terminal-info-liveness"
              >
                {liveness}
              </span>
            </div>
            <dl className={cn(ROW_GRID, "text-sm")}>
              <Row
                label="Running"
                value={
                  agentName ? `${agentName}${agentState ? ` · ${agentState}` : ""}` : runningLabel
                }
                pending={pending}
                fallback={hasExited ? NONE : UNKNOWN}
              />
              <Row
                label="Runtime"
                value={info ? formatDuration(Date.now() - info.spawnedAt) : undefined}
                pending={pending}
                fallback={UNAVAILABLE}
              />
              <Row
                label="Last output"
                value={info ? formatRelativeTime(info.lastOutputTime) : undefined}
                pending={pending}
                fallback={UNAVAILABLE}
              />
              <Row label="Directory" value={cwd} mono pending={pending} />
            </dl>
          </section>

          {error && (
            <div
              // No tinted fill. `bg-status-error/10` composites the error text down to
              // 4.22:1 against the dialog surface — under the AA floor — where the same
              // token on the bare surface measures 4.83:1. The tint was costing the
              // banner its legibility to look like a banner.
              className="rounded-[var(--radius-lg)] border border-status-error/40 p-4 space-y-3"
              role="alert"
              data-testid="terminal-info-error"
            >
              <div className="space-y-1">
                <p className="font-semibold text-status-error">
                  Couldn&apos;t load live terminal data
                </p>
                <p className="text-sm text-daintree-text/80">
                  The values above come from this window and are still accurate. Process-level
                  details — PID, TTY, buffers, activity — need the terminal host, which didn&apos;t
                  answer.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                  Retry
                </Button>
                <button
                  type="button"
                  aria-expanded={showErrorDetail}
                  aria-controls={errorDetailId}
                  onClick={() => setShowErrorDetail((value) => !value)}
                  className={cn(
                    "flex items-center gap-1 rounded-[var(--radius-sm)] px-1.5 py-1 text-xs text-daintree-text/70",
                    "transition-colors duration-150 ease-out hover:bg-overlay-subtle hover:text-daintree-text",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-daintree-accent focus-visible:-outline-offset-2"
                  )}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={cn(
                      "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
                      showErrorDetail && "rotate-90"
                    )}
                  />
                  Technical details
                </button>
              </div>
              <p
                id={errorDetailId}
                hidden={!showErrorDetail}
                // `anywhere` rather than `break-all`: the old rule split the terminal
                // UUID mid-token so the wrapped line opened with a bare hyphen that read
                // as a stray dash, and the id could not be selected as one string.
                className="text-xs font-mono [overflow-wrap:anywhere] text-daintree-text/80 select-text"
              >
                {error}
              </p>
            </div>
          )}

          <Group title="Session">
            <Row label="Terminal ID" value={info?.id ?? terminalId} mono />
            <Row label="Kind" value={info?.kind || panel?.kind || "terminal"} />
            <Row label="Title mode" value={titleMode ?? "default"} />
            <Row label="Location" value={location} pending={pending} />
            <Row label="Worktree ID" value={worktreeId} mono pending={pending} />
            <Row label="Project ID" value={info?.projectId} mono pending={pending} />
          </Group>

          <Group title="How it launched">
            <Row label="Shell" value={info?.shell} mono pending={pending} fallback={UNAVAILABLE} />
            <Row label="Command" value={command} mono pending={pending} />
            <ChipRow label="Arguments" items={info?.spawnArgs} pending={pending} />
            <Row label="Spawn source" value={spawnSource} pending={pending} />
            {startedByAssistant && <Row label="Started by" value="Daintree Assistant" />}
            <Row label="Started via MCP" value={startedViaMcp} />
            <Row
              label="Created"
              value={uiStartedAt != null ? formatTimestamp(uiStartedAt) : undefined}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Spawned"
              value={info ? formatTimestamp(info.spawnedAt) : undefined}
              pending={pending}
              fallback={UNAVAILABLE}
            />
          </Group>

          {showAgentLaunchSection && (
            <Group title="Agent launch">
              <Row label="Launch agent" value={agentLabel(launchAgentId)} />
              <ChipRow label="Launch flags" items={agentLaunchFlags} pending={pending} />
              <Row label="Model" value={agentModelId} mono pending={pending} />
              <Row label="Preset" value={agentPresetId} mono />
              <Row label="Preset color" value={agentPresetColor} mono />
              <Row label="Original preset" value={originalPresetId} mono />
            </Group>
          )}

          {showAgentLiveSection && (
            <Group title="Agent state">
              <Row
                label="Detected agent"
                value={
                  agentLabel(detectedAgentId) ??
                  (everDetectedAgent ? "None — agent has exited" : "Not detected yet")
                }
                pending={pending}
              />
              <Row label="State" value={agentState} pending={pending} />
              <Row
                label="State changed"
                value={
                  info?.lastStateChange != null
                    ? formatRelativeTime(info.lastStateChange)
                    : undefined
                }
                pending={pending}
              />
              <Row label="Session ID" value={agentSessionId} mono />
            </Group>
          )}

          <Group title="Activity">
            <Row
              label="Last input"
              value={info ? formatRelativeTime(info.lastInputTime) : undefined}
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Last output"
              value={info ? formatRelativeTime(info.lastOutputTime) : undefined}
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Activity tier"
              value={info?.activityTier}
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Restarts"
              value={info?.restartCount}
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
          </Group>

          <DisclosureGroup title="Terminal internals">
            <Row label="PTY active" value={formatYesNo(info?.hasPty)} pending={pending} />
            <Row
              label="Shell PID"
              value={info?.ptyPid}
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="TTY device"
              value={info?.ptyTty}
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Dimensions"
              value={
                info?.ptyCols != null && info?.ptyRows != null
                  ? `${info.ptyCols} × ${info.ptyRows}`
                  : undefined
              }
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row label="Exit code" value={exitCode} mono fallback={hasExited ? UNKNOWN : NONE} />
            <Row
              label="Resize strategy"
              value={info?.resizeStrategy || "default"}
              pending={pending}
            />
            <Row
              label="Analysis enabled"
              value={formatYesNo(info?.analysisEnabled)}
              pending={pending}
            />
            <Row label="Agent launch hint" value={launchAgentId ? "Yes" : "No"} />
          </DisclosureGroup>

          <DisclosureGroup title="Performance">
            <Row
              label="Output buffer"
              value={info?.outputBufferSize != null ? `${info.outputBufferSize} lines` : undefined}
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Semantic buffer"
              value={
                info?.semanticBufferLines != null ? `${info.semanticBufferLines} lines` : undefined
              }
              mono
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row label="Synchronized output" value={formatSyncMode(syncMode)} />
          </DisclosureGroup>
        </div>
      </AppDialog.Body>

      <AppDialog.Footer>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        {/*
         * The visible label changes but `aria-label` does not: `useCopyWithFeedback`
         * already announces the result on the polite live region, and a changing
         * accessible name would announce it a second time.
         */}
        <Button
          variant="contrast"
          onClick={handleCopy}
          aria-label="Copy diagnostics"
          data-testid="terminal-info-copy"
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
