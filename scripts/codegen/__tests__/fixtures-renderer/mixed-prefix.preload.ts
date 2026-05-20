// A single METHOD_CHANNELS constant must map to a single renderer namespace.
// Mixing channel prefixes is an error — split the file or rename the channel.
export const MIXED_METHOD_CHANNELS = {
  fromAlpha: "alpha:do-thing",
  fromBeta: "beta:do-thing",
} as const;
