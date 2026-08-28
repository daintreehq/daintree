/**
 * `AppDialog.Body` forwards its `className` to the padded scroll box that
 * directly parents the body content. Callers pass sibling-spacing utilities
 * (`space-y-*`), and those only take effect on the fields' immediate parent —
 * when the class landed on ScrollShadow's outer wrapper instead, every field
 * group in twelve dialogs rendered flush against the next.
 *
 * Measured against real rendered geometry rather than class names: the bug was
 * invisible to jsdom (which computes no Tailwind styles) and to any assertion
 * that only checks a class is present somewhere in the tree.
 */
import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { launchApp, closeApp, mockOpenDialog, type AppContext } from "../../helpers/launch";
import { dismissBlockingPalette } from "../../helpers/overlays";
import { T_SHORT, T_MEDIUM } from "../../helpers/timeouts";

let ctx: AppContext;
let plainDir: string;

/**
 * Vertical gap between two elements, in CSS pixels. Reads back what the user
 * actually sees, so it fails on the real symptom (controls touching) no matter
 * which layer caused it.
 */
async function verticalGap(
  above: import("@playwright/test").Locator,
  below: import("@playwright/test").Locator
): Promise<number> {
  const top = await above.boundingBox();
  const bottom = await below.boundingBox();
  if (!top || !bottom) throw new Error("expected both elements to be laid out");
  return bottom.y - (top.y + top.height);
}

test.describe.serial("AppDialog body spacing", () => {
  test.beforeAll(async () => {
    // A plain folder with no .git — this is what routes the open flow into the
    // non-git dialog and, from there, into project setup.
    plainDir = mkdtempSync(path.join(tmpdir(), "daintree-plain-"));
    writeFileSync(path.join(plainDir, "notes.txt"), "not a repo\n");

    ctx = await launchApp();
    await mockOpenDialog(ctx.app, plainDir);
    await ctx.window.getByRole("button", { name: "Open folder" }).click();
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    if (plainDir) rmSync(plainDir, { recursive: true, force: true });
  });

  test("separates the non-git dialog's path caption from its explanation", async () => {
    const { window } = ctx;
    await dismissBlockingPalette(window);

    const dialog = window.getByRole("dialog", { name: /^Open ‘/ });
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    const caption = dialog.locator("p").first();
    const explanation = dialog.getByText(/isn’t a git repository/);
    await expect(explanation).toBeVisible({ timeout: T_SHORT });

    // Asserts separation exists, not its exact token value: pinning the pixel
    // count here would just copy `space-y-3` back out of the source. Zero is
    // the regression — the two paragraphs rendered as one block of text.
    expect(await verticalGap(caption, explanation)).toBeGreaterThan(4);
  });

  test("separates the setup dialog's template select from the commit checkbox", async () => {
    const { window } = ctx;

    const nonGitDialog = window.getByRole("dialog", { name: /^Open ‘/ });
    await nonGitDialog.getByRole("button", { name: "Initialize repository" }).click();

    const setup = window.getByRole("dialog", { name: "Set up repository" });
    await expect(setup).toBeVisible({ timeout: T_MEDIUM });

    // The reported symptom: the checkbox sat flush against the select above it.
    const select = setup.locator("select#git-init-template");
    const checkbox = setup.getByRole("checkbox", { name: "Create initial commit" });
    await expect(select).toBeVisible({ timeout: T_SHORT });

    const gap = await verticalGap(select, checkbox);
    // A checkbox is shorter than its label's line box, so `items-center`
    // contributes a couple of pixels of leading even with no margin at all —
    // the broken build measured within that noise. Require clearly more.
    expect(gap).toBeGreaterThan(8);
  });

  test("keeps every setup field group separated", async () => {
    const { window } = ctx;
    const setup = window.getByRole("dialog", { name: "Set up repository" });

    // Walk the body's own children rather than naming fields: this holds as the
    // dialog gains or loses groups, and catches a partial regression where only
    // some pairs collapse.
    const gaps = await setup.evaluate((root) => {
      const label = root.querySelector("label[for='git-init-project-name']");
      const body = label?.parentElement?.parentElement;
      if (!body) return null;
      const kids = Array.from(body.children).map((el) => el.getBoundingClientRect());
      return kids.slice(1).map((box, i) => box.top - (kids[i]!.top + kids[i]!.height));
    });

    expect(gaps).not.toBeNull();
    expect(gaps!.length).toBeGreaterThan(1);
    for (const gap of gaps!) {
      expect(gap).toBeGreaterThan(8);
    }
  });
});
