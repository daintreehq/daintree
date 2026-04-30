import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./electron/services/persistence/schema.ts",
  out: "./electron/services/persistence/migrations",
});
