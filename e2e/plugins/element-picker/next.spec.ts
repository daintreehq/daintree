import { test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import {
  NEXT,
  NEXT_CARD_HEADING,
  NEXT_COMMANDS,
  NEXT_PAGE_HEADING,
} from "../helpers/frameworks/next";
import {
  expectComponentSelected,
  registerFixtureProject,
  registerPickerSession,
} from "../helpers/pickerSession";
import { pressInPreview, selectInPreview } from "../helpers/previewDriver";

/**
 * The Element Picker on a Next.js 16 App Router site under Turbopack: a
 * heading a server component rendered, which Next's Flight client re-creates
 * on a stack naming the server file, and cards a client component drew in the
 * browser.
 */
const projectDir = registerFixtureProject(() => createSiteProject(NEXT));

test.describe.serial("Element Picker on a Next.js dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: NEXT.title,
    command: NEXT_COMMANDS.dev,
    // Turbopack compiles the page on its first request, after the server is up.
    readyTimeout: 180_000,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("a heading a server component rendered traces to its page", async () => {
    await selectInPreview(session(), "h1", NEXT_PAGE_HEADING);
  });

  test("an element a client component drew traces into that component", async () => {
    await selectInPreview(session(), "article h2", NEXT_CARD_HEADING);
  });

  test("Option+Up selects the client component that drew it", async () => {
    const ctx = session();
    await pressInPreview(ctx.app, "Up", ["alt"]);
    await expectComponentSelected(ctx.window, "FeatureCard");
  });
});
