import { Children, isValidElement, useCallback, useEffect, useId, useRef, useState } from "react";
import { AppDialog } from "@/components/ui/AppDialog";
import { Button } from "@/components/ui/button";
import { ChevronRight, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { SkeletonBone } from "@/components/ui/Skeleton";
import type { TerminalInfoPayload } from "@/types/electron";
import { actionService } from "@/services/ActionService";
import { terminalInstanceService } from "@/services/TerminalInstanceService";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { getAgentConfig } from "@shared/config/agentRegistry";
import { usePanelStore } from "@/store/panelStore";
import { isPtyPanel } from "@shared/types/panel";
import { useCopyWithFeedback } from "@/hooks/useCopyWithFeedback";
import { notify } from "@/lib/notify";
import { useVisibilityAwareInterval } from "@/hooks/useVisibilityAwareInterval";
import { SECTION_LABEL_CLASS } from "@/components/ui/sectionLabel";
import { COUNT_BADGE_CLASS } from "@/components/ui/badge";

const SYNC_MODE_POLL_MS = 250;
/**
 * Re-read the host record while the dialog is open. The overview's answers — what is
 * running, when it last produced output — are only worth anything if they are current,
 * and a single read on open froze them at "0s ago" for as long as the dialog stayed up.
 */
const INFO_REFRESH_MS = 2000;
/** Past this, a skeleton alone stops explaining the wait (the 5s tier of the loading gates). */
const SLOW_LOAD_MS = 5000;

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
 * The label rail.
 *
 * Fixed width, not `auto`: with `auto` the longest label in a group sets the rail for
 * every group, so one 30-character label ("Synchronized output") pushes every value on
 * the surface right and the rail stops being a rail. A fixed rail means labels wrap and
 * values keep one predictable left edge, which is the entire point.
 */
const ROW_GRID = "grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-2";

/**
 * Framed blocks (the overview card, the warning banner) bleed 16px into the body's
 * gutter and pad back by the same amount less their 1px border, so their contents sit
 * on the rail every other group uses. Padded in place, the card's values started 17px
 * right of every value below it — two rails on a surface built around having one.
 */
const GUTTER_BLEED = "-mx-4 px-[calc(--spacing(4)-1px)]";

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

function formatYesNo(value: boolean | undefined, absent: string): string {
  if (value === undefined) return absent;
  return value ? "Yes" : "No";
}

function formatArgsForClipboard(args: string[] | undefined, absent: string): string {
  if (args === undefined) return absent;
  if (args.length === 0) return "(none)";
  // JSON, not a space join: argv boundaries and embedded whitespace are the facts a
  // bug report needs, and a join reconstructs a command line that never existed.
  return JSON.stringify(args);
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
      <dt className="text-text-secondary select-none min-w-0 break-words">{label}</dt>
      <dd className="min-w-0 text-text-primary">
        {!hasValue && pending ? (
          <SkeletonBone className="h-4 w-32" data-testid="terminal-info-pending" />
        ) : (
          // No truncation tooltip. Every value here is a wrapping block, so
          // `useTruncationDetection`'s `scrollWidth > clientWidth` can never fire — the
          // wrapper was buying a ResizeObserver registration and a state hook per row
          // for a tooltip that cannot open, and advertising a contract that isn't real.
          <span
            className={cn(
              "block select-text",
              // `anywhere`, not `break-all`: a path breaks at its separators where it
              // can and mid-token only where it must, so the leaf directory — the
              // informative half — survives instead of being ellipsed away.
              // Only a real value is set in mono. A fallback is prose ("Unavailable", the
              // dash), and setting it in the code face gave the same absence three
              // different glyphs depending on which row it landed in.
              mono && hasValue
                ? "font-mono text-xs [overflow-wrap:anywhere] tabular-nums"
                : "break-words",
              !hasValue && "text-text-secondary"
            )}
          >
            {display}
          </span>
        )}
      </dd>
    </>
  );
}

interface ChipRowProps {
  label: string;
  items: string[] | undefined;
  pending?: boolean;
  /** What to show when there are no items. Defaults to the not-applicable dash. */
  fallback?: string;
}

function ChipRow({ label, items, pending = false, fallback = NONE }: ChipRowProps) {
  const isEmpty = !items || items.length === 0;

  return (
    <>
      <dt className="text-text-secondary select-none min-w-0 break-words">{label}</dt>
      <dd className="min-w-0">
        {isEmpty && pending ? (
          <SkeletonBone className="h-4 w-40" data-testid="terminal-info-pending" />
        ) : isEmpty ? (
          <span className="text-text-secondary">{fallback}</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {items.map((item, i) => (
              <code
                key={`${i}-${item}`}
                // `pre-wrap`: an argument is exact bytes. Collapsing whitespace made a
                // multi-line `-c` script read as one run of words, which is precisely the
                // detail someone opens this dialog to check.
                className="bg-overlay-subtle border border-border-default font-mono text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] select-text whitespace-pre-wrap [overflow-wrap:anywhere]"
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
      <h3 className={SECTION_LABEL_CLASS}>{title}</h3>
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
function DisclosureGroup({
  title,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const panelId = useId();
  const count = Children.toArray(children).filter(isValidElement).length;

  return (
    <section>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={onToggle}
        className={cn(
          // The header spans the gutter the overview card and the warning banner bleed
          // into (`GUTTER_BLEED`), so its hover and focus rectangle has the same edges
          // as those two frames instead of being shoved left by a negative margin. The
          // chevron sits inside that 16px gutter — 2px + 12px + 2px — which puts the
          // label on the same left edge as every static section header.
          "group flex w-[calc(100%+2rem)] -mx-4 items-center gap-0.5 rounded-[var(--radius-sm)] py-1 pl-0.5 pr-4 text-left",
          "transition-colors duration-150 ease-out hover:bg-overlay-subtle",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:-outline-offset-2"
        )}
      >
        <ChevronRight
          aria-hidden="true"
          // `src/index.css` drops the rotation for this marker under reduced motion.
          data-animated-chevron
          className={cn(
            "w-3 h-3 shrink-0 text-text-secondary group-hover:text-text-primary transition-[color,rotate] duration-150 ease-out",
            expanded && "rotate-90"
          )}
        />
        {/*
         * The hover lifts the words as well as the row: `bg-overlay-subtle` alone is a
         * near-invisible wash on the light themes, so on those the fill was the only
         * sign the header was a control.
         */}
        <span
          className={cn(
            SECTION_LABEL_CLASS,
            "group-hover:text-text-primary transition-colors duration-150 ease-out"
          )}
        >
          {title}
        </span>
        {/*
         * The count is what stops a collapsed disclosure reading as a static header:
         * five identical micro-labels, two of which happen to be buttons, is not an
         * affordance. The Git dialogs' section-count chip (`GitOperationPreview`),
         * kept in that family rather than given a look of its own. The hidden noun is
         * what stops a screen reader announcing a bare "10" as if it were a badge.
         */}
        <span className={cn(COUNT_BADGE_CLASS, "ml-1.5")}>
          {count}
          <span className="sr-only"> rows</span>
        </span>
      </button>
      <div id={panelId} hidden={!expanded}>
        {/*
         * No left inset. The fixed rail exists to give the surface ONE vertical
         * scanning axis, and indenting a disclosure's rows put its values 18px right
         * of every other group's — the two groups added last round were the only two
         * that broke the thing they were added alongside.
         */}
        <dl className={cn(ROW_GRID, "text-sm pt-2")}>{children}</dl>
      </div>
    </section>
  );
}

export function TerminalInfoDialog({ isOpen, onClose, terminalId }: TerminalInfoDialogProps) {
  // Keyed to the terminal it was read for. Retargeting the open dialog at another
  // terminal otherwise rendered the new panel's title beside the old one's host data
  // until the next read landed — or indefinitely, if that read failed.
  const [read, setRead] = useState<{ terminalId: string; payload: TerminalInfoPayload } | null>(
    null
  );
  const info = read?.terminalId === terminalId ? read.payload : null;
  const setInfo = (payload: TerminalInfoPayload | null, forTerminal: string) =>
    setRead(payload ? { terminalId: forTerminal, payload } : null);
  // One background read at a time, so a slow reply can never land after a newer one.
  const refreshInFlightRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncMode, setSyncMode] = useState<boolean | null>(null);
  const [showErrorDetail, setShowErrorDetail] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [internalsOpen, setInternalsOpen] = useState(false);
  // Lifted out of the disclosure so the synchronised-output poll can be gated on it:
  // the only genuinely live value on this surface sits inside a group that is closed
  // by default, so the old unconditional poll ran 4x/sec to update a hidden row.
  const [performanceOpen, setPerformanceOpen] = useState(false);
  const [slowLoad, setSlowLoad] = useState(false);
  // Bumped on every fresh read and on close, so a background refresh that resolves
  // after the dialog closed or moved to another terminal is dropped, not rendered.
  const readGenerationRef = useRef(0);
  // The terminal the last foreground read was for. A Retry of the same terminal keeps
  // its warning up until the retry succeeds — clearing it on the way in presented the
  // stale values as current for the whole round trip, and dropped the caveat from any
  // report copied during it.
  const lastReadTerminalRef = useRef<string | null>(null);
  const errorDetailId = useId();
  const panelRaw = usePanelStore((state) => state.panelsById[terminalId]);
  const panel = panelRaw && isPtyPanel(panelRaw) ? panelRaw : undefined;
  const { copied, copy } = useCopyWithFeedback({ announcement: "Diagnostics copied" });

  useEffect(() => {
    readGenerationRef.current += 1;
    if (!isOpen) {
      lastReadTerminalRef.current = null;
      setRead(null);
      setError(null);
      setLoading(false);
      setSyncMode(null);
      setShowErrorDetail(false);
      return;
    }

    let isMounted = true;

    const isRetry = lastReadTerminalRef.current === terminalId;
    lastReadTerminalRef.current = terminalId;

    const fetchInfo = async () => {
      setLoading(true);
      if (!isRetry) setError(null);
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
          setInfo(result.result as TerminalInfoPayload, terminalId);
          setError(null);
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

  // Every opening starts with the deep diagnostics collapsed. The flags used to
  // outlive the dialog, so expanding one terminal's internals silently expanded them
  // for every terminal inspected afterwards. A Retry keeps whatever is open.
  useEffect(() => {
    setInternalsOpen(false);
    setPerformanceOpen(false);
  }, [isOpen, terminalId]);

  // Straight to the IPC, not through `actionService`: a dispatch records itself as
  // the last action and emits `action:dispatched`, which is right for the read the
  // user asked for and noise every two seconds after it.
  const refreshInfo = () => {
    const getInfo = window.electron?.terminal?.getInfo;
    if (!getInfo || refreshInFlightRef.current) return;
    const generation = readGenerationRef.current;
    const forTerminal = terminalId;
    refreshInFlightRef.current = true;
    getInfo(forTerminal)
      .then((next) => {
        if (generation !== readGenerationRef.current) return;
        // An empty answer is the host no longer knowing the terminal. Ignoring it
        // left the last values on screen, presented as current, with no warning.
        if (!next) {
          setError("The terminal host no longer has a record of this terminal");
          return;
        }
        setInfo(next as TerminalInfoPayload, forTerminal);
        setError(null);
      })
      .catch((err: unknown) => {
        if (generation !== readGenerationRef.current) return;
        setError(formatErrorMessage(err, "Lost contact with the terminal host"));
      })
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  };
  useVisibilityAwareInterval(refreshInfo, INFO_REFRESH_MS, isOpen && info !== null);

  useEffect(() => {
    if (!isOpen || !performanceOpen) return;
    // Immediate read on open so the dialog reflects the current sync-mode
    // before the first poll lands. Also fires when the group is expanded, so the
    // first frame after opening it is current rather than up to 250ms stale.
    setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId));
  }, [isOpen, performanceOpen, terminalId]);

  // xterm 6 mutates terminal.modes asynchronously as the parser consumes
  // BSU/ESU sequences, and there is no change event. Poll at the same cadence
  // as REFLOW_THROTTLE_MS (250ms) — enough resolution to catch most BSU blocks
  // while the dialog is open. Visibility-gated so the poll pauses while the
  // window is hidden and snaps back on restore.
  useVisibilityAwareInterval(
    () => setSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId)),
    SYNC_MODE_POLL_MS,
    isOpen && performanceOpen
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
  // `undefined` rather than the string "Unknown", so the row renders it through the
  // fallback in the absence tone like every other undeterminable value.
  const startedViaMcp =
    spawnSource === "mcp" || startedByAssistant ? "Yes" : spawnSource ? "No" : undefined;
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
  // The host's `hasPty` only decides when the store has no status at all; a known
  // status wins outright, or a lagging `hasPty: false` labelled a live terminal dead.
  const hasExited = runtimeStatus ? runtimeStatus === "exited" : info?.hasPty === false;
  // Each field's absence is decided once and read by both the screen and the copied
  // report, so the two can't drift: a host-owned value is "Unavailable" when there is
  // no payload to read it from, "Unknown" when the payload simply lacks it.
  const hostAbsence = info ? UNKNOWN : UNAVAILABLE;
  const processAbsence = hasExited ? NONE : hostAbsence;
  const exitCodeAbsence = hasExited ? UNKNOWN : NONE;
  const resizeStrategy = info ? info.resizeStrategy || "default" : undefined;
  const liveness = hasExited
    ? exitCode != null
      ? `Exited · code ${exitCode}`
      : "Exited"
    : runtimeStatus === "error"
      ? "Error"
      : panel || info
        ? "Running"
        : UNKNOWN;
  // Colour ON the word, never instead of it. The words alone survive
  // `forced-colors: active`, where the UA discards these tints — which is the reason
  // the status is a word and not a pill. Adding a status token costs nothing there and
  // buys the glance everywhere else: a dead terminal and a healthy one were previously
  // the same colour, same weight, same position, differing only in the string.
  const livenessTone =
    hasExited && exitCode !== 0 && exitCode != null
      ? "text-status-error"
      : runtimeStatus === "error"
        ? "text-status-warning"
        : "text-text-primary";

  // The remote read is in flight and has never landed. Rows the payload owns show a
  // delayed skeleton; rows the panel store owns are already correct and never flicker.
  const pending = loading && !info && !error;

  useEffect(() => {
    if (!pending) {
      setSlowLoad(false);
      return;
    }
    const timer = setTimeout(() => setSlowLoad(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  const agentName = agentLabel(detectedAgentId ?? launchAgentId);
  const runningLabel = info?.ptyForegroundProcess ?? (hasExited ? NONE : undefined);
  // An agent that has left a live shell behind. The terminal is still running, so the
  // process row names what is in the foreground now and says what left, rather than
  // reporting the departed agent beside a "Running" status and leaving the reader to
  // work out which of the two is alive.
  const agentGone =
    !!agentName && (agentState === "exited" || (!!everDetectedAgent && !detectedAgentId));
  const processValue =
    agentName && !agentGone
      ? `${agentName}${agentState ? ` · ${agentState}` : ""}`
      : agentGone && runningLabel && runningLabel !== NONE
        ? `${runningLabel} · ${agentName} exited`
        : runningLabel;
  // An exited terminal has no end time on record, so `now - start` is not its
  // runtime — it is how long ago it started. Say that instead of a figure that keeps
  // climbing for a process that stopped.
  const startedAt = info?.spawnedAt ?? uiStartedAt;

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

  /**
   * The full payload, built from data rather than from the DOM.
   *
   * Deliberately independent of which disclosures are open and of whether the remote
   * read succeeded: a support engineer pasting this into an issue must get everything
   * the app knows, and on a terminal whose PTY record is gone the panel-store half is
   * the only half there is.
   */
  const buildDiagnostics = useCallback((): string => {
    // The report states its own provenance, in the same three cases the banner and
    // the loading status distinguish on screen. A pasted report carries no banner.
    const diagnosticsNote = info
      ? error
        ? `  NOTE: the terminal host stopped answering (${error}); process-level values below are from the last successful read.\n`
        : ""
      : error
        ? `  NOTE: the live terminal record could not be read (${error}); the values below come from the panel store only.\n`
        : "  NOTE: the live terminal record was still loading; the values below come from the panel store only.\n";
    const launchSection = showAgentLaunchSection
      ? `

Agent launch:
  Launch agent: ${launchAgentId ?? NONE}
  Command: ${command ?? NONE}
  Launch flags: ${formatArgsForClipboard(agentLaunchFlags, NONE)}
  Model: ${agentModelId ?? NONE}
  Preset: ${agentPresetId ?? NONE}
  Preset color: ${agentPresetColor ?? NONE}
  Original preset: ${originalPresetId ?? NONE}`
      : "";

    const liveSection = showAgentLiveSection
      ? `

Agent state:
  Detected agent: ${detectedAgentId ?? (everDetectedAgent ? "Agent has exited" : "Not detected yet")}
  Agent state: ${agentState ?? NONE}
  Session ID: ${agentSessionId ?? NONE}`
      : "";

    const agentSection = launchSection + liveSection;

    return `Terminal Diagnostic Information
=====================================

Status:
  Liveness: ${liveness}
  Runtime status: ${runtimeStatus ?? UNKNOWN}
  Foreground process: ${info?.ptyForegroundProcess ?? processAbsence}
  Exit code: ${exitCode ?? exitCodeAbsence}
${diagnosticsNote}
Session:
  ID: ${info?.id ?? terminalId}
  Kind: ${info?.kind || panel?.kind || "terminal"}
  Title: ${title ?? NONE}
  Title mode: ${titleMode ?? "default"}
  Project ID: ${info?.projectId || (info ? NONE : UNAVAILABLE)}
  Worktree ID: ${worktreeId || NONE}
  CWD: ${cwd ?? NONE}
  Location: ${location ?? NONE}
  Spawn source: ${spawnSource ?? UNKNOWN}
${startedByAssistant ? "  Started by: Daintree Assistant\n" : ""}  Started via MCP: ${startedViaMcp ?? UNKNOWN}
  UI created at: ${uiStartedAt != null ? formatTimestamp(uiStartedAt) : NONE}

How it launched:
  Shell: ${info?.shell || UNAVAILABLE}
  Command: ${command ?? NONE}
  Args: ${formatArgsForClipboard(info?.spawnArgs, info ? NONE : UNAVAILABLE)}${agentSection}

Terminal internals:
  Agent launch hint: ${launchAgentId ? "Yes" : "No"}
  PTY active: ${formatYesNo(info?.hasPty, hostAbsence)}
  Analysis enabled: ${formatYesNo(info?.analysisEnabled, hostAbsence)}
  Resize strategy: ${resizeStrategy ?? UNAVAILABLE}
  Dimensions: ${info?.ptyCols != null && info?.ptyRows != null ? `${info.ptyCols} × ${info.ptyRows}` : UNAVAILABLE}
  Shell PID: ${info?.ptyPid ?? UNAVAILABLE}
  TTY device: ${info?.ptyTty ?? UNAVAILABLE}

Runtime:
  ${hasExited ? "Started" : "Runtime"}: ${startedAt == null ? UNAVAILABLE : hasExited ? formatRelativeTime(startedAt) : formatDuration(Date.now() - startedAt)}
  Spawned at: ${info ? formatTimestamp(info.spawnedAt) : UNAVAILABLE}
  Restarts: ${info?.restartCount ?? UNAVAILABLE}

Activity:
  Last input: ${info ? `${formatRelativeTime(info.lastInputTime)} (${formatTimestamp(info.lastInputTime)})` : UNAVAILABLE}
  Last output: ${info ? `${formatRelativeTime(info.lastOutputTime)} (${formatTimestamp(info.lastOutputTime)})` : UNAVAILABLE}
  Agent state: ${agentState || NONE}
  Last state change: ${info?.lastStateChange != null ? formatRelativeTime(info.lastStateChange) : NONE}
  Activity tier: ${info?.activityTier ?? UNAVAILABLE}

Performance:
  Output buffer: ${info?.outputBufferSize != null ? `${info.outputBufferSize} lines` : UNAVAILABLE}
  Semantic buffer: ${info?.semanticBufferLines != null ? `${info.semanticBufferLines} lines` : UNAVAILABLE}
  Synchronized output (DEC 2026): ${formatSyncMode(terminalInstanceService.getSynchronizedOutputMode(terminalId))}
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
    exitCodeAbsence,
    hasExited,
    hostAbsence,
    info,
    launchAgentId,
    liveness,
    location,
    originalPresetId,
    panel?.kind,
    processAbsence,
    resizeStrategy,
    runtimeStatus,
    showAgentLaunchSection,
    showAgentLiveSection,
    spawnSource,
    startedAt,
    startedByAssistant,
    startedViaMcp,
    terminalId,
    title,
    titleMode,
    uiStartedAt,
    worktreeId,
  ]);

  const handleCopy = useCallback(() => {
    const payload = buildDiagnostics();
    void copy(payload).then((ok) => {
      if (ok) return;
      // A clipboard rejection is invisible otherwise — the button simply never flips —
      // and the whole point of this surface is getting the payload into a bug report.
      // Timely, actionable, not already visible: that clears the notify() gate.
      notify({
        type: "error",
        title: "Couldn't copy diagnostics",
        message: "The clipboard refused the write. Selecting the values by hand still works.",
        action: { label: "Try again", onClick: () => void copy(payload) },
        context: { eventKind: "settings" },
      });
    });
  }, [buildDiagnostics, copy]);

  // Arrive on the overview's heading rather than the first control: every
  // control here sits below the overview, and focusing one scrolls the body
  // past the answers this dialog deliberately puts first.
  const overviewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => overviewHeadingRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      initialFocus="none"
      data-testid="terminal-info-dialog"
    >
      <AppDialog.Header>
        <AppDialog.Title icon={<Info />}>Terminal information</AppDialog.Title>
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
            className={cn(
              "rounded-[var(--radius-lg)] border border-border-default bg-overlay-subtle py-3 space-y-3",
              GUTTER_BLEED
            )}
            data-testid="terminal-info-overview"
          >
            <div className="flex items-baseline justify-between gap-3">
              <h3
                ref={overviewHeadingRef}
                tabIndex={-1}
                className="text-base font-semibold text-text-primary min-w-0 break-words select-text outline-hidden focus-visible:outline focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent-primary rounded-xs"
              >
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
                className={cn(
                  "text-sm font-medium shrink-0 tabular-nums select-text",
                  livenessTone
                )}
                data-testid="terminal-info-liveness"
              >
                {liveness}
              </span>
            </div>
            <dl className={cn(ROW_GRID, "text-sm")}>
              <Row
                // "Process", not "Running": the status word to the right of the title
                // already owns the word "running", and a dead terminal rendering
                // "Running —" beside "Exited · code 3" reads as a contradiction.
                label="Process"
                value={processValue}
                pending={pending}
                fallback={processAbsence}
              />
              <Row
                label={hasExited ? "Started" : "Runtime"}
                // Falls back to the panel's own `startedAt` when the host read fails,
                // rather than reporting "Unavailable" for a fact this window already
                // has. The UI clock is a few ms later than the PTY's, which does not
                // matter at this resolution.
                value={
                  startedAt == null
                    ? undefined
                    : hasExited
                      ? formatRelativeTime(startedAt)
                      : formatDuration(Date.now() - startedAt)
                }
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

          {/*
           * The bones are decorative, so without this a screen reader heard nothing
           * about the wait at all. It turns visible once the wait passes the 5s tier,
           * where a skeleton on its own stops explaining itself.
           */}
          <p
            role="status"
            className={slowLoad ? "text-xs text-text-secondary" : "sr-only"}
            data-testid="terminal-info-loading-status"
          >
            {pending
              ? slowLoad
                ? "Still loading terminal details…"
                : "Loading terminal details"
              : ""}
          </p>

          {error && (
            <div
              // Warning, not error. The headline answers are intact and correct — this
              // is a partial degradation, which the runtime-signal tiers put at T2. The
              // old treatment was the loudest thing on the surface while its own body
              // text said the values above were still accurate.
              //
              // No tinted fill. A 10% status tint behind this text composites it down
              // below the 4.5:1 floor, where the same token on the bare dialog surface
              // clears it — the tint was costing the banner its legibility to look
              // like a banner.
              className={cn(
                "rounded-[var(--radius-lg)] border border-status-warning/40 py-3 space-y-2",
                GUTTER_BLEED
              )}
              role="alert"
              data-testid="terminal-info-error"
            >
              {/*
               * Two failures, two sentences. A first read that fails leaves only what
               * this window knows — and "couldn't reach the host" overclaimed it, since
               * the commonest cause is the host answering that it has no record of the
               * terminal. A refresh that fails after a good read leaves real values that
               * are no longer current, which is a different thing to be told.
               */}
              <p className="text-sm text-text-primary">
                {info ? (
                  <>
                    <span className="font-semibold text-status-warning">
                      Lost contact with the terminal host.
                    </span>{" "}
                    Process-level values are from the last successful read and may be out of date.
                  </>
                ) : (
                  <>
                    <span className="font-semibold text-status-warning">
                      Couldn&apos;t load live terminal details.
                    </span>{" "}
                    What&apos;s shown comes from this window; process-level detail — PID, TTY,
                    buffers, activity — is missing.
                  </>
                )}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}>
                  Retry
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-expanded={showErrorDetail}
                  aria-controls={errorDetailId}
                  onClick={() => setShowErrorDetail((value) => !value)}
                  className="px-1.5 text-xs"
                >
                  <ChevronRight
                    aria-hidden="true"
                    data-animated-chevron
                    className={cn(
                      "w-3 h-3 shrink-0 transition-transform duration-150 ease-out",
                      showErrorDetail && "rotate-90"
                    )}
                  />
                  Technical details
                </Button>
              </div>
              <p
                id={errorDetailId}
                hidden={!showErrorDetail}
                // `anywhere` rather than `break-all`: the old rule split the terminal
                // UUID mid-token so the wrapped line opened with a bare hyphen that read
                // as a stray dash, and the id could not be selected as one string.
                className="text-xs font-mono [overflow-wrap:anywhere] text-text-primary select-text"
              >
                {error}
              </p>
            </div>
          )}

          {/*
           * "How it launched" leads. `Session` used to, and its first screen was a
           * UUID, two internal constants, and the working directory printed a second
           * time — so question 5 (shell, command, argv) never reached the first screen
           * for anyone while three of the six rows above it answered nothing.
           */}
          <Group title="How it launched">
            <Row label="Shell" value={info?.shell} mono pending={pending} fallback={UNAVAILABLE} />
            <Row label="Command" value={command} mono pending={pending} />
            <ChipRow
              label="Arguments"
              items={info?.spawnArgs}
              pending={pending}
              // No payload means argv could not be read, not that there was none.
              fallback={info ? NONE : UNAVAILABLE}
            />
            {/* Panel-store only: the host read cannot fill it, so it never waits on one. */}
            <Row label="Spawn source" value={spawnSource} fallback={UNKNOWN} />
            {startedByAssistant && <Row label="Started by" value="Daintree Assistant" />}
            <Row label="Started via MCP" value={startedViaMcp} fallback={UNKNOWN} />
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
                  (everDetectedAgent ? "Agent has exited" : "Not detected yet")
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

          <Group title="Session">
            <Row label="Terminal ID" value={info?.id ?? terminalId} mono />
            <Row label="Location" value={location} pending={pending} />
            {/*
             * A worktree is identified by its normalised absolute path, so for the
             * worktree-per-agent workflow this product is built around it is usually
             * character-for-character the directory shown in the overview. Printing it
             * again cost three wrapped lines of the first screen to say nothing.
             */}
            <Row
              label="Worktree"
              value={worktreeId && worktreeId === cwd ? "Same as directory" : worktreeId}
              mono={worktreeId !== cwd}
              pending={pending}
            />
            <Row
              label="Project ID"
              value={info?.projectId}
              mono
              pending={pending}
              fallback={info ? NONE : UNAVAILABLE}
            />
          </Group>

          <DisclosureGroup
            title="Terminal internals"
            expanded={internalsOpen}
            onToggle={() => setInternalsOpen((v) => !v)}
          >
            <Row
              label="PTY active"
              value={formatYesNo(info?.hasPty, hostAbsence)}
              pending={pending}
            />
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
            <Row label="Exit code" value={exitCode} mono fallback={exitCodeAbsence} />
            <Row label="Kind" value={info?.kind || panel?.kind || "terminal"} />
            <Row label="Title mode" value={titleMode ?? "default"} />
            <Row
              label="Resize strategy"
              value={resizeStrategy}
              pending={pending}
              fallback={UNAVAILABLE}
            />
            <Row
              label="Analysis enabled"
              value={formatYesNo(info?.analysisEnabled, hostAbsence)}
              pending={pending}
            />
            <Row label="Agent launch hint" value={launchAgentId ? "Yes" : "No"} />
          </DisclosureGroup>

          <DisclosureGroup
            title="Performance"
            expanded={performanceOpen}
            onToggle={() => setPerformanceOpen((v) => !v)}
          >
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
          // Fixed width: "Copied" is half the width of "Copy diagnostics", so the
          // primary button shrank and slid `Close` across under the pointer for the
          // whole dwell window.
          className="min-w-[10.5rem]"
        >
          {copied ? "Copied" : "Copy diagnostics"}
        </Button>
      </AppDialog.Footer>
    </AppDialog>
  );
}
