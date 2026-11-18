import { useEffect, useSyncExternalStore } from "react";
import { useProjectStore } from "../store/projectStore";
import { projectClient } from "@/clients";

interface UseProjectBrandingReturn {
  projectIconSvg: string | undefined;
  isLoading: boolean;
}

// Module-level cache: Map.has() distinguishes "not fetched" from "fetched, no icon"
const brandingCache = new Map<string, string | undefined>();
const pendingFetches = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;

// A failed read stays out of brandingCache, where it would read as "no icon"
// and block every later read. Retries are bounded so a settings file that
// keeps failing isn't re-read on every cache notification.
const RETRY_DELAYS_MS = [250, 1000, 3000] as const;

interface FailedRead {
  attempts: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const failedReads = new Map<string, FailedRead>();

function notify(): void {
  version++;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return version;
}

function isOutOfRetries(failed: FailedRead): boolean {
  return failed.timer === null && failed.attempts > RETRY_DELAYS_MS.length;
}

function clearFailedRead(projectId: string): void {
  const failed = failedReads.get(projectId);
  if (failed?.timer != null) clearTimeout(failed.timer);
  failedReads.delete(projectId);
}

function recordFailedRead(projectId: string): void {
  const attempts = (failedReads.get(projectId)?.attempts ?? 0) + 1;
  clearFailedRead(projectId);
  const failed: FailedRead = { attempts, timer: null };
  const delay = RETRY_DELAYS_MS[attempts - 1];
  if (delay !== undefined) {
    // The timer only wakes mounted consumers; with none mounted it reads nothing.
    failed.timer = setTimeout(() => {
      failed.timer = null;
      notify();
    }, delay);
  }
  failedReads.set(projectId, failed);
}

function fetchBranding(projectId: string): void {
  if (brandingCache.has(projectId) || pendingFetches.has(projectId)) return;
  const failed = failedReads.get(projectId);
  if (failed && (failed.timer !== null || isOutOfRetries(failed))) return;

  const promise = projectClient.getSettings(projectId).then(
    (data) => {
      if (pendingFetches.get(projectId) !== promise) return;
      pendingFetches.delete(projectId);
      clearFailedRead(projectId);
      brandingCache.set(projectId, data.projectIconSvg);
      notify();
    },
    () => {
      if (pendingFetches.get(projectId) !== promise) return;
      pendingFetches.delete(projectId);
      recordFailedRead(projectId);
      notify();
    }
  );

  pendingFetches.set(projectId, promise);
  notify();
}

// Revisiting the grid (a remount, or a warm project switch revealing this view)
// gives a project whose retries ran out a fresh budget, so the saved icon comes
// back after recovery without a settings edit.
function rearmBranding(projectId: string): void {
  const failed = failedReads.get(projectId);
  if (!failed || !isOutOfRetries(failed)) return;
  failedReads.delete(projectId);
  fetchBranding(projectId);
}

export function invalidateBrandingCache(projectId?: string): void {
  if (projectId) {
    brandingCache.delete(projectId);
    pendingFetches.delete(projectId);
    clearFailedRead(projectId);
  } else {
    brandingCache.clear();
    pendingFetches.clear();
    for (const id of [...failedReads.keys()]) clearFailedRead(id);
  }
  notify();
}

export function updateBrandingCache(projectId: string, svg: string | undefined): void {
  brandingCache.set(projectId, svg);
  pendingFetches.delete(projectId);
  clearFailedRead(projectId);
  notify();
}

export function useProjectBranding(projectId?: string): UseProjectBrandingReturn {
  const currentProject = useProjectStore((state) => state.currentProject);
  const targetId = projectId || currentProject?.id;

  // Re-runs the fetch effect on any cache mutation
  const currentVersion = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!targetId) return;
    rearmBranding(targetId);
    return window.electron?.app?.onViewRevealed?.(() => rearmBranding(targetId));
  }, [targetId]);

  // Trigger fetch when targetId changes or cache is invalidated (version changes)
  useEffect(() => {
    if (targetId) fetchBranding(targetId);
  }, [targetId, currentVersion]);

  // Read through snapshots, not straight from the maps: React Compiler memoizes
  // a bare map read by targetId alone, so a mounted consumer would never see an
  // icon that lands after its first render.
  const projectIconSvg = useSyncExternalStore(subscribe, () =>
    targetId ? brandingCache.get(targetId) : undefined
  );
  const isLoading = useSyncExternalStore(
    subscribe,
    () => !!targetId && !brandingCache.has(targetId) && pendingFetches.has(targetId)
  );

  return { projectIconSvg, isLoading };
}
