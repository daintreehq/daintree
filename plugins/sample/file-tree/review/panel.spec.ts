import { test } from "@daintreehq/plugin-sdk/testing/playwright";

// Every state of the sample file browser, in a dark and a light theme.
test.use({ previewOptions: { themes: ["daintree", "bondi"] } });

test("every file tree story renders", async ({ preview }) => {
  for (const story of preview.stories) {
    for (const theme of preview.themes) {
      await preview.open(story, theme);
      await preview.snap(`${story}-${theme}`);
    }
  }
  await preview.finish();
});
