// Mirrors the demo / globalEnv pattern: this namespace opts out because the
// renderer signature diverges from the IPC payload shape.
export const RENDERER_API_SKIP = true as const;

export const SKIPPED_METHOD_CHANNELS = {
  doSomething: "skipped:do-something",
} as const;
