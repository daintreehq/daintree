import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { SOLID, SOLID_COMMANDS } from "../helpers/frameworks/solid";
import { expectNotTraced, useFixtureProject, usePickerSession } from "../helpers/pickerSession";
import { selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on a stock Solid app. Solid's dev build leaves nothing on
 * the page to trace an element by, so the picker must select it and say so
 * rather than place it anywhere.
 */
const projectDir = useFixtureProject(() => createSiteProject(SOLID));

test.describe.serial("Element Picker on a Solid dev server", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: SOLID.title,
    command: SOLID_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading is selected but not traced to source", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await expectNotTraced(ctx.window, "src/App.jsx");
    await expect(selectedElement(ctx.window)).toContainText(
      "The page reported no source for this element"
    );
  });
});
