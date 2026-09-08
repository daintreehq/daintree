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

## Document packages

Use `documentPackages` for libraries that register document globals, such as Lexxy and Trix. Each entry builds independently into one content-addressed JavaScript asset; the virtual import exports an asynchronous loader. Matching document-scoped packages execute once across plugins and hot reloads. Different versions or bundle hashes are refused until the project window reloads.

```ts
daintreePlugin({
  documentPackages: {
    "@acme/markdown-editor": {
      entry: "src/editor-adapter.ts",
      version: "1.0.0",
      scope: "document",
    },
  },
});
```

```ts
import loadEditor from "virtual:daintree-document-package/@acme/markdown-editor";
const editor = await loadEditor();
```

The default scope is `"plugin"`; use `"document"` explicitly when cooperating trusted plugins must share global registration. This is a module-lifetime boundary, not a security sandbox. Keep the complete editor integration in the adapter, styles in the view build, and per-panel state in per-instance objects. See [the full contract and security recommendations](../../docs/plugins/document-packages.md).
