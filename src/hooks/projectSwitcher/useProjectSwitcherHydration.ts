import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/store/projectStore";
import { useProjectStatsStore } from "@/store/projectStatsStore";
import { useScratchStore } from "@/store/scratchStore";
import { projectClient, projectPresenceClient } from "@/clients";
import type { ProjectStatusMap } from "@shared/types/ipc/project";
import type {
  ProjectPresenceSnapshot,
  ProjectPresenceState,
} from "@shared/types/ipc/projectPresence";

/**
 * Whether two presence answers mark the same rows. No answer and an empty one
 * mark nothing either way, which is the whole single-window case.
 */
function isSamePresence(
  a: ProjectPresenceSnapshot | null,
  b: ProjectPresenceSnapshot | null
): boolean {
  const key = (snapshot: ProjectPresenceSnapshot | null): string =>
    JSON.stringify([
      (snapshot?.thisWindow ?? []).map((e) => `${e.projectId}:${e.state}`).sort(),
      (snapshot?.otherWindows ?? []).map((e) => `${e.projectId}:${e.state}`).sort(),
    ]);
  return key(a) === key(b);
}

export interface ProjectSwitcherPresenceById {
  otherWindows: ReadonlyMap<string, ProjectPresenceState>;
  thisWindow: ReadonlyMap<string, ProjectPresenceState>;
}

export interface ProjectSwitcherHydration {
  projectStats: ProjectStatusMap;
  presenceByProjectId: ProjectSwitcherPresenceById;
}

/**
 * The switcher's live data: the agent-status map its rows read, and where each
 * project is open relative to this window.
 *
 * Everything here is gated on the palette being open. Opening pulls a fresh
 * project/scratch list, seeds stats for every row and subscribes to presence;
 * closed, nothing is pulled and the stats map is held.
 */
export function useProjectSwitcherHydration({
  isOpen,
  liveStatsWhileClosed,
}: {
  isOpen: boolean;
  liveStatsWhileClosed: boolean;
}): ProjectSwitcherHydration {
  // Held while closed. The app root owns this hook and hands its result to the
  // unmemoized shell, and main pushes a fresh map on every agent state change —
  // subscribing while closed re-rendered the whole window per push to update
  // rows nobody could see. Opening reads the store again in the same render,
  // and every closed-state path that acts on a project's counts (the open-time
  // freeze, sleep and remove confirms) reads the store directly instead.
  //
  // Held rather than emptied so a closing palette's exit animation keeps the
  // rows it was showing; the snapshot is retaken at the close.
  const isStatsLive = isOpen || liveStatsWhileClosed;
  const [heldStats, setHeldStats] = useState(() => useProjectStatsStore.getState().stats);
  const [wasStatsLive, setWasStatsLive] = useState(isStatsLive);
  if (wasStatsLive !== isStatsLive) {
    setWasStatsLive(isStatsLive);
    if (!isStatsLive) setHeldStats(useProjectStatsStore.getState().stats);
  }
  const projectStats = useProjectStatsStore((state) => (isStatsLive ? state.stats : heldStats));

  const loadProjects = useProjectStore((state) => state.loadProjects);
  const loadScratches = useScratchStore((state) => state.loadScratches);

  useEffect(() => {
    if (!isOpen) return;
    // Pull a fresh agent-status snapshot on open so rows show live status
    // immediately instead of waiting for the next passive broadcast, which
    // would otherwise leave a busy project rendering as a silent, idle row.
    //
    // Both stores are awaited because the pull covers scratch rows too (#11518)
    // — the push channel is best-effort, so this is the only guaranteed
    // hydration path for a view that has never received a broadcast.
    //
    // Settled, not `all`: the two loads are independent, and letting either
    // rejection short-circuit the pair would mean one store's IPC failure
    // silently costs the OTHER kind of row its status line. Whichever list did
    // load still gets hydrated from the ids it has.
    void Promise.allSettled([loadProjects(), loadScratches()])
      .then(() => {
        const ids = [
          ...useProjectStore.getState().projects.map((p) => p.id),
          ...useScratchStore.getState().scratches.map((s) => s.id),
        ];
        if (ids.length === 0) return;
        return projectClient.getBulkStats(ids).then((bulk) => {
          // Seed only — never overwrite.
          //
          // Bulk and the push service now compute agent state from the same
          // helper, so a seed is as accurate as a push. It is still only ever a
          // seed: the push service suppresses broadcasts whose payload is
          // unchanged, which is what would make a late bulk response landing on
          // top of a newer push stick until the underlying counts next moved.
          //
          // Bulk covers the one gap the push model leaves: a renderer that has
          // never received a broadcast has nothing to show. Fill absent entries
          // and leave every present one alone.
          const previous = useProjectStatsStore.getState().stats;
          const seeded: ProjectStatusMap = { ...previous };
          let changed = false;
          for (const [id, entry] of Object.entries(bulk)) {
            if (previous[id] !== undefined) continue;
            seeded[id] = {
              activeAgentCount: entry.activeAgentCount,
              waitingAgentCount: entry.waitingAgentCount,
              blockedAgentCount: entry.blockedAgentCount,
              ...(entry.oldestWaitingSince !== undefined
                ? { oldestWaitingSince: entry.oldestWaitingSince }
                : {}),
              completedAgentCount: entry.completedAgentCount,
              unacknowledgedCompletedAgentCount: entry.unacknowledgedCompletedAgentCount,
              ...(entry.oldestUnacknowledgedCompletionAt !== undefined
                ? { oldestUnacknowledgedCompletionAt: entry.oldestUnacknowledgedCompletionAt }
                : {}),
              ...(entry.latestUnacknowledgedCompletionAt !== undefined
                ? { latestUnacknowledgedCompletionAt: entry.latestUnacknowledgedCompletionAt }
                : {}),
              ...(entry.latestCompletionAt !== undefined
                ? { latestCompletionAt: entry.latestCompletionAt }
                : {}),
              ...(entry.latestWorkingSince !== undefined
                ? { latestWorkingSince: entry.latestWorkingSince }
                : {}),
              snoozedAgentCount: entry.snoozedAgentCount,
              ...(entry.nextSnoozeWakeAt !== undefined
                ? { nextSnoozeWakeAt: entry.nextSnoozeWakeAt }
                : {}),
              ...(entry.assistantState !== undefined
                ? { assistantState: entry.assistantState }
                : {}),
              ...(entry.assistantWaitingReason !== undefined
                ? { assistantWaitingReason: entry.assistantWaitingReason }
                : {}),
              ...(entry.assistantStateSince !== undefined
                ? { assistantStateSince: entry.assistantStateSince }
                : {}),
              processCount: entry.processCount,
            };
            changed = true;
          }
          if (changed) useProjectStatsStore.getState().setStats(seeded);
        });
      })
      .catch(() => {
        // Project load or stats refresh failed; rows just render without a
        // status line. This background freshness pull must never surface an
        // error.
      });
  }, [isOpen, loadProjects, loadScratches]);

  // Where each project is open, relative to this window (#12597). Pulled on
  // open and again whenever main reports a change while the palette is up —
  // subscribed before the first pull, so a change that lands mid-request still
  // gets its own read. Only the newest request may land: an older one can
  // resolve last and would put back what it saw. Cleared on close, so a reopen
  // never shows the previous session's owners before its own pull lands.
  //
  // An answer that changes nothing sets nothing, so it rebuilds no rows —
  // every rebuild re-runs the list's scroll-into-view. A failed read clears
  // rather than keeps: labels describing a world that has since moved are
  // worse than none, and main routes the pick either way.
  const [presence, setPresence] = useState<ProjectPresenceSnapshot | null>(null);
  useEffect(() => {
    if (!isOpen) return;
    let disposed = false;
    let latestRequest = 0;
    // What this session last applied. Starts empty because a closed palette
    // cleared the state on its way out.
    let applied: ProjectPresenceSnapshot | null = null;
    const apply = (next: ProjectPresenceSnapshot | null): void => {
      if (isSamePresence(applied, next)) return;
      applied = next;
      setPresence(next);
    };
    const pull = (): void => {
      const request = ++latestRequest;
      const isStale = (): boolean => disposed || request !== latestRequest;
      projectPresenceClient
        .getSnapshot()
        .then((snapshot) => {
          if (!isStale()) apply(snapshot);
        })
        .catch(() => {
          if (!isStale()) apply(null);
        });
    };
    const unsubscribe = projectPresenceClient.onChanged(pull);
    pull();
    return () => {
      disposed = true;
      unsubscribe();
      setPresence(null);
    };
  }, [isOpen]);

  const presenceByProjectId = useMemo(() => {
    const otherWindows = new Map<string, ProjectPresenceState>();
    for (const entry of presence?.otherWindows ?? []) {
      otherWindows.set(entry.projectId, entry.state);
    }
    const thisWindow = new Map<string, ProjectPresenceState>();
    for (const entry of presence?.thisWindow ?? []) {
      thisWindow.set(entry.projectId, entry.state);
    }
    return { otherWindows, thisWindow };
  }, [presence]);

  return { projectStats, presenceByProjectId };
}
