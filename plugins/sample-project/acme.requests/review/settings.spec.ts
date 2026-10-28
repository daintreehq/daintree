import { test } from "@daintreehq/plugin-sdk/testing/playwright";

// Every story in review/settings.stories.tsx, built and served without Daintree
// running. Screenshots land in test-results/; a capture fails on a console
// error or a story that did not render, and finish() on one that never ran.
test.use({ previewOptions: { storiesPath: "review/settings.stories.tsx", themes: ["daintree"] } });

test("every settings story renders", async ({ preview }) => {
  for (const story of preview.stories) {
    for (const theme of preview.themes) {
      await preview.open(story, theme);
      await preview.snap(`${story}-${theme}`);
    }
  }
  await preview.finish();
});
