// Dependency-free so a Node tool (the `daintree-plugin tour preview` server)
// can read the host contract without importing Vite.
/**
 * The exact specifiers the Daintree host import map serves: React's public
 * entrypoints and the public subpaths of `@daintreehq/tour`. This is the single
 * source of truth for the host/plugin contract: `vite.config.ts` imports this
 * list to emit one facade chunk per specifier and to build the `<script
 * type="importmap">` it injects, and the plugin build (`index.ts`) errors at build
 * time on any React or tour subpath outside it. Keeping the two sides on one
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
] as const;
