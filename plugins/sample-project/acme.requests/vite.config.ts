import { daintreePlugin } from "@daintreehq/plugin-vite";
import { defineConfig } from "vite";

// One build for the worker, the three views and the tour scenes. The output is
// committed: Daintree loads dist/ as it is and never builds a project plugin.
// It is kept byte-reproducible so a check can rebuild it and spot a stale
// commit — unminified, no sourcemaps (a map would carry this machine's paths),
// and no debug-info comments, whose paths depend on where packages resolve.
export default defineConfig({
  plugins: [daintreePlugin()],
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        home: "src/views/home.tsx",
        sidebar: "src/views/sidebar.tsx",
        settings: "src/views/settings.tsx",
        tour: "src/tour.tsx",
      },
      formats: ["es"],
    },
    outDir: "dist",
    minify: false,
    sourcemap: false,
    rolldownOptions: { experimental: { attachDebugInfo: "none" } },
  },
});
