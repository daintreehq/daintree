/**
 * useProjectSwitchRehydration — No longer needed.
 *
 * With per-project WebContentsViews, each view hydrates once on creation
 * via useAppHydration. There is no in-place "re-hydration" on project switch.
 * Kept as a no-op to avoid breaking App.tsx imports.
 */
export function useProjectSwitchRehydration() {
  // No-op: each project view hydrates independently on creation.
}
