import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

/**
 * Builds the hook-based panel view (#11208) with the PUBLIC plugin preset —
 * `daintreePlugin()` from `@daintreehq/plugin-vite`, byte-for-byte the entry a
 * third-party author uses. That is the point: the preset externalizes React so
 * the bundle resolves it through the host import map at load time, which is the
 * exact contract that shipped broken. Hand-writing browser-ready ESM here would
 * exercise a path no real plugin takes.
 *
 * Not wired into `npm run build`. The output is committed and copied verbatim by
 * `build-main.mjs` (which must NOT process `view/`, or it would bundle a second
 * React and break the single-instance guarantee). Building it on every app build
 * would also force a `packages:build` into the main chain for one sample.
 *
 * Regenerate with `npm run build:sample-rich-view` from the repo root; that
 * script builds the workspace preset first and passes this directory as the
 * positional root arg, which is what makes the relative paths below resolve
 * against it rather than the repo root.
 */
export default defineConfig({
  plugins: [daintreePlugin()],
  // Explicit rather than inherited from a discovered tsconfig: the automatic
  // runtime is what routes JSX through `react/jsx-runtime`, one of the five
  // mapped specifiers under test.
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "view",
    // `view/` also holds the hand-authored rich-panel-view.js — emptying it
    // would delete that sibling.
    emptyOutDir: false,
    // Committed artifact: readable diffs matter more than bytes for a sample.
    minify: false,
    lib: {
      entry: "renderer/hook-panel-view.tsx",
      formats: ["es"],
      fileName: () => "hook-panel-view.js",
    },
  },
});
