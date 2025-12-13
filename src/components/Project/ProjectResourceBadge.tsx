import { useEffect, useState, useCallback } from "react";
import { Circle } from "lucide-react";
import { projectClient } from "@/clients";
import type { ProjectStats } from "@shared/types";

interface AggregateStats {
  runningProjects: number;
  totalProcesses: number;
  totalMemoryMB: number;
}

export function ProjectResourceBadge() {
  const [stats, setStats] = useState<AggregateStats>({
    runningProjects: 0,
    totalProcesses: 0,
    totalMemoryMB: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    try {
      const projects = await projectClient.getAll();
      let running = 0;
      let processes = 0;
      let memory = 0;

      const statsPromises = projects.map((p) => projectClient.getStats(p.id));
      const results = await Promise.allSettled(statsPromises);

      results.forEach((result) => {
        if (result.status === "fulfilled") {
          const stat: ProjectStats = result.value;
          if (stat.processCount > 0) {
            running++;
            processes += stat.processCount;
            memory += stat.estimatedMemoryMB;
          }
        }
      });

      return {
        runningProjects: running,
        totalProcesses: processes,
        totalMemoryMB: memory,
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
    <div className="mx-2 mb-2 p-2 rounded-[var(--radius-md)] bg-green-500/10 border border-green-500/20">
      <div className="flex items-center gap-2">
        <Circle className="h-3 w-3 fill-green-500 text-green-500 animate-pulse shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground">
            {stats.runningProjects} project{stats.runningProjects !== 1 ? "s" : ""} running
          </div>
          <div className="text-xs text-muted-foreground">
            {stats.totalProcesses} process{stats.totalProcesses !== 1 ? "es" : ""} • ~
            {stats.totalMemoryMB} MB
          </div>
        </div>
      </div>
    </div>
  );
}
