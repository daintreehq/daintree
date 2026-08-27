import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/EmptyState";
import { useProjectStore } from "@/store/projectStore";
import {
  startLivePerfCapture,
  stopLivePerfCapture,
  usePerfMetricsStore,
  type PerfMode,
  type PerfSummaryRow,
} from "@/store/perfMetricsStore";

export interface PerfContentProps {
  className?: string;
}

function formatNumber(value: number | null, fractionDigits = 0): string {
  if (value === null) return "—";
  return value.toFixed(fractionDigits);
}

function formatRelative(timestamp: number | null): string {
  if (timestamp === null) return "";
  const diff = Date.now() - timestamp;
  if (diff < 5_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return new Date(timestamp).toLocaleTimeString();
}

interface MetricTileProps {
  label: string;
  value: string;
  unit?: string;
  tone?: "default" | "warn" | "alert";
}

function MetricTile({ label, value, unit, tone = "default" }: MetricTileProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 px-3 py-2 rounded border border-daintree-border/40 bg-daintree-sidebar/30",
        tone === "warn" && "border-status-warning/40 bg-status-warning/5",
        tone === "alert" && "border-status-error/40 bg-status-error/5"
      )}
    >
      <span className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium">
        {label}
      </span>
      <div className="flex items-baseline gap-1">
        <span
          className={cn(
            "text-lg font-mono tabular-nums text-daintree-text",
            tone === "warn" && "text-status-warning",
            tone === "alert" && "text-status-error"
          )}
        >
          {value}
        </span>
        {unit ? <span className="text-xs text-daintree-text/55 font-mono">{unit}</span> : null}
      </div>
    </div>
  );
}

function LiveMetricsBar() {
  const { fps, lafCount30s, cls30s, isBackgrounded } = usePerfMetricsStore(
    useShallow((s) => ({
      fps: s.fps,
      lafCount30s: s.lafCount30s,
      cls30s: s.cls30s,
      isBackgrounded: s.isBackgrounded,
    }))
  );

  const fpsTone: MetricTileProps["tone"] =
    fps === null ? "default" : fps < 30 ? "alert" : fps < 50 ? "warn" : "default";
  const lafTone: MetricTileProps["tone"] =
    lafCount30s === 0 ? "default" : lafCount30s < 5 ? "warn" : "alert";
  const clsTone: MetricTileProps["tone"] =
    cls30s < 0.1 ? "default" : cls30s < 0.25 ? "warn" : "alert";

  return (
    <div className="px-3 py-2 border-b border-daintree-border/40 bg-daintree-sidebar/20">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium">
          Live renderer
        </span>
        {isBackgrounded ? (
          <span className="text-[10px] text-daintree-text/45">Backgrounded</span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MetricTile label="FPS" value={formatNumber(fps)} unit="hz" tone={fpsTone} />
        <MetricTile label="Long frames (30s)" value={String(lafCount30s)} tone={lafTone} />
        <MetricTile label="Layout shift (30s)" value={cls30s.toFixed(3)} tone={clsTone} />
      </div>
    </div>
  );
}

const MODE_LABEL: Record<PerfMode, string> = {
  smoke: "Smoke",
  ci: "CI",
  nightly: "Nightly",
  soak: "Soak",
};

function BudgetRow({ row }: { row: PerfSummaryRow }) {
  return (
    <tr
      className={cn(
        "border-b border-daintree-border/30",
        row.failedBudget && "bg-status-error/[0.04]"
      )}
    >
      <td className="px-3 py-1.5 text-xs font-mono text-daintree-text truncate">{row.name}</td>
      <td className="px-3 py-1.5 text-[10px] text-daintree-text/55 font-mono uppercase tracking-wide">
        {MODE_LABEL[row.mode] ?? row.mode}
      </td>
      <td className="px-3 py-1.5 text-xs font-mono tabular-nums text-daintree-text text-right">
        {row.p95Ms.toFixed(1)}
      </td>
      <td className="px-3 py-1.5 text-xs">
        {row.failedBudget ? (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide border border-status-error/30 bg-status-error/15 text-status-error">
            Over budget
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide border border-daintree-border bg-overlay-subtle text-daintree-text/60">
            Within budget
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 text-[11px] text-daintree-text/55 truncate">
        {row.budgetReason ?? ""}
      </td>
    </tr>
  );
}

function BudgetTable({ rows }: { rows: PerfSummaryRow[] }) {
  return (
    <div className="overflow-auto h-full">
      <table className="w-full border-collapse">
        <thead className="sticky top-0 bg-daintree-sidebar/80 backdrop-blur-sm">
          <tr className="border-b border-daintree-border/60">
            <th className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium text-left">
              Scenario
            </th>
            <th className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium text-left">
              Mode
            </th>
            <th className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium text-right">
              p95 (ms)
            </th>
            <th className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium text-left">
              Budget
            </th>
            <th className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium text-left">
              Reason
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <BudgetRow key={`${row.mode}:${row.scenarioId}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerfEmptyState({ hasProject }: { hasProject: boolean }) {
  if (!hasProject) {
    return (
      <EmptyState
        variant="zero-data"
        scale="canvas"
        title="Open a project to view perf results"
        icon={<Activity />}
      />
    );
  }
  return (
    <EmptyState
      variant="zero-data"
      scale="canvas"
      title="No perf results found"
      icon={<Activity />}
      description="Run npm run perf to generate a budget report. Results are read from .tmp/perf-results."
    />
  );
}

export function PerfContent({ className }: PerfContentProps) {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  const { summaryRows, summaryLoadError, isLoadingSummaries, lastLoadedAt, refreshSummaries } =
    usePerfMetricsStore(
      useShallow((s) => ({
        summaryRows: s.summaryRows,
        summaryLoadError: s.summaryLoadError,
        isLoadingSummaries: s.isLoadingSummaries,
        lastLoadedAt: s.lastLoadedAt,
        refreshSummaries: s.refreshSummaries,
      }))
    );

  useEffect(() => {
    startLivePerfCapture();
    return () => stopLivePerfCapture();
  }, []);

  useEffect(() => {
    if (!projectPath) {
      usePerfMetricsStore.getState().clearSummaries();
      return;
    }
    void refreshSummaries(projectPath);
  }, [projectPath, refreshSummaries]);

  const sortedRows = useMemo(() => {
    const copy = summaryRows.slice();
    copy.sort((a, b) => {
      if (a.failedBudget !== b.failedBudget) return a.failedBudget ? -1 : 1;
      if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [summaryRows]);

  const showEmpty = !isLoadingSummaries && sortedRows.length === 0 && !summaryLoadError;

  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <LiveMetricsBar />
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-daintree-border/30 bg-daintree-sidebar/10">
        <span className="text-[10px] uppercase tracking-wide text-daintree-text/55 font-medium">
          CI budgets
        </span>
        {lastLoadedAt !== null && !isLoadingSummaries ? (
          <span className="text-[10px] text-daintree-text/45 font-mono">
            Updated {formatRelative(lastLoadedAt)}
          </span>
        ) : null}
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        {summaryLoadError ? (
          <div className="p-3 text-xs text-status-error font-mono">
            Couldn't read perf results: {summaryLoadError}
          </div>
        ) : showEmpty ? (
          <div className="flex items-center justify-center h-full">
            <PerfEmptyState hasProject={projectPath !== null} />
          </div>
        ) : isLoadingSummaries && sortedRows.length === 0 ? (
          <div className="animate-pulse-delayed p-3 space-y-2">
            <div className="h-4 bg-overlay-soft rounded w-1/2" />
            <div className="h-4 bg-overlay-soft rounded w-2/3" />
            <div className="h-4 bg-overlay-soft rounded w-1/3" />
          </div>
        ) : (
          <BudgetTable rows={sortedRows} />
        )}
      </div>
    </div>
  );
}
