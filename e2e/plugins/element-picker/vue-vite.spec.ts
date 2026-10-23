import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { APP_FILE, VUE_VITE, VUE_VITE_COMMANDS } from "../helpers/frameworks/vueVite";
import { useFixtureProject, usePickerSession } from "../helpers/pickerSession";
import { selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on a Vue 3 + Vite app. Picking works on any page; tracing
 * waits on #13888, which adds Vue's extractor to the core catalog, and then
 * reaches a file only: a stock Vue build names each component's file and
 * nothing finer.
 */
const projectDir = useFixtureProject(() => createSiteProject(VUE_VITE));

test.describe.serial("Element Picker on a Vue + Vite dev server", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: VUE_VITE.title,
    command: VUE_VITE_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test.fixme("a heading traces to its component's file, with no line (#13888)", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", APP_FILE);
    await expect(selectedElement(ctx.window)).not.toContainText(`${APP_FILE}:`);
  });
});
