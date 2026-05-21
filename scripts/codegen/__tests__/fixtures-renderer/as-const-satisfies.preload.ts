// Mirrors the actual production syntax used by every real preload file:
// `as const satisfies Record<string, keyof IpcInvokeMap>`. Catches future
// regex tightening that would break the `satisfies` tail.
type IpcInvokeMapStub = {
  "alpha:hello": { args: []; result: void };
};

export const SATISFIES_METHOD_CHANNELS = {
  hello: "alpha:hello",
} as const satisfies Record<string, keyof IpcInvokeMapStub>;
