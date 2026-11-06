import { test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { PREACT, PREACT_COMMANDS, PREACT_HEADING } from "../helpers/frameworks/preact";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on a Preact app built by its own Vite preset, whose dev
 * transform puts each element's JSX location on its vnode.
 */
const projectDir = registerFixtureProject(() => createSiteProject(PREACT));

test.describe.serial("Element Picker on a Preact dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: PREACT.title,
    command: PREACT_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test("a heading traces to the JSX that created it", async () => {
    await selectInPreview(session(), "h1", PREACT_HEADING);
  });
});
