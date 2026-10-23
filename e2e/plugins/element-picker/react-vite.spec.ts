import { test, expect } from "@playwright/test";
import { runPackageScript } from "../helpers/fixtureProject";
import { createSiteProject } from "../helpers/frameworks/site";
import {
  APP_FILE,
  REACT_CARD_HEADING,
  REACT_HEADING,
  REACT_VITE,
  REACT_VITE_COMMANDS,
} from "../helpers/frameworks/reactVite";
import {
  expectComponentSelected,
  expectNotTraced,
  registerFixtureProject,
  registerPickerSession,
} from "../helpers/pickerSession";
import { pressInPreview, selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on a React 19 + Vite app, three ways from one install:
 * the dev server, the same dev server with the app's source maps dropped, and
 * a production build. React's only source is the stack each element was
 * created on, so the two negatives check that a stack the host can't map is
 * reported as untraced rather than placed by the module URL it ran from.
 */
const projectDir = registerFixtureProject(() => createSiteProject(REACT_VITE));

test.describe.serial("Element Picker on a React + Vite dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: REACT_VITE.title,
    command: REACT_VITE_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading traces to the JSX that created it", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", REACT_HEADING);
    await expect(ctx.window.getByRole("toolbar", { name: "Element Picker" })).toContainText("h1");
  });

  test("an element a child component drew traces into that component", async () => {
    await selectInPreview(session(), "article h2", REACT_CARD_HEADING);
  });

  test("Option+Up selects the component that drew it", async () => {
    const ctx = session();
    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expectComponentSelected(ctx.window, "FeatureCard");
  });
});

test.describe.serial("Element Picker on a React + Vite dev server without source maps", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: REACT_VITE.title,
    command: REACT_VITE_COMMANDS.noSourceMaps,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading is selected but not traced to source", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await expectNotTraced(ctx.window, APP_FILE);
    // A dev build that lost its maps is not a production build.
    await expect(selectedElement(ctx.window)).not.toContainText("production build");
  });
});

test.describe.serial("Element Picker on a React + Vite production build", () => {
  test.beforeAll(() => runPackageScript(projectDir(), "build"));

  const { session, start } = registerPickerSession({
    projectDir,
    projectName: REACT_VITE.title,
    command: REACT_VITE_COMMANDS.production,
  });

  test("the built site starts in a dev preview with the Element Picker on", start);

  test("a heading is selected but not traced to source", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await expectNotTraced(ctx.window, APP_FILE);
  });
});
