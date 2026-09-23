import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SeverityMark } from "@/lib/statusSeverity";
import { Button } from "@/components/ui/button";
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

function isTimeRange(value: string): value is AuditTimeRange {
  return TIME_RANGE_OPTIONS.some((o) => o.value === value);
}

const FIELD_CLASS =
  "h-7 min-w-0 bg-surface-canvas border border-border-strong rounded-[var(--radius-md)] px-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-primary focus-visible:outline-offset-2";

/** The filter row at the top of an audit log group. */
export function AuditFilterBar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="search"
      aria-label={label}
      className="grid grid-cols-[minmax(10rem,1fr)_minmax(10rem,1fr)_auto_auto] gap-2 px-4 py-3"
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
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className={cn(FIELD_CLASS, "placeholder:text-text-placeholder")}
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
    <select
      value={value}
      onChange={(e) => {
        const next = options.find((o) => o.value === e.target.value);
        if (next) onChange(next.value);
      }}
      aria-label={ariaLabel}
      className={FIELD_CLASS}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
    <select
      value={value}
      onChange={(e) => {
        if (isTimeRange(e.target.value)) onChange(e.target.value);
      }}
      aria-label="Filter audit by time range"
      className={FIELD_CLASS}
    >
      {TIME_RANGE_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function formatAuditAge(ts: number, now: number): string {
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** A record's age, with the exact time one hover (or one screen-reader read) away. */
export function AuditRecordTime({ ts, now }: { ts: number; now: number }) {
  const date = new Date(ts);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString()}>
      {formatAuditAge(ts, now)}
    </time>
  );
}

/**
 * A log that couldn't be read, in the place its rows would be — so a failed read
 * never passes for an empty log.
 */
export function AuditLoadErrorRow({ message, onRetry }: { message: string; onRetry: () => void }) {
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
