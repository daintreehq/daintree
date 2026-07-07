import { getDaintreeEnv } from "@/utils/env";

// Master switch for the terminal paint-plane fabric
// (docs/architecture/terminal-paint-fabric.md). Off by default at every phase;
// when off, the exported terminalInstanceService is the bare single-surface
// service, byte-for-byte the pre-fabric path.
//
// Build-time flag, like the sibling DAINTREE_* renderer flags
// (DAINTREE_DISABLE_WEBGL, DAINTREE_DISABLE_FOCUSED_DRAIN_PRIORITY): Vite
// bakes it via envPrefix, and the process.env fallback serves tests. A
// launch-time value does NOT reach the sandboxed renderer — if a later phase
// needs runtime toggling, add a preload bridge in getRuntimeBridgeValue.
export function isPaintFabricEnabled(): boolean {
  return getDaintreeEnv("DAINTREE_PAINT_FABRIC") === "1";
}

// Narrower opt-in for hosting aux surfaces in sibling WebContentsViews
// (Phase 1V substrate). Nested inside the master switch so view hosting can
// be pinned off independently while the substrate lands front by front.
export function isPaintFabricViewHostingEnabled(): boolean {
  return isPaintFabricEnabled() && getDaintreeEnv("DAINTREE_PAINT_FABRIC_VIEWS") === "1";
}

export const PRIMARY_SURFACE_ID = "surface-primary";

// Ceiling on in-process surfaces. In-process surfaces exist to exercise and
// prove the multi-surface routing semantics (placement, rebinding, transfer,
// pass cancellation) — they share the window's renderer thread, glyph atlas,
// and 16-WebGL-context budget, so they add correctness coverage, not
// capacity. Capacity (own GPU budget, own parse thread) arrives when a
// surface is hosted by a sibling WebContentsView. Four is enough to surface
// every K>1 routing hazard without letting a stray env value spawn dozens of
// full TerminalInstanceService stacks.
export const MAX_PAINT_FABRIC_SURFACES = 4;

// Surface count for the fabric while it is flag-on. Defaults to 1 (the
// primary surface only — byte-identical routing to Phase 0). Values above 1
// are a dev/test capability for validating cross-surface invariants in a
// live window before the WebContentsView surface host lands.
export function getPaintFabricSurfaceCount(): number {
  const raw = getDaintreeEnv("DAINTREE_PAINT_FABRIC_SURFACES");
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(parsed, 1), MAX_PAINT_FABRIC_SURFACES);
}

export function paintFabricAuxSurfaceId(index: number): string {
  return `surface-aux-${index}`;
}
