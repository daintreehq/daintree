// The generator must ignore commented-out entries — otherwise a contributor
// who soft-disables a method via `//` would leave a phantom binding behind.
export const COMMENTED_METHOD_CHANNELS = {
  kept: "alpha:kept",
  // commentedOut: "alpha:commented-out",
} as const;
