import { test, expect } from "@playwright/test";
import { runPackageScript } from "../helpers/fixtureProject";
import { viteCommand } from "../helpers/frameworks/site";
import {
  expectComponentSelected,
  expectNotTraced,
  useFixtureProject,
  usePickerSession,
} from "../helpers/pickerSession";
import { CARD_FILE, createSvelteKitProject, PAGE_FILE } from "../helpers/sveltekitProject";
import { pressInPreview, selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on a SvelteKit 2 + Svelte 5 app, served by its dev server
 * and then as a production build. Svelte's dev build stamps every element with
 * its own location, so the production build is the negative: the same markup
 * with no stamps, which the page reports about itself.
 */
const projectDir = useFixtureProject(() => createSvelteKitProject("picker-sveltekit"));

test.describe.serial("Element Picker on a SvelteKit dev server", () => {
  const { session, start } = usePickerSession({
    projectDir,
    projectName: "SvelteKit site",
    command: (port) => viteCommand("dev", port),
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading traces to the Svelte that wrote it", async () => {
    await selectInPreview(session(), "h1", `${PAGE_FILE}:2`);
  });

  test("an element a child component drew traces into that component", async () => {
    await selectInPreview(session(), "article h2", `${CARD_FILE}:6`);
  });

  test("Option+Up selects the component that drew it", async () => {
    const ctx = session();
    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expectComponentSelected(ctx.window, "FeatureCard");
  });
});

test.describe.serial("Element Picker on a SvelteKit production build", () => {
  test.beforeAll(() => runPackageScript(projectDir(), "build"));

  const { session, start } = usePickerSession({
    projectDir,
    projectName: "SvelteKit site",
    command: (port) => viteCommand("preview", port),
  });

  test("the built site starts in a dev preview with the Element Picker on", start);

  test("a heading is selected but not traced to source", async () => {
    const ctx = session();
    await selectInPreview(ctx, "h1", "h1");
    await expectNotTraced(ctx.window, PAGE_FILE);
  });

  test("the drawer says the preview is a production build", async () => {
    // The page settles before it reports on itself, so this can trail the pick.
    await expect(
      session()
        .window.getByRole("complementary", { name: "Element Picker details" })
        .getByRole("status")
        .filter({ hasText: "This preview is a production build" })
    ).toBeVisible({ timeout: 30_000 });
  });
});
