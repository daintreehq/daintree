import { defineConfig } from "tsup";

// `index` is the React-free core; `react` carries the scene hooks; `kit` and
// `mock-app` are the mockup kit scenes are drawn with. React and Lucide stay
// external (and optional peers) so a scene bundle resolves the host's single
// copy instead of inlining a second one; the pattern covers `react/jsx-runtime`.
// `ignoreDeprecations` is scoped to the dts bundler, which injects a `baseUrl`
// that trips TS5101 under TypeScript 6.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react.ts",
    kit: "src/kit.ts",
    "mock-app": "src/mock-app.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: false,
  dts: { resolve: true, compilerOptions: { ignoreDeprecations: "6.0" } },
  external: [/^react(\/.*)?$/, "lucide-react"],
});
