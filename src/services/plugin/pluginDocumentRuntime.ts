import {
  PLUGIN_DOCUMENT_PACKAGE_BRIDGE,
  type PluginDocumentPackage,
} from "@shared/types/pluginDocumentPackage";

export interface PluginSource {
  pluginId: string;
  generation: string | null;
  url: string;
}

export interface PluginDocumentDiagnostic {
  pluginId: string | null;
  message: string;
  owner?: PluginSource;
  attempted?: PluginSource;
}

const importModule = (url: string): Promise<unknown> => import(/* @vite-ignore */ url);

/** Document-local state: main-process status snapshots must never overwrite it. */
export function createPluginDocumentRuntime(
  importer: (url: string) => Promise<unknown> = importModule
) {
  const authorities = new Map<string, string>();
  const registrations = new Map<string, PluginSource | undefined>();
  const packages = new Map<
    string,
    {
      descriptor: PluginDocumentPackage;
      promise: Promise<unknown>;
      owner: PluginSource;
      entryUrl: string;
      consumers: Set<string>;
    }
  >();
  const listeners = new Set<() => void>();
  let diagnostics: readonly PluginDocumentDiagnostic[] = [];
  let reloadConfirmation: { resolve: (approved: boolean) => void } | null = null;
  const attributedErrors = new WeakMap<object, PluginSource>();

  function sourceForUrl(value: string): PluginSource | undefined {
    try {
      const url = new URL(value);
      const pluginId = url.protocol === "plugin:" ? authorities.get(url.host) : undefined;
      if (!pluginId) return undefined;
      return {
        pluginId,
        generation: /^\/(__dtv-\d+)\//.exec(url.pathname)?.[1] ?? null,
        url: url.href,
      };
    } catch {
      return undefined;
    }
  }

  function sourceForStack(stack?: string): PluginSource | undefined {
    // Only frame lines count: an error *message* quoting another plugin's URL
    // must not re-attribute the error to that plugin.
    for (const line of stack?.split("\n") ?? []) {
      if (!/^\s*at\s/.test(line)) continue;
      const match = /plugin:\/\/[^\s)]+/.exec(line);
      if (match) return sourceForUrl(match[0].replace(/:\d+(?::\d+)?$/, ""));
    }
    return undefined;
  }

  function emitChange() {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Diagnostics must preserve the native registration outcome. */
      }
    }
  }

  function report(diagnostic: PluginDocumentDiagnostic) {
    if (
      diagnostics.some(
        (item) => item.pluginId === diagnostic.pluginId && item.message === diagnostic.message
      )
    )
      return;
    // Bound repeated broken reloads without evicting existing recovery information.
    if (diagnostics.length >= 256) return;
    diagnostics = [...diagnostics, diagnostic];
    emitChange();
  }

  async function load(moduleUrl: string, descriptor: PluginDocumentPackage): Promise<unknown> {
    const source = sourceForUrl(moduleUrl);
    const entry = new URL(descriptor.entryUrl, moduleUrl);
    if (
      !source ||
      entry.protocol !== "plugin:" ||
      entry.host !== new URL(moduleUrl).host ||
      entry.username ||
      entry.password ||
      entry.search ||
      entry.hash
    ) {
      throw new Error(
        "Document packages must load from the requesting plugin's registered local authority"
      );
    }
    if (
      !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(descriptor.name) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(descriptor.version) ||
      !/^[a-f0-9]{64}$/.test(descriptor.buildId) ||
      (descriptor.scope !== undefined &&
        descriptor.scope !== "plugin" &&
        descriptor.scope !== "document")
    ) {
      throw new Error(
        "Document packages require an npm name, exact version, SHA-256 build id, and valid scope"
      );
    }
    const key = JSON.stringify([
      descriptor.scope === "document" ? null : source.pluginId,
      descriptor.name,
    ]);
    const previous = packages.get(key);
    if (previous) {
      if (
        previous.descriptor.version !== descriptor.version ||
        previous.descriptor.buildId !== descriptor.buildId
      ) {
        const message = `${descriptor.name} is already loaded with a different version or build. Reload this project window to replace it.`;
        report({ pluginId: source.pluginId, message, owner: previous.owner, attempted: source });
        const refused = new Error(message);
        attributedErrors.set(refused, source);
        throw refused;
      }
      previous.consumers.add(source.pluginId);
      for (const diagnostic of diagnostics) {
        if (diagnostic.attempted?.url === previous.entryUrl) {
          report({ ...diagnostic, pluginId: source.pluginId });
        }
      }
      return previous.promise.catch((error: unknown) => {
        if (typeof error === "object" && error !== null) attributedErrors.set(error, source);
        report({
          pluginId: source.pluginId,
          message: `${descriptor.name} failed to load. Reload this project window before trying again.`,
          owner: previous.owner,
          attempted: source,
        });
        throw error;
      });
    }
    if (packages.size >= 128) {
      const message = "Document package limit reached. Reload this project window to replace it.";
      report({ pluginId: source.pluginId, message, attempted: source });
      const refused = new Error(message);
      attributedErrors.set(refused, source);
      throw refused;
    }
    // Publish before invoking any code, including synchronous importer callbacks.
    const promise = Promise.resolve()
      .then(() => importer(entry.href))
      .catch((error: unknown) => {
        if (typeof error === "object" && error !== null) attributedErrors.set(error, source);
        report({
          pluginId: source.pluginId,
          message: `${descriptor.name} failed to load. Reload this project window before trying again.`,
          attempted: source,
        });
        throw error;
      });
    packages.set(key, {
      descriptor: { ...descriptor },
      promise,
      owner: source,
      entryUrl: entry.href,
      consumers: new Set([source.pluginId]),
    });
    return promise;
  }

  function observe(registry: CustomElementRegistry): () => void {
    const nativeDefine = registry.define;
    const wrapper: CustomElementRegistry["define"] = function (
      this: CustomElementRegistry,
      ...args
    ) {
      const [name] = args;
      const attempted = sourceForStack(new Error().stack);
      const existing =
        typeof name === "string" && this === registry ? registry.get(name) : undefined;
      try {
        Reflect.apply(nativeDefine, this, args);
      } catch (error) {
        if (existing && error instanceof DOMException && error.name === "NotSupportedError") {
          const owner = registrations.get(name);
          if (attempted || owner) {
            const diagnostic: PluginDocumentDiagnostic = {
              pluginId: attempted?.pluginId ?? owner?.pluginId ?? null,
              message: `Custom element "${name}" is already registered. Reload this project window to replace it.`,
              owner,
              attempted,
            };
            report(diagnostic);
            for (const retained of packages.values()) {
              if (retained.entryUrl === attempted?.url) {
                for (const pluginId of retained.consumers) report({ ...diagnostic, pluginId });
              }
            }
            if (attempted && typeof error === "object" && error !== null)
              attributedErrors.set(error, attempted);
          }
        }
        throw error;
      }
      if (this === registry) registrations.set(name, attempted);
    };
    registry.define = wrapper;
    return () => {
      if (registry.define === wrapper) registry.define = nativeDefine;
    };
  }

  return {
    requestReloadConfirmation(): Promise<boolean> {
      reloadConfirmation?.resolve(false);
      return new Promise((resolve) => {
        reloadConfirmation = { resolve };
        emitChange();
      });
    },
    resolveReloadConfirmation(approved: boolean) {
      const pending = reloadConfirmation;
      reloadConfirmation = null;
      emitChange();
      pending?.resolve(approved);
    },
    getReloadConfirmation: () => reloadConfirmation,
    load,
    observe,
    sourceForUrl,
    sourceForStack,
    errorSource(error: unknown) {
      return typeof error === "object" && error !== null ? attributedErrors.get(error) : undefined;
    },
    registerView(pluginId: string, moduleUrl: string) {
      if (!URL.canParse(moduleUrl)) return;
      const url = new URL(moduleUrl);
      if (url.protocol === "plugin:") authorities.set(url.host, pluginId);
    },
    getSnapshot: () => diagnostics,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const pluginDocumentRuntime = createPluginDocumentRuntime();
let installed = false;
export function installPluginDocumentRuntime(): void {
  if (installed) return;
  installed = true;
  pluginDocumentRuntime.observe(window.customElements);
  Object.defineProperty(globalThis, PLUGIN_DOCUMENT_PACKAGE_BRIDGE, {
    value: Object.freeze({ load: pluginDocumentRuntime.load }),
  });
}
