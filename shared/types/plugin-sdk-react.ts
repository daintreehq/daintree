/**
 * Public renderer-SDK type surface for `@daintreehq/plugin-sdk/react`.
 *
 * The runtime hooks (`useHostChannel`, `usePluginEvent`) live in `src/hooks/`
 * — the renderer's canonical home, where the `window.electron` ambient global
 * is in scope — and are re-exported verbatim by `packages/plugin-sdk/src/react`
 * so plugin authors and the host bundle share one implementation. These types
 * carry the public signatures; the package's declaration build inlines them.
 */

// The `@daintreehq/plugin-ui` kit. Every interface exported here is public
// contract: within a major version props are only ever added, never removed or
// narrowed. Props arrive from untyped JavaScript as often as from TypeScript, so
// the host validates each one at runtime and ignores values outside these types.
//
// The declarations live in `./plugin-sdk-react/`, one module per component
// family. This barrel is the public entry; a family module imports the leaf
// types it needs from `common.ts` or a sibling family, never from this file.

export type * from "./plugin-sdk-react/hooks.js";
export type * from "./plugin-sdk-react/common.js";
export type * from "./plugin-sdk-react/display.js";
export type * from "./plugin-sdk-react/inputs.js";
export type * from "./plugin-sdk-react/overlays.js";
export type * from "./plugin-sdk-react/collections.js";
export type * from "./plugin-sdk-react/layout.js";
export type * from "./plugin-sdk-react/charts.js";
export type * from "./plugin-sdk-react/dnd.js";
export type * from "./plugin-sdk-react/editors.js";
export type * from "./plugin-sdk-react/git.js";
export type * from "./plugin-sdk-react/agents.js";
export type * from "./plugin-sdk-react/workflow.js";
