import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FactSeparator } from "@/components/ui/FactSeparator";
import { EmptyState } from "@/components/ui/EmptyState";
import { SpinningIcon } from "@/components/ui/SpinningIcon";
import { Skeleton, SkeletonBone } from "@/components/ui/Skeleton";
import { TimeAgo } from "@/components/ui/TimeAgo";
import { TruncatedTooltip } from "@/components/ui/TruncatedTooltip";
import { MetricTile, type MetricTone } from "./MetricTile";
import { DiagnosticsNotice } from "./DiagnosticsNotice";
import { useProjectStore } from "@/store/projectStore";
import { useDohertyGate } from "@/hooks/useDeferredLoading";
import { useGlobalMinuteClock } from "@/hooks/useGlobalMinuteTicker";
import { pluralize } from "@/lib/pluralize";
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

function LiveMetricsBar() {
  const { fps, lafCount30s, cls30s, isBackgrounded } = usePerfMetricsStore(
    useShallow((s) => ({
      fps: s.fps,
      lafCount30s: s.lafCount30s,
      cls30s: s.cls30s,
      isBackgrounded: s.isBackgrounded,
    }))
  );

  const fpsTone: MetricTone =
    fps === null ? "default" : fps < 30 ? "alert" : fps < 50 ? "warn" : "default";
  const lafTone: MetricTone = lafCount30s === 0 ? "default" : lafCount30s < 5 ? "warn" : "alert";
  const clsTone: MetricTone = cls30s < 0.1 ? "default" : cls30s < 0.25 ? "warn" : "alert";

  return (
    <section aria-labelledby="perf-live" className="shrink-0 px-3 pb-2 pt-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 id="perf-live" className="text-2xs font-medium text-text-secondary">
          This window, last 30 seconds
        </h3>
        {isBackgrounded ? (
          <span className="text-2xs text-text-secondary">Paused while the window is hidden</span>
        ) : null}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <MetricTile
          label="Frame rate"
          value={formatNumber(fps)}
          unit="fps"
          hint="50+ is smooth"
          tone={fpsTone}
        />
        <MetricTile
          label="Long frames"
          value={String(lafCount30s)}
          hint="over 50ms each"
          tone={lafTone}
        />
        <MetricTile
          label="Layout shift"
          value={cls30s.toFixed(3)}
          hint="under 0.1 is stable"
          tone={clsTone}
        />
      </div>
    </section>
  );
}

const MODE_LABEL: Record<PerfMode, string> = {
  smoke: "Smoke",
  ci: "CI",
  nightly: "Nightly",
  soak: "Soak",
};

// The ring sits inside the cell: the truncating box clips an outside outline.
const CLIPPED_CELL_CLASS =
  "block truncate focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-primary";

// No error tint on an outside-reference row. The perf suite reports numbers and
// gates nothing, so a measurement past a reference value is information, not a
// fault — styling it as an error is a claim the harness no longer makes.
function ResultRow({ row }: { row: PerfSummaryRow }) {
  return (
    <tr className="border-b border-divider">
      <td className="px-3 py-1 text-xs text-text-primary">
        <TruncatedTooltip content={row.name}>
          <span className={CLIPPED_CELL_CLASS}>{row.name}</span>
        </TruncatedTooltip>
      </td>
      <td className="px-3 py-1 text-2xs text-text-secondary">{MODE_LABEL[row.mode] ?? row.mode}</td>
      <td className="px-3 py-1 text-right text-xs tabular-nums text-text-primary">
        {row.p95Ms.toFixed(1)}
      </td>
      <td className="px-3 py-1">
        {row.outsideReference ? (
          <span className="text-2xs font-medium text-text-primary">Outside reference</span>
        ) : (
          <span className="text-2xs text-text-secondary">Within reference</span>
        )}
      </td>
      <td className="px-3 py-1 text-2xs text-text-secondary">
        <TruncatedTooltip content={row.referenceNotes ?? ""}>
          <span className={CLIPPED_CELL_CLASS}>{row.referenceNotes ?? ""}</span>
        </TruncatedTooltip>
      </td>
    </tr>
  );
}

function ResultsTable({ rows }: { rows: PerfSummaryRow[] }) {
  return (
    <div className="h-full overflow-auto">
      <table className="w-full table-fixed border-collapse">
        <thead className="sticky top-0 bg-surface-sidebar">
          <tr className="border-b border-divider text-left text-2xs font-medium text-text-secondary">
            <th className="w-[36%] px-3 py-1 font-medium">Scenario</th>
            <th className="w-[10%] px-3 py-1 font-medium">Mode</th>
            <th className="w-[12%] px-3 py-1 text-right font-medium">p95 (ms)</th>
            <th className="w-[16%] px-3 py-1 font-medium">Reference</th>
            <th className="px-3 py-1 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <ResultRow key={`${row.mode}:${row.scenarioId}`} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultsEmptyState({ hasProject }: { hasProject: boolean }) {
  if (!hasProject) {
    return (
      <EmptyState
        variant="zero-data"
        scale="sidebar"
        className="py-4"
        title="Open a project to see its benchmark results"
      />
    );
  }
  return (
    <EmptyState
      variant="zero-data"
      scale="sidebar"
      className="py-4"
      title="Run a benchmark to see results here"
      action={
        <p className="text-xs text-text-secondary">
          <code className="font-mono text-text-primary">
            npm run perf smoke -- --scenario &lt;id&gt;
          </code>{" "}
          writes to .tmp/perf-results
        </p>
      }
    />
  );
}

function ResultsSkeleton() {
  return (
    <Skeleton label="Loading benchmark results" className="flex flex-col gap-2 p-3">
      <SkeletonBone className="h-3 w-1/2 rounded-[var(--radius-sm)]" />
      <SkeletonBone className="h-3 w-2/3 rounded-[var(--radius-sm)]" />
      <SkeletonBone className="h-3 w-1/3 rounded-[var(--radius-sm)]" />
    </Skeleton>
  );
}

export function PerfContent({ className }: PerfContentProps) {
  const projectPath = useProjectStore((s) => s.currentProject?.path ?? null);

  const { summaryRows, summaryLoadError, isLoadingSummaries, refreshSummaries } =
    usePerfMetricsStore(
      useShallow((s) => ({
        summaryRows: s.summaryRows,
        summaryLoadError: s.summaryLoadError,
        isLoadingSummaries: s.isLoadingSummaries,
        refreshSummaries: s.refreshSummaries,
      }))
    );

  // The user's own press spins at once as press feedback; the reads that mount
  // and project changes start wait out the Doherty gate. Each press is its own
  // object, keyed by project, so a read that outlives a switch can't make the
  // next project's load spin early and an older press can't clear a newer one.
  const [manualRequest, setManualRequest] = useState<{ path: string } | null>(null);
  const refreshGateOpen = useDohertyGate(isLoadingSummaries);
  const refreshSpinning =
    isLoadingSummaries &&
    ((projectPath !== null && manualRequest?.path === projectPath) || refreshGateOpen);
  const now = useGlobalMinuteClock();

  // `.finally` rather than try/finally: a try without a catch is a React Compiler
  // bailout for the whole component.
  const handleManualRefresh = useCallback(() => {
    // The live store, not the rendered flag: two presses can land before a
    // commit, and the store raises its flag synchronously.
    if (!projectPath || usePerfMetricsStore.getState().isLoadingSummaries) return;
    const request = { path: projectPath };
    setManualRequest(request);
    void refreshSummaries(projectPath).finally(() => {
      setManualRequest((current) => (current === request ? null : current));
    });
  }, [projectPath, refreshSummaries]);

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
      if (a.outsideReference !== b.outsideReference) return a.outsideReference ? -1 : 1;
      if (a.mode !== b.mode) return a.mode.localeCompare(b.mode);
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [summaryRows]);

  // When the results were produced, not when the files were last read — an
  // hour-old benchmark read a second ago is still an hour old.
  const generatedAt = useMemo(() => {
    let newest: number | null = null;
    for (const row of summaryRows) {
      const t = Date.parse(row.generatedAt);
      if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    }
    return newest;
  }, [summaryRows]);

  const outsideCount = sortedRows.filter((r) => r.outsideReference).length;
  const showEmpty = !isLoadingSummaries && sortedRows.length === 0 && !summaryLoadError;
  const showRows = !summaryLoadError && sortedRows.length > 0;

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <LiveMetricsBar />
      <section
        aria-labelledby="perf-results"
        className="flex min-h-0 flex-1 flex-col border-t border-divider"
      >
        <div className="flex items-center justify-between px-3 py-1.5">
          <h3 id="perf-results" className="text-2xs font-medium text-text-secondary">
            Benchmark results
            {showRows ? (
              <span className="font-normal">
                {" "}
                <FactSeparator /> {pluralize(sortedRows.length, "scenario")}
                {outsideCount > 0 ? `, ${outsideCount} outside reference` : ""}
              </span>
            ) : null}
          </h3>
          <div className="flex items-center gap-2">
            {showRows && generatedAt !== null ? (
              <span className="text-2xs tabular-nums text-text-secondary">
                <TimeAgo timestamp={generatedAt} now={now} prefix="Generated " />
              </span>
            ) : null}
            {projectPath && !summaryLoadError ? (
              <Button
                variant="subtle"
                size="xs"
                onClick={handleManualRefresh}
                // Not `disabled`: that would dim the button and drop keyboard focus
                // to the page.
                aria-disabled={isLoadingSummaries || undefined}
                aria-busy={isLoadingSummaries || undefined}
                aria-label="Re-read benchmark results"
              >
                <SpinningIcon icon={RefreshCw} active={refreshSpinning} />
                Refresh
              </Button>
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          {summaryLoadError ? (
            <div className="px-3">
              <DiagnosticsNotice
                kind="failed"
                title="Couldn't read benchmark results"
                description={<span className="break-all font-mono">{summaryLoadError}</span>}
                onRetry={projectPath ? () => void refreshSummaries(projectPath) : undefined}
                retrying={isLoadingSummaries}
              />
            </div>
          ) : showEmpty ? (
            <ResultsEmptyState hasProject={projectPath !== null} />
          ) : isLoadingSummaries && sortedRows.length === 0 ? (
            <ResultsSkeleton />
          ) : (
            <ResultsTable rows={sortedRows} />
          )}
        </div>
      </section>
    </div>
  );
}
