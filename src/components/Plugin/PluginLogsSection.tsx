import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Callout } from "@/components/ui/Callout";
import { ArrowDownToLine, PowerOff, RefreshCw, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/CopyButton";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { SeverityMark, type StatusSeverity } from "@/lib/statusSeverity";
import { pluralize } from "@/lib/pluralize";
import { cn } from "@/lib/utils";
import { formatErrorMessage } from "@shared/utils/errorMessage";
import { pluginClient } from "@/clients/pluginClient";
import type { PluginDiagnosticsLogLine } from "@shared/types/ipc/pluginDiagnostics";
import { parseProjectPluginInstanceKey } from "@shared/types/plugin";

/**
 * The per-plugin log ring buffer, surfaced where its author will look (#12214).
 * The buffer has existed for as long as `host.logger` has, but only ever fed
 * the shareable bug report — so an author watching their own plugin misbehave
 * had no way to read what it had logged.
 *
 * Pull, not push: there is no log-push channel, and adding one to feed a tab
 * that is usually closed would cost more than a button. The buffer is bounded
 * and lines arrive already scrubbed of secrets, so a manual refresh is enough.
 */

/**
 * The console's encoding (`ConsolePanel`'s LEVEL_STYLES): an info line is
 * plain, the louder levels carry the shared severity glyph and a faint wash of
 * its colour, so they are found by shape as well as hue. The message itself
 * stays on the primary ramp — tinted text was the only signal before, and it
 * vanished under forced colours along with the levels.
 */
const LEVEL_MARK: Record<
  PluginDiagnosticsLogLine["level"],
  { severity: StatusSeverity; label: string; row: string } | null
> = {
  info: null,
  warn: { severity: "warning", label: "Warning", row: "bg-status-warning/5" },
  error: { severity: "error", label: "Error", row: "bg-status-danger/5" },
};

const LEVEL_TEXT: Record<PluginDiagnosticsLogLine["level"], string> = {
  info: "INFO",
  warn: "WARN",
  error: "ERROR",
};

/** Timestamp, mark, message: fixed tracks so every message starts on one edge. */
const ROW_CLASS =
  "grid grid-cols-[auto_0.75rem_minmax(0,1fr)] items-start gap-x-2 px-3 py-1.5 font-mono text-xs leading-4";

export interface PluginLogsState {
  /** Buffered lines, or null when the host isn't running this plugin at all. */
  lines: PluginDiagnosticsLogLine[] | null;
  loading: boolean;
  error: string | null;
  /** When the last successful read landed, so a snapshot's age is never confused with its lines'. */
  readAt: number | null;
  /**
   * The buffer has had lines at some point in this pane's life. What earns the
   * Logs surface: once offered it stays, so a refresh that finds the buffer
   * emptied or the plugin stopped can say so instead of taking the tab away.
   */
  hasLogged: boolean;
  refresh: () => void;
}

/**
 * Reads one plugin's log buffer. Lives in the detail pane rather than in the
 * tab body because the tab has to be *earned by content* (#11302) — the pane
 * cannot decide whether to offer a Logs tab without already knowing whether
 * there is anything in it.
 *
 * `projectId` names the owning project of a project-owned plugin, and is what
 * keeps two projects shipping the same manifest id apart. Omit it for an
 * installed or builtin plugin, which is its own instance key.
 */
export function usePluginLogs(pluginId: string, projectId?: string): PluginLogsState {
  const [lines, setLines] = useState<PluginDiagnosticsLogLine[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  // Keyed rather than a bare flag, so a hook handed a different plugin does not
  // inherit the previous one's earned surface.
  const instanceKey = `${projectId ?? ""}\u0000${pluginId}`;
  const [loggedKey, setLoggedKey] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // A monotonic request token, because `mountedRef` alone does not order
  // overlapping reads: StrictMode's cleanup/setup pair flips it false then true
  // again, and two rapid refreshes can resolve out of order. Only the newest
  // request may write, so a slow first response cannot overwrite a fresh one.
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const snapshot = await pluginClient.getDiagnosticsSnapshot();
      if (!mountedRef.current || request !== requestRef.current) return;
      // A project plugin appears in the app-global snapshot under its instance
      // key (`project__{projectId}__{publisher.name}`), never its bare manifest
      // id — and the pane knows it only by the manifest name. Two rules keep
      // that resolution from answering with the wrong plugin's lines:
      //
      // 1. The exact id wins outright, so a scan is never decided by where a
      //    project instance happens to sit in the app-global array.
      // 2. A caller that names an owning project accepts only that project's
      //    instance. Matching the key's tail alone also matches the SAME id in
      //    another open project, which is the leak the action side already
      //    guards against (see `plugin.diagnostics` in pluginActions).
      const entry =
        snapshot.plugins.find((plugin) => plugin.pluginId === pluginId) ??
        snapshot.plugins.find((plugin) => {
          const parsed = parseProjectPluginInstanceKey(plugin.pluginId);
          if (!parsed || parsed.manifestId !== pluginId) return false;
          return projectId === undefined || parsed.projectId === projectId;
        });
      // `null` (not running, so no buffer) and `[]` (ran, logged nothing) are
      // different answers to an author's question, and the caller renders them
      // differently.
      setLines(entry ? entry.logLines : null);
      setError(null);
      setReadAt(Date.now());
      if (entry && entry.logLines.length > 0) setLoggedKey(instanceKey);
    } catch (err) {
      if (!mountedRef.current || request !== requestRef.current) return;
      setError(formatErrorMessage(err, "Couldn't read this plugin's log buffer"));
    } finally {
      if (mountedRef.current && request === requestRef.current) setLoading(false);
    }
  }, [pluginId, projectId, instanceKey]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  return {
    lines,
    loading,
    error,
    readAt,
    hasLogged: loggedKey === instanceKey,
    refresh: () => void refresh(),
  };
}

/**
 * Presentational half. Every state it renders is reachable: the surface is
 * earned by the buffer having had lines, and once earned it stays while a
 * refresh empties the buffer (a reload clears it), finds the plugin stopped, or
 * fails to read at all.
 */
export function PluginLogsSection({ lines, loading, error, readAt, refresh }: PluginLogsState) {
  const hasLines = lines !== null && lines.length > 0;
  const listRef = useRef<HTMLOListElement>(null);
  // Starts pinned: the newest lines are what an author refreshes for, and in a
  // full buffer they sit at the bottom. Scrolling up to read unpins it, so a
  // refresh never yanks the author away from the line they were on.
  const [pinned, setPinned] = useState(true);

  // A failed refresh keeps the lines it already had — the hook leaves them in
  // place — so the author loses nothing they could read a moment ago, and the
  // caption dates them as the last good read.
  let status = "";
  if (loading && readAt !== null) status = "Refreshing…";
  else if (readAt !== null) {
    const read = `${error ? "Last read" : "Read"} at ${formatTimestamp(readAt)}`;
    status = hasLines ? `${pluralize(lines.length, "line")} · ${read}` : read;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-text-secondary">
          What this plugin wrote through its logger since it last loaded, oldest first. Kept in
          memory only.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {hasLines && (
            <CopyButton
              aria-label="Copy log lines"
              text={() => lines.map(serializeLine).join("\n")}
            />
          )}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              if (!loading) refresh();
            }}
            // Busy, not unavailable: the rotating glyph says so, at full
            // strength, and the button keeps keyboard focus.
            aria-busy={loading || undefined}
            aria-disabled={loading || undefined}
          >
            <SpinningIcon icon={RefreshCw} active={loading} />
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <Callout severity="error" size="compact" role="alert">
          <p>{error}</p>
        </Callout>
      )}

      {hasLines ? (
        <LogList lines={lines} listRef={listRef} pinned={pinned} onPinnedChange={setPinned} />
      ) : error ? null : lines === null && loading ? (
        <LogListSkeleton />
      ) : lines === null ? (
        <Callout severity="neutral" size="compact" icon={PowerOff} title="Plugin isn't running">
          <p>
            Plugins start the first time one of their commands or panels is used. Refresh after that
            to read what it logs.
          </p>
        </Callout>
      ) : (
        <Callout
          severity="neutral"
          size="compact"
          icon={ScrollText}
          title="Use the plugin, then refresh"
        >
          <p>Nothing&apos;s been logged since the plugin last reloaded, which clears the buffer.</p>
        </Callout>
      )}

      <div className="flex min-h-6 items-center justify-between gap-3">
        {/* Polite, so a refresh is heard to finish; the lines themselves are not
            a live region, since a whole buffer arriving at once would flood it. */}
        <p role="status" className="text-2xs text-text-secondary tabular-nums">
          {status}
        </p>
        {hasLines && !pinned && (
          <Button
            variant="ghost"
            size="xs"
            className="shrink-0"
            onClick={(event) => {
              const el = listRef.current;
              if (el) {
                el.scrollTop = el.scrollHeight;
                // The button unmounts once pinned, so focus moves to the list
                // it acted on rather than falling to the body; ringed only when
                // the jump came from the keyboard.
                el.focus({ preventScroll: true, focusVisible: event.detail === 0 });
              }
              setPinned(true);
            }}
          >
            <ArrowDownToLine aria-hidden="true" />
            Jump to latest
          </Button>
        )}
      </div>
    </div>
  );
}

const WELL_CLASS =
  "rounded-[var(--radius-md)] border border-border-default bg-surface-canvas overflow-hidden";

interface TrackedLines {
  lines: PluginDiagnosticsLogLine[];
  ids: number[];
  next: number;
}

function sameLine(a: PluginDiagnosticsLogLine, b: PluginDiagnosticsLogLine): boolean {
  return a.ts === b.ts && a.level === b.level && a.message === b.message;
}

/**
 * Carries each line's identity from one read to the next. Lines carry no id,
 * and the buffer drops its oldest lines as it fills, so neither the index nor
 * anything inside a line (two lines can share a timestamp and a message) names
 * one. A ring buffer only drops from the front and appends at the back, so the
 * new read opens with some tail of the previous one: the earliest offset where
 * that holds lines the two reads up, the overlap keeps its ids, and the rest
 * are new.
 */
function trackLines(prev: TrackedLines, lines: PluginDiagnosticsLogLine[]): TrackedLines {
  const old = prev.lines;
  let next = prev.next;
  for (let offset = 0; offset < old.length; offset++) {
    const overlap = Math.min(old.length - offset, lines.length);
    let matches = true;
    for (let i = 0; i < overlap && matches; i++) matches = sameLine(old[offset + i]!, lines[i]!);
    if (!matches) continue;
    const ids = lines.map((_, i) => (i < overlap ? prev.ids[offset + i]! : next++));
    return { lines, ids, next };
  }
  return { lines, ids: lines.map(() => next++), next };
}

const UNTRACKED: TrackedLines = { lines: [], ids: [], next: 0 };

function useLineIds(lines: PluginDiagnosticsLogLine[]): number[] {
  const [tracked, setTracked] = useState(() => trackLines(UNTRACKED, lines));
  if (tracked.lines === lines) return tracked.ids;
  // Derived from the previous read, so it is adjusted during render rather
  // than in an effect that would paint one frame of wrong keys first.
  const current = trackLines(tracked, lines);
  setTracked(current);
  return current.ids;
}

// Outside the component: the scroller arrives through a prop ref, and the
// compiler bails on a component that writes to a prop's object.
function restoreScroll(
  el: HTMLOListElement,
  anchor: { key: string; offset: number } | null,
  pinned: boolean
): void {
  if (pinned) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  if (!anchor) return;
  const row = el.querySelector<HTMLElement>(`[data-line-key="${anchor.key}"]`);
  if (row) el.scrollTop = row.offsetTop - anchor.offset;
}

function LogList({
  lines,
  listRef,
  pinned,
  onPinnedChange,
}: {
  lines: PluginDiagnosticsLogLine[];
  listRef: RefObject<HTMLOListElement | null>;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
}) {
  // The first visible line and its distance from the top, while unpinned. A
  // refresh that drops the oldest lines would otherwise slide the text under
  // the author by however many lines fell off.
  const anchorRef = useRef<{ key: string; offset: number } | null>(null);
  const ids = useLineIds(lines);

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    restoreScroll(el, pinned ? null : anchorRef.current, pinned);
  }, [lines, pinned, listRef]);

  return (
    <div className={WELL_CLASS}>
      <ol
        ref={listRef}
        aria-label="Plugin log"
        // Focusable on purpose: the scroller is how a keyboard reads the
        // buffer, and Jump to latest hands focus back to it.
        tabIndex={0}
        onScroll={(event) => {
          const el = event.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
          if (atBottom !== pinned) onPinnedChange(atBottom);
          const first = Array.from(el.children).find(
            (child): child is HTMLElement =>
              child instanceof HTMLElement && child.offsetTop + child.offsetHeight > el.scrollTop
          );
          anchorRef.current = first?.dataset.lineKey
            ? { key: first.dataset.lineKey, offset: first.offsetTop - el.scrollTop }
            : null;
        }}
        className="relative max-h-96 overflow-auto divide-y divide-border-default/50 focus-visible:-outline-offset-2"
      >
        {lines.map((line, index) => {
          const mark = LEVEL_MARK[line.level];
          const key = String(ids[index]);
          return (
            <li key={key} data-line-key={key} className={cn(ROW_CLASS, mark?.row)}>
              <span className="text-text-secondary tabular-nums select-none">
                {formatTimestamp(line.ts)}
              </span>
              {/* One line tall, so the glyph sits on the message's first line. */}
              <span className="flex h-4 items-center">
                {mark && (
                  <SeverityMark severity={mark.severity} label={mark.label} className="h-3 w-3" />
                )}
              </span>
              <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] select-text text-text-primary">
                {line.message}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5"];

/** Row-shaped bones in the list's own well, so the first read lands without a jump. */
function LogListSkeleton() {
  return (
    <Skeleton label="Loading logs" className={cn(WELL_CLASS, "divide-y divide-border-default/50")}>
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className={ROW_CLASS}>
          <SkeletonBone className="h-3 w-[8ch] mt-0.5" />
          <span />
          <SkeletonBone className={cn("h-3 mt-0.5", width)} />
        </div>
      ))}
    </Skeleton>
  );
}

function serializeLine(line: PluginDiagnosticsLogLine): string {
  return `${formatTimestamp(line.ts)} ${LEVEL_TEXT[line.level]} ${line.message}`;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, { hour12: false });
}
