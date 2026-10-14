import path from "node:path";
import { test as base } from "@playwright/test";
import { DEFAULT_PREVIEW_THEME_ID } from "../preview/themes.js";
import { buildPanelPreview } from "./build.js";
import { BrowserProblems } from "./capture.js";
import {
  createPreview,
  discoverStories,
  validateStories,
  validateThemes,
  type PanelPreviewFixtures,
  type PanelPreviewOptions,
} from "./preview.js";
import { startPanelPreviewServer, type PanelPreviewServer } from "./server.js";

export type { PanelPreview, PanelPreviewFixtures, PanelPreviewOptions } from "./preview.js";

export interface PanelPreviewWorkerFixtures {
  previewOptions: PanelPreviewOptions;
  /** The built preview, served for the worker's tests. */
  previewServer: PanelPreviewServer;
}

const DEFAULT_STORIES_PATH = "review/panel.stories.tsx";

/**
 * `@playwright/test`'s `test`, extended with a plugin panel preview: the
 * plugin's stories built and served once per worker, and a `preview` per test
 * that opens a story under a theme and captures it. No Daintree app runs.
 *
 * ```ts
 * test("every story", async ({ preview }) => {
 *   for (const story of preview.stories)
 *     for (const theme of preview.themes) {
 *       await preview.open(story, theme);
 *       await preview.snap(`${story}-${theme}`);
 *     }
 *   await preview.finish();
 * });
 * ```
 */
export const test = base.extend<PanelPreviewFixtures, PanelPreviewWorkerFixtures>({
  previewOptions: [{}, { scope: "worker", option: true }],
  previewServer: [
    async ({ previewOptions }, provide, workerInfo) => {
      const configDir = workerInfo.config.configFile
        ? path.dirname(workerInfo.config.configFile)
        : process.cwd();
      const pluginDir = path.resolve(configDir, previewOptions.pluginDir ?? ".");
      const built = await buildPanelPreview({
        pluginDir,
        storiesPath: previewOptions.storiesPath ?? DEFAULT_STORIES_PATH,
      });
      const server = await startPanelPreviewServer({ title: path.basename(pluginDir), ...built });
      try {
        await provide(server);
      } finally {
        await server.close();
      }
    },
    { scope: "worker", timeout: 120_000 },
  ],
  preview: async ({ page, previewServer, previewOptions }, provide, testInfo) => {
    const problems = new BrowserProblems();
    const onConsole = (message: { type(): string; text(): string }) => {
      if (message.type() === "error") problems.add(`console error: ${message.text()}`);
    };
    const onPageError = (error: Error) => problems.add(`page error: ${error.message}`);
    const onRequestFailed = (request: { url(): string; failure(): { errorText: string } | null }) =>
      problems.add(
        `request failed: ${request.url()} (${request.failure()?.errorText ?? "failed"})`
      );
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    try {
      const themes = validateThemes(previewOptions.themes ?? [DEFAULT_PREVIEW_THEME_ID]);
      const found = await discoverStories(page, previewServer.url, problems);
      const stories = validateStories(previewOptions.stories, found);
      const { preview, unfinished } = createPreview(
        page,
        previewServer.url,
        testInfo,
        stories,
        themes,
        problems
      );
      await provide(preview);
      if (testInfo.status === testInfo.expectedStatus && unfinished()) {
        throw new Error(
          "The test opened a story but never called preview.finish(), so nothing checked that every declared story and theme was captured"
        );
      }
    } finally {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
    }
  },
});

export { expect } from "@playwright/test";
