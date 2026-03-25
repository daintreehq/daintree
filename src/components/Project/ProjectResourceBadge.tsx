import { useEffect, useState, useCallback } from "react";
import { projectClient, systemClient } from "@/clients";

interface AggregateStats {
  runningProjects: number;
  totalMemoryMB: number;
}

export function ProjectResourceBadge() {
  const [stats, setStats] = useState<AggregateStats>({
    runningProjects: 0,
    totalMemoryMB: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const [projects, appMetrics] = await Promise.all([
        projectClient.getAll(),
        systemClient.getAppMetrics(),
      ]);

      let running = 0;
      const statsPromises = projects.map((p) => projectClient.getStats(p.id));
      const results = await Promise.allSettled(statsPromises);

      results.forEach((result) => {
        if (result.status === "fulfilled" && result.value.processCount > 0) {
          running++;
        }
      });

      return {
        runningProjects: running,
        totalMemoryMB: appMetrics.totalMemoryMB,
      };
    } catch (error) {
      console.error("[ProjectResourceBadge] Failed to fetch stats:", error);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const runFetch = async () => {
      const result = await fetchStats();
      if (!cancelled && result) {
        setStats(result);
        setIsLoading(false);
      }
    };

    void runFetch();
    const interval = setInterval(() => void runFetch(), 10000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchStats]);

  if (isLoading || stats.runningProjects === 0) {
    return null;
  }

  return (
    <div className="px-4 py-2 border-t border-divider surface-chrome flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className="inline-flex h-2 w-2 rounded-full bg-status-success/60 shrink-0" />
        <span className="text-[10px] tabular-nums text-canopy-text/40 font-medium truncate">
          {stats.runningProjects} project{stats.runningProjects !== 1 ? "s" : ""} active
        </span>
      </div>
      <div className="text-[10px] text-canopy-text/30 font-mono tabular-nums tracking-tight shrink-0">
        {stats.totalMemoryMB}MB
      </div>
    </div>
  );
}
