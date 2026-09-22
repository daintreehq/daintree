import type { IpcInvokeMap } from "../../types/index.js";

export const FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS = {
  previewCredentialImport: "forge:preview-credential-import",
  commitCredentialImport: "forge:commit-credential-import",
} as const satisfies Record<string, keyof IpcInvokeMap>;

type Methods = typeof FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS;

export type ForgeCredentialImportPreloadBindings = {
  [M in keyof Methods]: (
    ...args: IpcInvokeMap[Methods[M]]["args"]
  ) => Promise<IpcInvokeMap[Methods[M]]["result"]>;
};

type Invoker = (channel: string, ...args: unknown[]) => Promise<unknown>;

export function buildForgeCredentialImportPreloadBindings(
  invoke: Invoker
): ForgeCredentialImportPreloadBindings {
  const out: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of Object.keys(FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS) as Array<
    keyof Methods
  >) {
    const channel = FORGE_CREDENTIAL_IMPORT_METHOD_CHANNELS[method];
    out[method as string] = (...args) => invoke(channel, ...args);
  }
  return out as unknown as ForgeCredentialImportPreloadBindings;
}
