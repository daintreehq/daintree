import type { ComponentProps } from "react";
import type { ArtifactOverlay } from "./ArtifactOverlay";
import { useHasArtifacts } from "@/hooks/useArtifacts";
import { useKeepMounted } from "@/hooks/useKeepMounted";
import { lazyWhenLoaded } from "@/lib/lazyWithPreload";

const LazyArtifactOverlay = lazyWhenLoaded(
  () => import("./ArtifactOverlay"),
  (m) => m.ArtifactOverlay
);

/**
 * A terminal's artifact overlay, loaded with its first artifact. Most panes
 * never collect one, so they never load the overlay or build its actions.
 *
 * Kept mounted once loaded, as the overlay always was: clearing the artifacts
 * is what settles a pending patch confirmation as cancelled and hands focus
 * back, and that runs inside it. Key it by terminal so the latch doesn't
 * outlive the terminal it was for.
 */
export function ArtifactOverlayGate(props: ComponentProps<typeof ArtifactOverlay>) {
  const hasArtifacts = useHasArtifacts(props.terminalId);
  const active = useKeepMounted(hasArtifacts);
  return active ? <LazyArtifactOverlay {...props} /> : null;
}
