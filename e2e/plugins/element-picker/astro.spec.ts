import { test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { ASTRO, ASTRO_COMMANDS, ASTRO_HEADING } from "../helpers/frameworks/astro";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on an Astro site with no UI framework. While its dev
 * toolbar is on, Astro's compiler stamps each eligible element (not html, head
 * or script, among others) with the file and line that wrote it, but the
 * toolbar's Audit app moves those stamps off the elements as soon as it
 * initialises, so the picker finds none to read (#15913). Picking still works;
 * tracing waits on that fix.
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

  test.fixme("a heading traces to the line of the page that wrote it (#15913)", async () => {
    await selectInPreview(session(), "h1", ASTRO_HEADING);
  });
});
