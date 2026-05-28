# @daintreehq/plugin-vite

Vite externals preset for Daintree plugins.

Daintree's renderer ships React 19 in a host `vendor-react` chunk and injects a `<script type="importmap">` mapping the bare `react`, `react-dom`, and documented subpaths to that chunk. Plugin bundles need to externalize the same specifiers so they resolve, at runtime, to the host's single React instance — bundling a second copy produces "Invalid hook call" the first time JSX renders.

## Usage

```ts
// vite.config.ts in a plugin
import { defineConfig } from "vite";
import { daintreePlugin } from "@daintreehq/plugin-vite";

export default defineConfig({
  plugins: [daintreePlugin()],
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"] },
  },
});
```

The plugin sets `build.rollupOptions.external` to:

```ts
[/^react($|\/)/, /^react-dom($|\/)/];
```

The regex form is load-bearing — `external: ["react"]` only matches the literal `"react"` and silently bundles `react/jsx-runtime` into plugin output.
