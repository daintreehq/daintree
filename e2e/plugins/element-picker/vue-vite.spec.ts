import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { APP_FILE, VUE_VITE, VUE_VITE_COMMANDS } from "../helpers/frameworks/vueVite";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on a Vue 3 + Vite app. A stock Vue build names each
 * component's file (`type.__file`) and nothing finer, so a pick traces to a
 * file only: a line needs `vite-plugin-vue-inspector`, which this site leaves
 * out.
 */
const projectDir = registerFixtureProject(() => createSiteProject(VUE_VITE));

test.describe.serial("Element Picker on a Vue + Vite dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: VUE_VITE.title,
    command: VUE_VITE_COMMANDS.dev,
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
