import { defineConfig } from "@playwright/test";

// The panel preview (`npm run test:preview`). Install a browser once with
// `npx playwright install chromium`. The viewport is roughly Home's size.
export default defineConfig({
  testDir: "review",
  use: { browserName: "chromium", viewport: { width: 900, height: 600 } },
});
