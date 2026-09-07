import {
  PLUGIN_DOCUMENT_PACKAGE_BRIDGE,
  type PluginDocumentPackage,
  type PluginDocumentPackageBridge,
} from "../../../../shared/types/pluginDocumentPackage.js";

export type { PluginDocumentPackage };

/** Retained by the host document across plugin reloads, including failed loads. */
export function loadDocumentPackage<T = unknown>(
  moduleUrl: string,
  descriptor: PluginDocumentPackage
): Promise<T> {
  const bridge = (globalThis as unknown as Record<string, PluginDocumentPackageBridge>)[
    PLUGIN_DOCUMENT_PACKAGE_BRIDGE
  ];
  if (!bridge)
    return Promise.reject(new Error("This Daintree host doesn't support document packages"));
  return bridge.load(moduleUrl, descriptor) as Promise<T>;
}
