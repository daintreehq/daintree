import { expect, test } from "@playwright/test";
import { createSiteProject } from "../helpers/frameworks/site";
import { ASTRO, ASTRO_COMMANDS, ASTRO_HEADING } from "../helpers/frameworks/astro";
import { registerFixtureProject, registerPickerSession } from "../helpers/pickerSession";
import { dispatch, inPreview, selectInPreview, selectedElement } from "../helpers/previewDriver";

/**
 * The Element Picker on an Astro site with no UI framework. While its dev
 * toolbar is on, Astro's compiler stamps each eligible element (not html, head
 * or script, among others) with the file and line that wrote it, and the
 * toolbar's Audit app moves those stamps off the elements as soon as it
 * initialises. The picker reads them from the markup as served instead, and
 * knows the page for Astro's by the toolbar itself (#15913).
 */
const STAMPS_TAKEN_OFF = `document.querySelector("astro-dev-toolbar") !== null &&
  document.querySelectorAll("[data-astro-source-file]").length === 0`;
const projectDir = registerFixtureProject(() => createSiteProject(ASTRO));

test.describe.serial("Element Picker on an Astro dev server", () => {
  const { session, start } = registerPickerSession({
    projectDir,
    projectName: ASTRO.title,
    command: ASTRO_COMMANDS.dev,
  });

  test("the site starts in a dev preview with the Element Picker on", start);

  test("clicking a heading selects it", async () => {
    await selectInPreview(session(), "h1", "h1");
  });

  test("a heading traces to the line of the page that wrote it", async () => {
    // Only a pick made once the toolbar has run proves the served markup is read.
    await expect
      .poll(() => inPreview<boolean>(session().app, STAMPS_TAKEN_OFF), { timeout: 30_000 })
      .toBe(true);
    await selectInPreview(session(), "h1", ASTRO_HEADING);
  });

  test("switched on after the toolbar took the stamps off, it still traces the heading", async () => {
    const { window } = session();
    const strip = window.getByRole("toolbar", { name: "Element Picker" });
    expect((await dispatch(window, "devPreview.toggleElementPicker")).ok).toBe(true);
    await expect(strip).toBeHidden({ timeout: 10_000 });
    await expect(selectedElement(window)).toBeHidden();
    expect((await dispatch(window, "devPreview.toggleElementPicker")).ok).toBe(true);
    await expect(
      strip.getByRole("status").filter({ hasText: "Click an element to ask an agent about it" })
    ).toBeVisible({ timeout: 30_000 });
    await selectInPreview(session(), "h1", ASTRO_HEADING);
  });
});
