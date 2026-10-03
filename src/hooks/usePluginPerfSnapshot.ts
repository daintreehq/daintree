import { useEffect, useState } from "react";
import { pluginClient } from "@/clients/pluginClient";
import type { PluginPerfSnapshot } from "@shared/types/pluginMetrics";

// Both bridges are wrapped outside the hook: a try/catch holding conditionals
// inside it bails React Compiler for the whole function.
function subscribeSafely(callback: (snapshots: PluginPerfSnapshot[]) => void): () => void {
  try {
    return pluginClient.onPerfSnapshotsChanged(callback);
  } catch {
    return () => {};
  }
}

async function readSnapshots(): Promise<PluginPerfSnapshot[] | null> {
  try {
    return await pluginClient.getPerfSnapshots();
  } catch {
    return null;
  }
}

function pick(snapshots: readonly PluginPerfSnapshot[], pluginId: string) {
  return snapshots.find((entry) => entry.pluginId === pluginId) ?? null;
}

/**
 * Live cost observations for one plugin, keyed by its runtime instance id (the
 * id main records under — the instance key for a project plugin, the manifest
 * name otherwise). `null` until main has a snapshot for it.
 *
 * Main pushes only while someone is subscribed, so the subscription is scoped
 * to the lifetime of the caller: mounting starts the stream, unmounting stops
 * it. A missing or failing metrics bridge reads as "no snapshot" — these are
 * diagnostics and must never break the pane that shows them.
 */
export function usePluginPerfSnapshot(pluginId: string): PluginPerfSnapshot | null {
  const [snapshot, setSnapshot] = useState<PluginPerfSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    // Once a push has landed, the initial read is older than what we hold and
    // must not overwrite it.
    let pushed = false;
    setSnapshot(null);

    const unsubscribe = subscribeSafely((snapshots) => {
      if (!active) return;
      pushed = true;
      setSnapshot(pick(snapshots, pluginId));
    });

    void readSnapshots().then((snapshots) => {
      if (snapshots && active && !pushed) setSnapshot(pick(snapshots, pluginId));
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [pluginId]);

  return snapshot;
}
