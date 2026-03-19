import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Workflow } from "lucide-react";
import { useWorkflowStore } from "@/store/workflowStore";
import { RunCard } from "./RunCard";

export function WorkflowSection() {
  const [collapsed, setCollapsed] = useState(false);
  const runs = useWorkflowStore((state) => state.runs);
  const isInitialized = useWorkflowStore((state) => state.isInitialized);
  const cancelRun = useWorkflowStore((state) => state.cancelRun);

  const { activeRuns, historyRuns } = useMemo(() => {
    const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
    return {
      activeRuns: all.filter((r) => r.status === "running"),
      historyRuns: all.filter((r) => r.status !== "running"),
    };
  }, [runs]);

  const totalRuns = activeRuns.length + historyRuns.length;

  if (!isInitialized || totalRuns === 0) return null;

  return (
    <div className="border-t border-divider">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex items-center gap-1.5 w-full px-4 py-2 text-left hover:bg-tint/[0.03] transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="w-3 h-3 text-text-muted shrink-0" />
        ) : (
          <ChevronDown className="w-3 h-3 text-text-muted shrink-0" />
        )}
        <Workflow className="w-3.5 h-3.5 text-text-muted shrink-0" />
        <span className="text-[10px] font-medium text-canopy-text/50 uppercase tracking-wide">
          Workflows
        </span>
        {activeRuns.length > 0 && (
          <span className="ml-auto text-[10px] tabular-nums text-status-info font-medium">
            {activeRuns.length} active
          </span>
        )}
      </button>

      {!collapsed && (
        <div>
          {activeRuns.map((run) => (
            <RunCard key={run.runId} run={run} onCancel={cancelRun} />
          ))}
          {historyRuns.map((run) => (
            <RunCard key={run.runId} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}
