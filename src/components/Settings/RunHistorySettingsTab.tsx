import { useEffect, useState } from "react";
import { Copy, Radio } from "lucide-react";
import { Workflow } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import {
  SettingsActions,
  SettingsEmptyRow,
  SettingsGroup,
  SettingsRow,
} from "@/components/Settings/SettingsGroup";
import { InlineErrorRow } from "@/components/Settings/auditLogParts";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { SeverityMark } from "@/lib/statusSeverity";
import { useRunHistoryStore } from "@/store/runHistoryStore";
import type { RunHistoryRecord } from "@shared/types";

const COPY_FEEDBACK_MS = 2000;

function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * A neutral count. Failures carry the error glyph rather than a red fill: severity
 * text fails 4.5:1 on most themes, and a count of zero is not a success.
 */
function CountPill({ label, failed = false }: { label: string; failed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-overlay-subtle px-1.5 py-0.5 text-2xs font-medium text-text-secondary">
      {failed && <SeverityMark severity="error" label="Failed" className="h-3 w-3" decorative />}
      {label}
    </span>
  );
}

function RunTime({ timestamp }: { timestamp: number }) {
  const date = new Date(timestamp);
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString()}
      className="shrink-0 text-xs text-text-secondary"
    >
      {formatRelativeTime(timestamp)}
    </time>
  );
}

/** Per-target failures, in the row's text colour with the error glyph as the signal. */
function FailureList({ items }: { items: { key: string | number; text: string }[] }) {
  return (
    <ul className="mt-2 space-y-1 pl-6.5 text-xs text-text-primary select-text">
      {items.map((item) => (
        <li key={item.key} className="flex items-start gap-1.5">
          <SeverityMark severity="error" label="Failed" className="mt-px h-3.5 w-3.5" />
          <span className="min-w-0 break-words">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}

function RecipeRunRow({ record }: { record: Extract<RunHistoryRecord, { kind: "recipe" }> }) {
  const spawned = record.spawned ?? [];
  const failed = record.failed ?? [];
  return (
    <>
      <div className="flex items-start gap-2.5">
        <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-primary">
              {record.recipeName}
            </span>
            {record.worktreeName ? (
              <span className="truncate text-xs text-text-secondary">{record.worktreeName}</span>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <CountPill label={`${spawned.length} spawned`} />
            {failed.length > 0 ? <CountPill failed label={`${failed.length} failed`} /> : null}
            <CountPill label={`${record.totalTerminals} defined`} />
          </div>
        </div>
        <RunTime timestamp={record.timestamp} />
      </div>
      {failed.length > 0 ? (
        <FailureList
          items={failed.map((f) => ({ key: f.index, text: `#${f.index}: ${f.error}` }))}
        />
      ) : null}
    </>
  );
}

const FLEET_RUN_STATUS_LABELS: Record<string, string> = {
  completed: "Finished",
  cancelled: "Cancelled",
  failed: "Failed",
  superseded: "Superseded",
};

function FleetRunRow({ record }: { record: Extract<RunHistoryRecord, { kind: "fleet" }> }) {
  const rejected = (record.perTarget ?? []).filter((t) => t.status === "rejected");
  // Supervised records (#10930) carry an explicit outcome; older records only
  // have the `cancelled` boolean, so fall back to it.
  const statusLabel = record.status
    ? FLEET_RUN_STATUS_LABELS[record.status]
    : record.cancelled
      ? "Cancelled"
      : undefined;
  const waitingCount = (record.perTarget ?? []).filter(
    (t) => t.status === "fulfilled" && t.finalAgentState === "waiting"
  ).length;
  return (
    <>
      <div className="flex items-start gap-2.5">
        <Radio className="mt-0.5 h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-text-primary">
              {record.isRetry ? "Fleet retry" : "Fleet broadcast"}
            </span>
            {statusLabel && statusLabel !== "Finished" ? (
              <CountPill failed={record.status === "failed"} label={statusLabel} />
            ) : null}
          </div>
          {record.draftPreview ? (
            <p
              className="mt-0.5 line-clamp-2 text-xs text-text-secondary select-text"
              title={record.draftPreview}
            >
              {record.draftPreview}
            </p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <CountPill label={`${record.successCount} sent`} />
            {record.failureCount > 0 ? (
              <CountPill failed label={`${record.failureCount} failed`} />
            ) : null}
            {waitingCount > 0 ? <CountPill label={`${waitingCount} ended waiting`} /> : null}
            <CountPill label={plural(record.targetCount, "target")} />
          </div>
        </div>
        <RunTime timestamp={record.timestamp} />
      </div>
      {rejected.length > 0 ? (
        <FailureList
          items={rejected.map((t) => ({
            key: t.terminalId,
            text: `${t.title ?? t.terminalId}${t.reason ? `: ${t.reason}` : ""}`,
          }))}
        />
      ) : null}
    </>
  );
}

export function RunHistorySettingsTab() {
  const records = useRunHistoryStore((s) => s.records);
  const loading = useRunHistoryStore((s) => s.loading);
  const init = useRunHistoryStore((s) => s.init);
  const clear = useRunHistoryStore((s) => s.clear);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [clearFailed, setClearFailed] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    init();
  }, [init]);

  // ConfirmDialog doesn't close itself, so the dialog stays up (with its button
  // busy) until the clear has actually landed or failed.
  const confirmClear = async () => {
    if (isClearing) return;
    setIsClearing(true);
    setClearFailed(false);
    const ok = await clear();
    setIsClearing(false);
    setShowClearConfirm(false);
    if (ok) setCleared(true);
    else setClearFailed(true);
  };

  // Snapshots of what each run did, so a failed fleet send can be reported
  // without reconstructing it by hand.
  const copyRecords = async () => {
    setCopyFailed(false);
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      setCopyFailed(true);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        id="run-history-log"
        title="Recent runs"
        description="Each recipe run and fleet broadcast, with what it spawned or sent. Entries are snapshots, so they stay readable after a terminal closes."
      >
        <SettingsGroup>
          {loading ? (
            <Skeleton label="Loading run history" className="space-y-3 px-4 py-3">
              <SkeletonBone className="h-5 w-2/3" />
              <SkeletonBone className="h-5 w-1/2" />
            </Skeleton>
          ) : records.length === 0 ? (
            <SettingsEmptyRow>
              Run a recipe or broadcast to a fleet and the outcome shows up here
            </SettingsEmptyRow>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {records.map((record) => (
                <li key={record.id} className="px-4 py-3">
                  {record.kind === "recipe" ? (
                    <RecipeRunRow record={record} />
                  ) : (
                    <FleetRunRow record={record} />
                  )}
                </li>
              ))}
            </ul>
          )}
          {!loading && records.length > 0 && (
            <SettingsActions status={copied ? "Copied!" : plural(records.length, "run")}>
              <Button variant="outline" size="sm" onClick={() => void copyRecords()}>
                <Copy aria-hidden="true" />
                Copy all as JSON
              </Button>
            </SettingsActions>
          )}
          {copyFailed && (
            <InlineErrorRow>Run history couldn&apos;t be copied. Try again.</InlineErrorRow>
          )}
          <SettingsRow
            label="Clear run history"
            description="Deletes every recorded run on this machine. New runs are still recorded."
            error={clearFailed ? "Run history couldn't be cleared. Try again." : undefined}
            control={
              <Button
                variant="ghost-danger"
                size="sm"
                onClick={() => setShowClearConfirm(true)}
                disabled={loading || records.length === 0}
              >
                Clear history…
              </Button>
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <p className="sr-only" role="status">
        {cleared ? "Run history cleared" : ""}
      </p>

      <ConfirmDialog
        isOpen={showClearConfirm}
        variant="destructive"
        onConfirm={() => void confirmClear()}
        onClose={isClearing ? undefined : () => setShowClearConfirm(false)}
        isConfirmLoading={isClearing}
        title="Clear run history?"
        description={`This permanently deletes ${plural(records.length, "recorded run")} on this machine. New runs will still be recorded.`}
        confirmLabel="Clear history"
      />
    </div>
  );
}
