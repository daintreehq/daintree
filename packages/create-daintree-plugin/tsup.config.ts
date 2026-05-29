import { defineConfig } from "tsup";

export default defineConfig({
  entry: { create: "src/create.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // `daintree-plugin` is a declared runtime dependency — resolve it from
  // node_modules rather than bundling a duplicate copy.
  external: ["daintree-plugin", "electron"],
});
