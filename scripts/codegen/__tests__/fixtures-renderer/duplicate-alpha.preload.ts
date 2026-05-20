// Re-uses one of the channels declared in alpha.preload.ts. The generator
// must reject this so two files cannot accidentally register the same
// renderer channel.
export const DUPLICATE_ALPHA_METHOD_CHANNELS = {
  getEnabled: "alpha:get-enabled",
} as const;
