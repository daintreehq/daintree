import { useEffect, useState, useSyncExternalStore } from "react";
import type { GlobalAssistantView } from "@shared/types/ipc/help";
import { getViewHostId } from "@/hooks/useHostConnection";
import { isProjectViewCached, subscribeProjectViewLifecycle } from "@/lib/viewCacheState";
import type { AgentState } from "@/types";

function subscribeViewCache(onChange: () => void): () => void {
  return subscribeProjectViewLifecycle(() => onChange());
}

/**
 * What the global assistant's terminal was last seen doing, for the scope
 * switch to mark while this view shows a project lane (#14986). Read and
 * listened to, never attached to: nothing here starts a run, takes its input,
 * or joins the attachments that decide who holds it. Null while nothing is
 * known, nothing runs, or `active` is false — and in a cached view or one bound
 * to another host, where the global pane shows nothing of This Mac's run either.
 */
export function useGlobalAssistantActivity(active: boolean): AgentState | null {
  const viewCached = useSyncExternalStore(subscribeViewCache, isProjectViewCached);
  const observing = active && !viewCached && getViewHostId() === null;
  const [view, setView] = useState<GlobalAssistantView | null>(null);

  useEffect(() => {
    if (!observing) return;
    const help = window.electron.help;
    let disposed = false;
    // Subscribed before reading: the answer is newer than any change sent
    // before it, and every change after it arrives here.
    const off = help.onGlobalAssistantChanged((state) => {
      if (!disposed) setView(state);
    });
    help.getGlobalAssistantState().then(
      (state) => {
        if (!disposed) setView(state);
      },
      () => {}
    );
    return () => {
      disposed = true;
      off();
      // What was seen before going quiet is not shown again before it is reread.
      setView(null);
    };
  }, [observing]);

  return observing && view?.phase === "running" && view.subject ? view.agentState : null;
}
