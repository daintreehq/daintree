import { test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { ASTRO, ASTRO_COMMANDS, ASTRO_HEADING } from "../helpers/frameworks/astro";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on an Astro site with no UI framework. Astro's dev
 * toolbar stamps every element with the file and line that wrote it, and the
 * host checks the stamp against the page's source.
 */
const projectDir = registerFixtureProject(() => createSiteProject(ASTRO));

test.describe.serial("Element Picker on an Astro dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: ASTRO.title,
    command: ASTRO_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test("a heading traces to the line of the page that wrote it", async () => {
    await selectInPreview(session(), "h1", ASTRO_HEADING);
  });
});
