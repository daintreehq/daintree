// Fixture preload file used by ipc-renderer codegen tests. Mirrors the shape
// of the real preload files in `electron/ipc/handlers/`.
export const ALPHA_METHOD_CHANNELS = {
  getEnabled: "alpha:get-enabled",
  setEnabled: "alpha:set-enabled",
} as const;
