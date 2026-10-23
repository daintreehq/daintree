import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { ANGULAR, ANGULAR_COMMANDS, APP_FILE } from "../helpers/frameworks/angular";
import {
  expectComponentSelected,
  useFixtureProject,
  usePickerSession,
} from "../helpers/pickerSession";
import { pressInPreview, selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on an Angular 22 app. Tracing waits on #13888, which adds
 * Angular's extractor to the core catalog. A stock dev build then names each
 * component and its class's file; a template line needs a compiler option this
 * site leaves off, so nothing here asks for one.
 */
const projectDir = useFixtureProject(() => createSiteProject(ANGULAR));

test.describe.serial("Element Picker on an Angular dev server", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: ANGULAR.title,
    command: ANGULAR_COMMANDS.dev,
    readyTimeout: 180_000,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test.fixme("Option+Up selects the component and names its class's file (#13888)", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expectComponentSelected(ctx.window, "App");
    await expect(selectedElement(ctx.window)).toContainText(APP_FILE);
  });
});
