import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

/**
 * Builds the sample file browser's view with the PUBLIC plugin preset —
 * `daintreePlugin()` from `@daintreehq/plugin-vite`, byte-for-byte the entry a
 * third-party author uses.
 *
 * That is the point of this sample. Daintree's own file browser reuses the same
 * tree model, but it imports the package *source* by relative path, so it stays
 * green even if `@daintreehq/plugin-sdk/files` is not exported, not built, or
 * exports something that does not resolve. This build goes through the package
 * boundary, so those failures land here instead of on an author.
 *
 * The preset externalizes React so the bundle resolves it through the host
 * import map at load time; the SDK itself is bundled in, which is why a missing
 * export fails the build rather than the app.
 *
 * Not wired into `npm run build`. The output is committed and copied verbatim by
 * `build-main.mjs` (which must NOT process `view/`, or it would bundle a second
 * React and break the single-instance guarantee). Regenerate with
 * `npm run build:sample-file-tree` from the repo root; that script builds the
 * SDK and the preset first, then passes this directory as the positional root
 * arg, which is what makes the relative paths below resolve against it.
 */
export default defineConfig({
  plugins: [daintreePlugin()],
  // Explicit rather than inherited from a discovered tsconfig: the automatic
  // runtime is what routes JSX through `react/jsx-runtime`.
  esbuild: { jsx: "automatic" },
  build: {
    outDir: "view",
    emptyOutDir: false,
    // Committed artifact: readable diffs matter more than bytes for a sample.
    minify: false,
    lib: {
      entry: "renderer/file-tree-view.tsx",
      formats: ["es"],
      fileName: () => "file-tree-view.js",
    },
  },
});
