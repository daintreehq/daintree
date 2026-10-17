import { defineConfig } from "@playwright/test";

/**
 * The file tree's panel preview, outside Daintree: every story in
 * review/panel.stories.tsx, captured by review/panel.spec.ts. Run from the repo
 * root after `npm run build --workspace=packages/plugin-sdk` (the preview needs
 * the SDK's browser build):
 *
 *   npx playwright test -c plugins/sample/file-tree/playwright.config.ts
 */
export default defineConfig({
  testDir: "review",
  outputDir: "../../../test-results/sample-file-tree",
  use: { browserName: "chromium", viewport: { width: 360, height: 480 } },
});
