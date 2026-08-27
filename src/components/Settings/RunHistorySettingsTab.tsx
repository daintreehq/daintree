import { useEffect, useState } from "react";
import { History, Radio, Trash2 } from "lucide-react";
import { Workflow } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { SettingsSection } from "@/components/Settings/SettingsSection";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { useRunHistoryStore } from "@/store/runHistoryStore";
import { cn } from "@/lib/utils";
import type { RunHistoryRecord } from "@shared/types";

function CountPill({ tone, label }: { tone: "success" | "danger" | "muted"; label: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium",
        tone === "success" && "bg-status-success/15 text-status-success",
        tone === "danger" && "bg-status-error/15 text-status-error",
        tone === "muted" && "bg-overlay-subtle text-daintree-text/70"
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
        <Workflow className="mt-0.5 h-4 w-4 shrink-0 text-daintree-text/60" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-daintree-text">
              {record.recipeName}
            </span>
            {record.worktreeName ? (
              <span className="truncate text-xs text-daintree-text/50">{record.worktreeName}</span>
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
        <time className="shrink-0 text-xs text-daintree-text/50">
          {formatRelativeTime(record.timestamp)}
        </time>
      </div>
      {failed.length > 0 ? (
        <ul className="mt-2 space-y-0.5 pl-6.5 text-xs text-status-error/90">
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
        <Radio className="mt-0.5 h-4 w-4 shrink-0 text-daintree-text/60" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-daintree-text">
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
            <p className="mt-0.5 truncate text-xs text-daintree-text/50">{record.draftPreview}</p>
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
        <time className="shrink-0 text-xs text-daintree-text/50">
          {formatRelativeTime(record.timestamp)}
        </time>
      </div>
      {rejected.length > 0 ? (
        <ul className="mt-2 space-y-0.5 pl-6.5 text-xs text-status-error/90">
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
    <div className="flex flex-col gap-6">
      <SettingsSection
        icon={History}
        title="Run history"
        description="Records each recipe run and fleet broadcast so you can review what an automation actually did. Spawned terminals and targets are snapshots — entries stay readable even after a terminal closes. Terminal output and git state are not duplicated here."
      >
        <div className="flex flex-col gap-3">
          {records.length > 0 ? (
            <div className="flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowClearConfirm(true)}
                className="text-daintree-text/70"
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                Clear history
              </Button>
            </div>
          ) : null}

          {loading ? null : records.length === 0 ? (
            <EmptyState
              variant="zero-data"
              scale="canvas"
              icon={<History aria-hidden="true" />}
              title="No runs yet"
              description="Run a recipe or broadcast to a fleet and the outcome shows up here."
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {records.map((record) => (
                <li
                  key={record.id}
                  className="rounded-md border border-daintree-border/60 bg-overlay-subtle/40 p-3"
                >
                  {record.kind === "recipe" ? (
                    <RecipeRunRow record={record} />
                  ) : (
                    <FleetRunRow record={record} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
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
