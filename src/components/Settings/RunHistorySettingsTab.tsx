import { useEffect, useState } from "react";
import { History, Radio } from "lucide-react";
import { Workflow } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { SettingsGroup } from "@/components/Settings/SettingsGroup";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { useRunHistoryStore } from "@/store/runHistoryStore";
import { cn } from "@/lib/utils";
import type { RunHistoryRecord } from "@shared/types";

function CountPill({ tone, label }: { tone: "success" | "danger" | "muted"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-sm)] px-1.5 py-0.5 text-2xs font-medium",
        tone === "success" && "bg-status-success/15 text-status-success",
        tone === "danger" && "bg-status-error/15 text-status-error",
        tone === "muted" && "bg-overlay-subtle text-text-secondary"
      )}
    >
      {label}
    </span>
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
            <CountPill tone="success" label={`${spawned.length} spawned`} />
            {failed.length > 0 ? (
              <CountPill tone="danger" label={`${failed.length} failed`} />
            ) : null}
            <CountPill tone="muted" label={`${record.totalTerminals} defined`} />
          </div>
        </div>
        <time className="shrink-0 text-xs text-text-secondary">
          {formatRelativeTime(record.timestamp)}
        </time>
      </div>
      {failed.length > 0 ? (
        <ul className="mt-2 space-y-0.5 pl-6.5 text-xs text-status-error">
          {failed.map((f) => (
            <li key={f.index} className="truncate">
              #{f.index}: {f.error}
            </li>
          ))}
        </ul>
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
              <CountPill
                tone={record.status === "failed" ? "danger" : "muted"}
                label={statusLabel}
              />
            ) : null}
          </div>
          {record.draftPreview ? (
            <p className="mt-0.5 truncate text-xs text-text-secondary">{record.draftPreview}</p>
          ) : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <CountPill tone="success" label={`${record.successCount} sent`} />
            {record.failureCount > 0 ? (
              <CountPill tone="danger" label={`${record.failureCount} failed`} />
            ) : null}
            {waitingCount > 0 ? (
              <CountPill tone="muted" label={`${waitingCount} ended waiting`} />
            ) : null}
            <CountPill tone="muted" label={`${record.targetCount} targets`} />
          </div>
        </div>
        <time className="shrink-0 text-xs text-text-secondary">
          {formatRelativeTime(record.timestamp)}
        </time>
      </div>
      {rejected.length > 0 ? (
        <ul className="mt-2 space-y-0.5 pl-6.5 text-xs text-status-error">
          {rejected.map((t) => (
            <li key={t.terminalId} className="truncate">
              {t.title ?? t.terminalId}
              {t.reason ? `: ${t.reason}` : ""}
            </li>
          ))}
        </ul>
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

  useEffect(() => {
    init();
  }, [init]);

  return (
    <div className="space-y-8">
      <SettingsSection
        id="run-history-log"
        title="Recent runs"
        description="Each recipe run and fleet broadcast, so you can review what an automation actually did. Spawned terminals and targets are snapshots, so entries stay readable after a terminal closes. Terminal output and git state aren't duplicated here."
        action={
          records.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setShowClearConfirm(true)}>
              Clear history…
            </Button>
          ) : undefined
        }
      >
        {loading ? null : records.length === 0 ? (
          <EmptyState
            variant="zero-data"
            scale="canvas"
            icon={<History aria-hidden="true" />}
            title="No runs yet"
            description="Run a recipe or broadcast to a fleet and the outcome shows up here."
          />
        ) : (
          <SettingsGroup>
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
          </SettingsGroup>
        )}
      </SettingsSection>

      <ConfirmDialog
        isOpen={showClearConfirm}
        variant="destructive"
        onConfirm={() => void clear()}
        onClose={() => setShowClearConfirm(false)}
        title="Clear run history?"
        description="This permanently deletes all recorded recipe and fleet runs on this machine. New runs will still be recorded."
        confirmLabel="Clear history"
      />
    </div>
  );
}
