// Second file contributing to the `alpha` namespace but reusing the same
// `getEnabled` method name as alpha.preload.ts (under a different channel).
// The generator must reject this — otherwise TypeScript silently produces
// two `getEnabled(...)` overloads pointing at different channels.
export const ALPHA_EXTRA_METHOD_CHANNELS = {
  getEnabled: "alpha:get-enabled-extra",
} as const;
