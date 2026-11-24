import type { ForgeStatsDropdownProps } from "@/components/Layout/forgeStatsDropdownContract";
import { ForgeStatsDropdownLoading } from "@/components/Layout/ForgeStatsDropdownLoading";
import { lazyWithPreload, usePreloadedComponent } from "@/lib/lazyWithPreload";

const PreloadableGitHubStatsDropdown = lazyWithPreload(
  () => import("./GitHubStatsDropdown"),
  (m) => m.GitHubStatsDropdown
);

/** Registered as the slot's `preload`, so the host's hover can warm this chunk. */
export const preloadGitHubStatsDropdown = PreloadableGitHubStatsDropdown.preload;

/**
 * What the renderer entry registers for `github.statsDropdown`. That entry is
 * evaluated at boot, so the dropdown itself (its skeletons and filter store)
 * loads only when a stats pill is hovered, focused or opened. Until then the
 * panel holds its own box; a failed load is thrown to the slot's boundary,
 * whose Try again remounts this and issues the import again.
 */
export function LazyGitHubStatsDropdown(props: ForgeStatsDropdownProps) {
  const load = usePreloadedComponent(PreloadableGitHubStatsDropdown);
  if (load.status === "failed") {
    throw load.error instanceof Error ? load.error : new Error(String(load.error));
  }
  if (load.status === "loading") return <ForgeStatsDropdownLoading />;
  return <PreloadableGitHubStatsDropdown {...props} />;
}
