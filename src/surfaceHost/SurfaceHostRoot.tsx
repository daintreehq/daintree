// Minimal root for a paint-fabric surface view (Phase 1V substrate). A
// surface view exists to parse and paint terminals — it mounts no app shell,
// no stores beyond what terminals need, and never writes persisted state.
// The live terminal hosting (xterm instances driven over the surface's own
// pty-host MessagePort, WebGL thresholds applied from the compositor's
// budget push) lands with the wiring front; this root is the boot surface
// those pieces mount into.

export interface SurfaceHostRootProps {
  surfaceId: string;
}

export function SurfaceHostRoot({ surfaceId }: SurfaceHostRootProps) {
  return (
    <div
      data-testid="paint-surface-host"
      data-surface-id={surfaceId}
      className="h-screen w-screen bg-surface-canvas"
    />
  );
}
