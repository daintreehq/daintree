import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { STATIC_HTML, STATIC_HTML_COMMANDS } from "../helpers/frameworks/staticHtml";
import { expectNotTraced, useFixtureProject, usePickerSession } from "../helpers/pickerSession";
import { selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on hand-written HTML from a plain file server: no
 * framework to ask, so the picker has the DOM and must not claim more.
 */
const projectDir = useFixtureProject(() => createSiteProject(STATIC_HTML));

test.describe.serial("Element Picker on a static site", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: STATIC_HTML.title,
    command: STATIC_HTML_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading is selected but not traced to source", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await expectNotTraced(ctx.window, "index.html");
    await expect(selectedElement(ctx.window)).toContainText(
      "The page reported no source for this element"
    );
  });
});
