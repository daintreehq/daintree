import type { ResolverLoaders } from "./runtime.js";

/**
 * Every resolver the host can load. Each lives in its own module under
 * `worker/resolvers/` and is reached by one explicit `import()` here, so a
 * request names a framework and the host evaluates only that framework's code;
 * `scripts/element-picker-host-boundary.test.ts` fails a static import of one.
 * A framework with no entry resolves every candidate as `unsupported`.
 */
export const RESOLVER_LOADERS: ResolverLoaders = {
  svelte: () => import("./resolvers/svelte.js").then((module) => module.svelteResolver),
  react: () => import("./resolvers/react.js").then((module) => module.reactResolver),
  vue: () => import("./resolvers/vue.js").then((module) => module.vueResolver),
  angular: () => import("./resolvers/angular.js").then((module) => module.angularResolver),
  astro: () => import("./resolvers/astro.js").then((module) => module.astroResolver),
  preact: () => import("./resolvers/preact.js").then((module) => module.preactResolver),
};
