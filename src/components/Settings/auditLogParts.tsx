import { Fragment, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { SEVERITY_GLYPH, SeverityMark } from "@/lib/statusSeverity";
import { OctagonAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/SearchField";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { formatElapsedDuration } from "@/utils/formatElapsedDuration";
import { cn } from "@/lib/utils";
import type { ForgeAnomalyKind } from "@shared/types/ipc/forge";
import type { McpAnomalyKind, McpAnomalySeverity } from "@shared/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsEmptyRow } from "./SettingsGroup";

/**
 * The pieces every settings audit log shares — filter fields, the time-range
 * choice, and how a record's time is shown — so the MCP and plugin logs read as
 * one family instead of drifting apart one fix at a time.
 */

export type AuditTimeRange = "5m" | "1h" | "24h" | "all";

export const AUDIT_TIME_RANGE_MS: Record<Exclude<AuditTimeRange, "all">, number> = {
  "5m": 300_000,
  "1h": 3_600_000,
  "24h": 86_400_000,
};

const TIME_RANGE_OPTIONS: { value: AuditTimeRange; label: string }[] = [
  { value: "all", label: "All time" },
  { value: "5m", label: "Last 5 minutes" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
];

/** The filter row at the top of an audit log group. */
export function AuditFilterBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="search"
      aria-label={label}
      // Fixed tracks for the two selects: a trigger sizes to its current value,
      // so an auto track would shift the bar on every pick.
      className="grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_9.5rem_8rem] gap-2 px-4 py-3"
    >
      {children}
    </div>
  );
}

export function AuditFilterInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  return (
    <SearchField
      size="compact"
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClear={() => onChange("")}
      // Each bar holds two of these, so the clear buttons name their field.
      clearLabel={`Clear ${ariaLabel.charAt(0).toLowerCase()}${ariaLabel.slice(1)}`}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}

export function AuditFilterSelect<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly { value: T; label: string }[];
  ariaLabel: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const match = options.find((o) => o.value === next);
        if (match) onChange(match.value);
      }}
    >
      <SelectTrigger density="compact" aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AuditTimeRangeSelect({
  value,
  onChange,
}: {
  value: AuditTimeRange;
  onChange: (value: AuditTimeRange) => void;
}) {
  return (
    <AuditFilterSelect
      value={value}
      onChange={onChange}
      options={TIME_RANGE_OPTIONS}
      ariaLabel="Filter audit by time range"
    />
  );
}

/** The label `AuditRecordTime` prints, for callers that skip re-renders when it holds. */
export function auditAgeLabel(ts: number, now: number): string {
  return formatRelativeTime(ts, Math.max(now, ts));
}

/** A record's age, with the exact time one hover (or one screen-reader read) away. */
export function AuditRecordTime({ ts, now }: { ts: number; now: number }) {
  return <TimeAgo timestamp={ts} now={Math.max(now, ts)} verbose />;
}

/** A measured call time, in the one format every audit surface uses: "64ms", "4.8s". */
export function AuditDuration({ ms }: { ms: number }) {
  return <>{formatElapsedDuration(ms, { subSecond: true })}</>;
}

/**
 * One audit-log record: its outcome mark, its details, and its age over its
 * duration. The mark track is a fixed width, so every row's details start on
 * one edge whatever else a row carries, and both text columns step down in the
 * same 16px lines with the same gap, so the duration sits on the details'
 * second line.
 */
export const AUDIT_ROW_CLASS =
  "grid grid-cols-[0.75rem_minmax(0,1fr)_auto] items-start gap-x-2 px-4 py-2 text-xs leading-4";

export const AUDIT_ROW_DETAIL_CLASS = "flex min-w-0 flex-col gap-0.5 select-text";

/** The outcome mark, centred on the row's first line of text. */
export function AuditRowMark({ children }: { children: ReactNode }) {
  return <div className="flex h-4 items-center">{children}</div>;
}

/**
 * The row's right column: its `AuditRecordTime`, then its `AuditDuration`.
 * A class rather than a component so each row renders its own age, which is
 * what a minute tick re-renders and what the tick test counts.
 */
export const AUDIT_ROW_META_CLASS =
  "flex flex-col items-end gap-0.5 text-text-secondary whitespace-nowrap tabular-nums";

const SEPARATOR_BREAK = /(?<=[./:,])/;
const ID_BREAK = /(?<=[./:,])|(?<=[a-z0-9])(?=[A-Z])/;

/**
 * Text that wraps at its own separators (`.`, `/`, `:`, `,`) before it wraps
 * anywhere else, so an id or a JSON summary breaks between segments rather than
 * mid-word whenever a boundary is available. Identifiers also break at
 * camel-case word starts; a JSON summary doesn't, since a key split there reads
 * as two keys.
 */
function withSegmentBreaks(text: string, pattern: RegExp = SEPARATOR_BREAK): ReactNode {
  return text.split(pattern).map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

/** A monospace identifier in a row — method, tool, repo, provider — shown whole. */
export function AuditId({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("min-w-0 font-mono [overflow-wrap:anywhere]", className)}>
      {withSegmentBreaks(children, ID_BREAK)}
    </span>
  );
}

/**
 * A namespaced tool id where the column is too narrow for it: the last segment
 * — the part that tells `terminal.sendCommand` from `terminal.sendCommandMany` —
 * is always shown whole, wrapping onto its own line when the two don't fit, and
 * only an over-long namespace is shortened, with the full id in its tooltip.
 */
export function AuditToolId({ id }: { id: string }) {
  const cut = id.lastIndexOf(".");
  if (cut <= 0 || cut === id.length - 1) {
    return <span className="[overflow-wrap:anywhere]">{withSegmentBreaks(id, ID_BREAK)}</span>;
  }
  return (
    <span className="flex flex-wrap">
      <TruncatedTooltip content={id} contentClassName="font-mono [overflow-wrap:anywhere]">
        <span className="max-w-full truncate">{id.slice(0, cut + 1)}</span>
      </TruncatedTooltip>
      <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">
        {withSegmentBreaks(id.slice(cut + 1), ID_BREAK)}
      </span>
    </span>
  );
}

/**
 * A record's argument summary: three lines, then an inline "Show more" that
 * opens the rest in place. Inline rather than a tooltip because the summary is
 * read at length and copied, which a tooltip can hold neither of. The toggle
 * appears only while the clamp actually cuts text — measured, so it follows the
 * column width rather than a character count.
 */
export function AuditArgs({
  text,
  subject,
}: {
  text: string;
  /** The record's identifier, so the toggle is named for its record in a list of them. */
  subject?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const textId = useId();

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div className="flex flex-col items-start gap-0.5">
      <div
        ref={textRef}
        id={textId}
        className={cn(
          "w-full font-mono text-text-secondary [overflow-wrap:anywhere]",
          !expanded && "line-clamp-3"
        )}
      >
        {withSegmentBreaks(text)}
      </div>
      {(clamped || expanded) && (
        <Button
          variant="link"
          aria-expanded={expanded}
          aria-controls={textId}
          aria-label={
            subject ? `${expanded ? "Show less" : "Show more"}: ${subject} arguments` : undefined
          }
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

/** What each anomaly detector found, in words, for the row it flagged and the summary line. */
export const AUDIT_ANOMALY_KIND_LABEL: Record<ForgeAnomalyKind | McpAnomalyKind, string> = {
  "latency-drift": "Latency drift",
  "p95-z-score": "p95 outlier",
  "failure-cluster": "Failure cluster",
  "first-seen-method": "First-seen method",
  "first-seen-combination": "First-seen tool and tier",
};

/**
 * An anomaly is a caution, not an outcome: a flagged call may well have
 * succeeded. So the danger level is `OctagonAlert`, the severe-caution glyph,
 * never the failure glyph the outcome mark beside it may already be showing.
 */
const ANOMALY_GLYPH: Record<McpAnomalySeverity, { Icon: typeof OctagonAlert; tone: string }> = {
  info: { Icon: SEVERITY_GLYPH.info, tone: "text-text-secondary" },
  warning: { Icon: SEVERITY_GLYPH.warning, tone: "text-status-warning" },
  danger: { Icon: OctagonAlert, tone: "text-status-danger" },
};

/** Decorative unless `label` is given; the label is spoken, never a hover title. */
/** What the glyph is called aloud, by level; settings tests read these names. */
const ANOMALY_SPOKEN_LABEL: Record<McpAnomalySeverity, string> = {
  info: "Anomaly (info)",
  warning: "Anomaly (warning)",
  danger: "Anomaly (error)",
};

export function AuditAnomalyGlyph({
  severity,
  label,
}: {
  severity: McpAnomalySeverity;
  label?: string;
}) {
  const { Icon, tone } = ANOMALY_GLYPH[severity];
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className="inline-flex h-3 w-3 shrink-0"
    >
      <Icon aria-hidden="true" className={cn("h-full w-full", tone)} />
    </span>
  );
}

/**
 * Why a record was flagged, beside its outcome: the mark plus the detectors'
 * findings in words, so the row says what the summary line only counts.
 */
export function AuditAnomalyNote({
  severity,
  kinds,
}: {
  severity: McpAnomalySeverity;
  kinds: readonly (ForgeAnomalyKind | McpAnomalyKind)[];
}) {
  if (kinds.length === 0) return null;
  const words = kinds.map((kind, i) => {
    const label = AUDIT_ANOMALY_KIND_LABEL[kind] ?? kind;
    return i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1);
  });
  // Only the glyph is fixed: several overlapping findings wrap within the
  // details column rather than running into the age beside it.
  return (
    <span className="inline-flex min-w-0 max-w-full items-start gap-1 text-text-secondary">
      <span className="flex h-4 shrink-0 items-center">
        <AuditAnomalyGlyph severity={severity} label={ANOMALY_SPOKEN_LABEL[severity]} />
      </span>
      <span className="min-w-0">{words.join(", ")}</span>
    </span>
  );
}

/**
 * A read or write that failed, in the place its content or control lives, with
 * a Retry that repeats it — so a failed read never passes for an empty log and a
 * failed save never passes for the old value.
 */
export function ErrorRetryRow({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <SettingsEmptyRow
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      }
    >
      <span role="alert" className="flex items-start gap-2 text-text-primary">
        <SeverityMark severity="error" label="Error" className="mt-0.5 h-3.5 w-3.5" decorative />
        {message}
      </span>
    </SettingsEmptyRow>
  );
}

/** A failed action, shown in its group right beside the control or actions it belongs to. */
export function InlineErrorRow({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-2 px-4 py-2.5 text-xs text-text-primary">
      <SeverityMark severity="error" label="Error" className="mt-px h-3.5 w-3.5" decorative />
      <span>{children}</span>
    </p>
  );
}
