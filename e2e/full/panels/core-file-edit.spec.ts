import path from "path";
import { readFileSync, realpathSync, writeFileSync } from "fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { dispatchAction } from "../../helpers/actions";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// The file panel's only write-to-disk path: the builtin Markdown editor
// plugin. Its own launch because enabling the plugin adds Edit to every
// Markdown panel for the rest of the app's life, which the read-only file
// surfaces spec must not inherit.

const FILE_NAME = "notes.md";
const ORIGINAL = "# Notes\n\nFirst paragraph.\n";
const FIRST_EDIT = "Saved by the shortcut.";
const SAVED = ORIGINAL + FIRST_EDIT;
const DRAFT_TAIL = " Draft before the rewrite.";
const EXTERNAL = "# Notes\n\nRewritten by another process.\n";

let ctx: AppContext;
let fixtureDir: string;
let filePath: string;
let fixtureCleanup: (() => void) | undefined;

function diskText(): string {
  return readFileSync(filePath, "utf8");
}

function editPanel(page: Page): Locator {
  return page
    .locator(SEL.panel.gridPanel)
    .filter({ has: page.locator('[data-testid="file-pane-body"]') });
}

function editor(page: Page): Locator {
  return editPanel(page).locator('[data-testid="markdown-editor"]');
}

function dirtyMark(page: Page): Locator {
  return editPanel(page).locator('[data-testid="file-pane-dirty"]');
}

/** The buffer as the user sees it, one rendered line per document line. */
async function editorText(page: Page): Promise<string> {
  return editor(page)
    .locator(".cm-content")
    .evaluate((el) =>
      Array.from(el.querySelectorAll(".cm-line"))
        .map((line) => line.textContent ?? "")
        .join("\n")
    );
}

async function openNotesPanel(page: Page) {
  const opened = await dispatchAction(page, "file.openPanel", {
    path: filePath.replace(/\\/g, "/"),
  });
  expect(opened.ok, `file.openPanel failed: ${JSON.stringify(opened)}`).toBe(true);
  await expect(editPanel(page)).toHaveCount(1, { timeout: T_LONG });
}

/** Puts the caret at the end of the document through real keys. */
async function focusEditorEnd(page: Page) {
  const content = editor(page).locator(".cm-content");
  await content.click();
  await expect(content).toBeFocused();
  await page.keyboard.press("ControlOrMeta+End");
}

test.describe.serial("Core: Markdown file editing", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "file-edit" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    // Canonical, as the project records it: macOS hands out temp dirs under the
    // /var -> /private/var symlink, and Edit is only offered for a path inside
    // the project root as spelled.
    filePath = path.join(realpathSync(dir), FILE_NAME);
    writeFileSync(filePath, ORIGINAL);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "File Edit");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("the editing hint enables the plugin and Mod+S writes the edit to disk", async () => {
    const page = ctx.window;
    await openNotesPanel(page);

    const hint = editPanel(page).locator('[data-testid="file-editor-hint"]');
    await expect(hint).toContainText("to edit this file", { timeout: T_LONG });
    await hint.locator('[data-testid="file-editor-hint-action"]').click();

    await expect(editPanel(page).getByRole("radio", { name: "Edit", exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
      { timeout: T_LONG }
    );
    await expect.poll(() => editorText(page), { timeout: T_LONG }).toBe(ORIGINAL);
    await expect(dirtyMark(page)).toHaveCount(0);

    await focusEditorEnd(page);
    await page.keyboard.type(FIRST_EDIT);

    await expect(dirtyMark(page)).toBeVisible({ timeout: T_MEDIUM });
    await expect.poll(() => editorText(page), { timeout: T_SHORT }).toBe(SAVED);
    // Typing alone never writes: the draft lives beside the file until Save.
    expect(diskText()).toBe(ORIGINAL);

    await page.keyboard.press("ControlOrMeta+s");

    await expect.poll(diskText, { timeout: T_MEDIUM }).toBe(SAVED);
    await expect(dirtyMark(page)).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(editor(page).locator('[data-testid="markdown-editor-dirty-state"]')).toHaveText(
      "Saved"
    );
  });

  test("closing a dirty panel asks first: Cancel keeps it, Discard drops the edit", async () => {
    const page = ctx.window;
    await focusEditorEnd(page);
    await page.keyboard.type(" Unsaved tail.");
    await expect(dirtyMark(page)).toBeVisible({ timeout: T_MEDIUM });

    const prompt = page.locator('[data-testid="file-pane-close-prompt"]');
    await editPanel(page).locator(SEL.panel.close).click();
    await expect(prompt).toBeVisible({ timeout: T_MEDIUM });
    await expect(prompt).toContainText(`Save changes to '${FILE_NAME}'?`);

    await prompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(prompt).toHaveCount(0, { timeout: T_SHORT });
    // The panel survived the veto with its draft: it still takes keys, and
    // the new key lands on the unsaved text rather than a reloaded file.
    await focusEditorEnd(page);
    await page.keyboard.type("!");
    await expect.poll(() => editorText(page), { timeout: T_SHORT }).toBe(SAVED + " Unsaved tail.!");
    await expect(dirtyMark(page)).toBeVisible();
    expect(diskText()).toBe(SAVED);

    await editPanel(page).locator(SEL.panel.close).click();
    await expect(prompt).toBeVisible({ timeout: T_MEDIUM });
    await prompt.getByRole("button", { name: "Discard changes", exact: true }).click();

    await expect(prompt).toHaveCount(0, { timeout: T_SHORT });
    await expect(editPanel(page)).toHaveCount(0, { timeout: T_MEDIUM });
    expect(diskText()).toBe(SAVED);
  });

  test("a file changed on disk under a draft holds the save until the disk version is loaded", async () => {
    const page = ctx.window;
    await openNotesPanel(page);

    // The plugin stays on, so Edit is a mode of the toggle rather than a hint.
    await editPanel(page).getByRole("radio", { name: "Edit", exact: true }).click();
    // The discarded draft is gone: the editor opens on what was saved.
    await expect.poll(() => editorText(page), { timeout: T_LONG }).toBe(SAVED);
    await expect(dirtyMark(page)).toHaveCount(0);

    await focusEditorEnd(page);
    await page.keyboard.type(DRAFT_TAIL);
    await expect(dirtyMark(page)).toBeVisible({ timeout: T_MEDIUM });

    writeFileSync(filePath, EXTERNAL);

    const banner = editor(page).getByRole("status").filter({ hasText: "File changed on disk" });
    await expect(banner).toBeVisible({ timeout: T_LONG });
    await expect(dirtyMark(page)).toHaveAttribute(
      "aria-label",
      "Unsaved changes, file changed on disk"
    );

    // Detection keeps the draft as typed rather than merging the disk version.
    await expect.poll(() => editorText(page), { timeout: T_SHORT }).toBe(SAVED + DRAFT_TAIL);

    // Save is held while the conflict stands. The shortcut must not clobber
    // the other writer's bytes; the disk check at the end, after several more
    // round trips, is what would catch a late write.
    await focusEditorEnd(page);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(banner).toBeVisible();
    await expect(dirtyMark(page)).toBeVisible();

    await banner.getByRole("button", { name: "Load disk version", exact: true }).click();
    const confirm = page.getByRole("alertdialog", { name: `Discard changes to '${FILE_NAME}'?` });
    await expect(confirm).toBeVisible({ timeout: T_SHORT });
    // Nothing is replaced until the user confirms.
    expect(await editorText(page)).toBe(SAVED + DRAFT_TAIL);
    await confirm.getByRole("button", { name: "Discard changes", exact: true }).click();

    await expect.poll(() => editorText(page), { timeout: T_MEDIUM }).toBe(EXTERNAL);
    await expect(banner).toHaveCount(0, { timeout: T_MEDIUM });
    await expect(dirtyMark(page)).toHaveCount(0, { timeout: T_MEDIUM });
    expect(diskText()).toBe(EXTERNAL);
  });
});
