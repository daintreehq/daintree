import { test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { PREACT, PREACT_COMMANDS, PREACT_HEADING } from "../helpers/frameworks/preact";
import { useFixtureProject, usePickerSession } from "../helpers/pickerSession";
import { selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on a Preact app built by its own Vite preset, whose dev
 * transform puts each element's JSX location on its vnode. Reading it waits
 * on #13888, which adds Preact's extractor to the core catalog.
 */
const projectDir = useFixtureProject(() => createSiteProject(PREACT));

test.describe.serial("Element Picker on a Preact dev server", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: PREACT.title,
    command: PREACT_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test.fixme("a heading traces to the JSX that created it (#13888)", async () => {
    await selectInPreview(session(), "h1", PREACT_HEADING);
  });
});
