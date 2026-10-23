import type { HostSourceResolver } from "../../../../shared/elementPicker/resolver.js";
import type { HostOutbound, PluginHostInbound } from "../hostProtocol.js";
import { createHostRuntime, type ResolverLoaders } from "./runtime.js";

/**
 * A plugin resolver host's dispatcher, apart from the process so it can be
 * driven over any channel. The core runtime does the work; what this adds is
 * the one way a module gets imported here: main naming it in a `provider`
 * message. Requests never do.
 */

export interface PluginHostRuntime {
  handle(message: PluginHostInbound): void;
}

/**
 * The default export the SDK's `defineElementPickerResolver` marks: a factory
 * given the provider id main registered, returning the resolver for it. The
 * id the resolver answers as is always that one, whatever the factory says.
 */
export function resolverFromModule(module: unknown, providerId: string): HostSourceResolver {
  let factory = (module as { default?: unknown } | null)?.default;
  // A CommonJS build imported as ESM puts its `exports.default` one level down.
  if (typeof factory !== "function") factory = (factory as { default?: unknown } | null)?.default;
  if (typeof factory !== "function") {
    throw new Error(`the ${providerId} resolver entry has no default export factory`);
  }
  const resolver = (factory as (id: string) => unknown)(providerId) as {
    resolve?: unknown;
  } | null;
  if (typeof resolver !== "object" || resolver === null || typeof resolver.resolve !== "function") {
    throw new Error(`the ${providerId} resolver factory did not return a resolver`);
  }
  const resolve = resolver.resolve as HostSourceResolver["resolve"];
  return { framework: providerId, resolve: (...args) => resolve.apply(resolver, args) };
}

export function createPluginHostRuntime(
  post: (message: HostOutbound) => void,
  importModule: (url: string) => Promise<unknown> = (url) => import(url)
): PluginHostRuntime {
  const loaders = Object.create(null) as ResolverLoaders;
  const runtime = createHostRuntime(post, loaders);
  return {
    handle(message) {
      if (message.type !== "provider") {
        runtime.handle(message);
        return;
      }
      const { providerId, entryUrl } = message;
      // The first word on a provider stands for the life of the process: a
      // reload that moves its entry retires this process instead.
      if (Object.hasOwn(loaders, providerId)) return;
      loaders[providerId] = () =>
        importModule(entryUrl).then((module) => resolverFromModule(module, providerId));
    },
  };
}
