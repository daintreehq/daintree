// Dependency-free so a Node tool (the `daintree-plugin tour preview` server)
// can read the host contract without importing Vite.
/**
 * The specifiers the Daintree host import map serves to bundled views, which
 * the plugin build externalizes: React's public entrypoints, the public subpaths
 * of `@daintreehq/tour`, and `@daintreehq/plugin-ui` (host UI components,
 * compiled from `src/pluginUi`). The map also serves
 * {@link HOST_IMPORTMAP_RAW_ONLY_SPECIFIERS}, which are not externalized. This is the single
 * source of truth for the host/plugin contract: `vite.config.ts` emits one facade
 * chunk per served specifier and builds the `<script
 * type="importmap">` it injects from them, and the plugin build (`index.ts`) errors at build
 * time on any React, tour or plugin-ui subpath outside it. Keeping the two sides on one
 * constant is what stops the "externalized but unresolved at runtime" drift
 * (e.g. `react-dom/server`) that this list previously had to be hand-synced
 * against.
 *
 * Adding an entry here is a real change on the host side: it must also declare
 * the specifier's expected public exports in `HOST_FACADE_REQUIRED_EXPORTS`
 * (vite.config.ts), which is typed against this list and will fail typecheck
 * until it does.
 */
export const HOST_IMPORTMAP_SPECIFIERS = [
  "react",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom",
  "react-dom/client",
  "@daintreehq/tour",
  "@daintreehq/tour/react",
  "@daintreehq/tour/kit",
  "@daintreehq/tour/mock-app",
  "@daintreehq/plugin-ui",
] as const;

/**
 * Specifiers the host import map serves ONLY to zero-build (raw) views, which
 * have no bundler to supply them. `@daintreehq/plugin-vite` deliberately does
 * not externalize these: a bundled view pins its own SDK version and keeps
 * bundling that copy, so a host upgrade can never swap the hooks out from under
 * it. The host serves one instance per document, shared by every raw view.
 *
 * Kept apart from {@link HOST_IMPORTMAP_SPECIFIERS} for exactly that reason —
 * that list is the externals contract; this one is not.
 */
export const HOST_IMPORTMAP_RAW_ONLY_SPECIFIERS = ["@daintreehq/plugin-sdk/react"] as const;

/** Everything the host import map serves: the externals contract plus the raw-only entries. */
export const HOST_IMPORTMAP_SERVED_SPECIFIERS = [
  ...HOST_IMPORTMAP_SPECIFIERS,
  ...HOST_IMPORTMAP_RAW_ONLY_SPECIFIERS,
] as const;
