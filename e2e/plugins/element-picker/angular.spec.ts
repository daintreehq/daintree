import { test, expect } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { ANGULAR, ANGULAR_COMMANDS, APP_FILE } from "../helpers/frameworks/angular";
import {
  expectComponentSelected,
  expectComponentsNamed,
  registerFixtureProject,
  registerPickerSession,
} from "../helpers/pickerSession";
import { pressInPreview, selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on an Angular 22 app. A stock dev build names each
 * component and its class's file; a template line needs a compiler option this
 * site leaves off, so the component is placed by its file alone.
 */
const projectDir = registerFixtureProject(() => createSiteProject(ANGULAR));

test.describe.serial("Element Picker on an Angular dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: ANGULAR.title,
    command: ANGULAR_COMMANDS.dev,
    readyTimeout: 180_000,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test("Option+Up selects the component and names its class's file", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    // Option+Up on a page whose extractor hasn't answered yet finds no
    // component to widen to, and nothing replays the key once it does.
    await expectComponentsNamed(ctx.window, "App");
    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expectComponentSelected(ctx.window, "App");
    await expect(selectedElement(ctx.window)).toContainText(APP_FILE);
  });
});
