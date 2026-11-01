import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { APP_FILE, NUXT, NUXT_COMMANDS } from "../helpers/frameworks/nuxt";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on a Nuxt 4 site: Vue rendered on the server and
 * hydrated. As with plain Vue, a pick traces to the component's file without a
 * line.
 */
const projectDir = registerFixtureProject(() => createSiteProject(NUXT));

test.describe.serial("Element Picker on a Nuxt dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: NUXT.title,
    command: NUXT_COMMANDS.dev,
    readyTimeout: 180_000,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test("a heading traces to its component's file, with no line", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", APP_FILE);
    await expect(selectedElement(ctx.window)).not.toContainText(`${APP_FILE}:`);
  });
});
