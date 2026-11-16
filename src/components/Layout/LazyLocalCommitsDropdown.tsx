import type { ComponentProps } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { lazyWithPreload, usePreloadedComponent } from "@/lib/lazyWithPreload";
import type { LocalCommitsDropdown } from "./LocalCommitsDropdown";
import { ForgeStatsDropdownLoading } from "./ForgeStatsDropdownLoading";

type LocalCommitsDropdownProps = ComponentProps<typeof LocalCommitsDropdown>;

const PreloadableLocalCommitsDropdown = lazyWithPreload(
  () => import("./LocalCommitsDropdown"),
  (m) => m.LocalCommitsDropdown
);

/** Starts loading the commit list's chunk ahead of the open that needs it. */
export function preloadLocalCommitsDropdown(): void {
  PreloadableLocalCommitsDropdown.preload().catch(() => {});
}

function LocalCommitsDropdownLoader(props: LocalCommitsDropdownProps) {
  const load = usePreloadedComponent(PreloadableLocalCommitsDropdown);
  // Thrown for the boundary below, whose Try again remounts this loader and
  // issues the import again.
  if (load.status === "failed") {
    throw load.error instanceof Error ? load.error : new Error(String(load.error));
  }
  if (load.status === "loading") return <ForgeStatsDropdownLoading />;
  return <PreloadableLocalCommitsDropdown {...props} />;
}

/**
 * The commits pill's dropdown when no forge provider contributes one. Its chunk
 * stays off the toolbar's first render and loads on a hover or focus of the
 * pill, or on the open itself; until it lands the panel holds its own box.
 */
export function LazyLocalCommitsDropdown(props: LocalCommitsDropdownProps) {
  return (
    <ErrorBoundary variant="component" componentName="LocalCommitsDropdown" displayName="Commits">
      <LocalCommitsDropdownLoader {...props} />
    </ErrorBoundary>
  );
}
