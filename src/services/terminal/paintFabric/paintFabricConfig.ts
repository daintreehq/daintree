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

export const PRIMARY_SURFACE_ID = "surface-primary";
