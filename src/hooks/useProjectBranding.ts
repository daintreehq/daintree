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

function fetchBranding(projectId: string): void {
  if (brandingCache.has(projectId) || pendingFetches.has(projectId)) return;

  const promise = projectClient
    .getSettings(projectId)
    .then((data) => {
      brandingCache.set(projectId, data.projectIconSvg);
    })
    .catch(() => {
      brandingCache.set(projectId, undefined);
    })
    .finally(() => {
      pendingFetches.delete(projectId);
      notify();
    });

  pendingFetches.set(projectId, promise);
  notify();
}

export function invalidateBrandingCache(projectId?: string): void {
  if (projectId) {
    brandingCache.delete(projectId);
    pendingFetches.delete(projectId);
  } else {
    brandingCache.clear();
    pendingFetches.clear();
  }
  notify();
}

export function updateBrandingCache(projectId: string, svg: string | undefined): void {
  brandingCache.set(projectId, svg);
  notify();
}

export function useProjectBranding(projectId?: string): UseProjectBrandingReturn {
  const currentProject = useProjectStore((state) => state.currentProject);
  const targetId = projectId || currentProject?.id;

  // Subscribe to cache changes — re-renders on any cache mutation
  const currentVersion = useSyncExternalStore(subscribe, getSnapshot);

  // Trigger fetch when targetId changes or cache is invalidated (version changes)
  useEffect(() => {
    if (targetId) fetchBranding(targetId);
  }, [targetId, currentVersion]);

  if (!targetId) {
    return { projectIconSvg: undefined, isLoading: false };
  }

  return {
    projectIconSvg: brandingCache.get(targetId),
    isLoading: !brandingCache.has(targetId) && pendingFetches.has(targetId),
  };
}
