import path from "path";
import { writeFileSync } from "fs";
import { test, expect, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

const SPEC_MARKDOWN = [
  "# Markdown E2E Spec",
  "",
  "Intro paragraph with **bold** text.",
  "",
  "| Column A | Column B |",
  "| -------- | -------- |",
  "| alpha    | beta     |",
  "",
  "- [x] shipped item",
  "- [ ] open item",
  "",
  "```typescript",
  'const greeting: string = "hello";',
  "```",
  "",
].join("\n");

const STYLES_CSS = ".file-panel-fixture { color: rebeccapurple; }\n";

async function dispatchAction(page: Page, actionId: string, args?: unknown): Promise<unknown> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => unknown;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function dispatchViewFile(page: Page, filePath: string) {
  const normPath = filePath.replace(/\\/g, "/");
  const normRoot = fixtureDir.replace(/\\/g, "/");
  await page.evaluate(
    ({ p, r }) => {
      window.dispatchEvent(
        new CustomEvent("daintree:view-file", { detail: { path: p, rootPath: r } })
      );
    },
    { p: normPath, r: normRoot }
  );
}

function filePanes(page: Page) {
  return page.locator('[data-testid="file-pane-body"]');
}

test.describe.serial("Core: File viewer panel (dialog + panel)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "file-panel" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFileSync(path.join(dir, "spec.md"), SPEC_MARKDOWN);
    writeFileSync(path.join(dir, "styles.css"), STYLES_CSS);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "File Panel");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("dialog opens markdown as source by default, with wrapping on", async () => {
    await dispatchViewFile(ctx.window, path.join(fixtureDir, "spec.md"));

    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

    // Source-first: raw markdown in CodeMirror, including literal markers.
    await expect(dialog.locator(".cm-content")).toContainText("# Markdown E2E Spec", {
      timeout: T_LONG,
    });
    await expect(dialog.locator(SEL.fileViewer.metadataBar)).toBeVisible({ timeout: T_SHORT });

    // Markdown source wraps by default (EditorView.lineWrapping tags cm-content).
    await expect(dialog.locator(".cm-content.cm-lineWrapping")).toBeVisible({ timeout: T_SHORT });
  });

  test("Rendered mode renders the document with theme-token colors", async () => {
    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await dialog.getByRole("button", { name: "Rendered", exact: true }).click();

    // Rendered document, not raw markdown: a real <h1> without the "#" marker.
    const heading = dialog.locator(".markdown-document h1");
    await expect(heading).toBeVisible({ timeout: T_LONG });
    await expect(heading).toHaveText("Markdown E2E Spec");

    // GFM table renders as a real table.
    await expect(dialog.locator(".markdown-document table")).toBeVisible({ timeout: T_SHORT });

    // Fenced code is refractor-highlighted with the diff viewer's token classes.
    await expect(dialog.locator(".markdown-document .token.keyword").first()).toBeVisible({
      timeout: T_MEDIUM,
    });

    // Theme regression guard: prose colors must resolve to the app's theme
    // tokens, not the typography plugin's light-theme defaults (the plugin's
    // `.prose` lives in @layer utilities and silently wins if the overrides
    // are ever wrapped in a layer again).
    const colors = await heading.evaluate((el) => {
      const expected = getComputedStyle(el).getPropertyValue("--color-text-primary").trim();
      const probe = document.createElement("span");
      probe.style.color = expected;
      document.body.appendChild(probe);
      const expectedResolved = getComputedStyle(probe).color;
      probe.remove();
      return { actual: getComputedStyle(el).color, expected: expectedResolved };
    });
    expect(colors.actual).toBe(colors.expected);
  });

  test("Open as panel promotes the dialog into a file grid panel, keeping the mode", async () => {
    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await dialog.locator('[data-testid="file-viewer-open-as-panel"]').click();

    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    // The dialog was in Rendered mode, so the panel opens rendered too.
    const pane = filePanes(ctx.window).first();
    await expect(pane).toBeVisible({ timeout: T_LONG });
    await expect(pane.locator(".markdown-document h1")).toHaveText("Markdown E2E Spec", {
      timeout: T_LONG,
    });
  });

  test("panel toolbar toggles source/rendered and the wrap preference", async () => {
    const pane = filePanes(ctx.window).first();
    const panel = ctx.window.locator(SEL.panel.gridPanel).filter({ has: pane });

    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await expect(pane.locator(".cm-content")).toContainText("# Markdown E2E Spec", {
      timeout: T_LONG,
    });
    await expect(pane.locator(".cm-content.cm-lineWrapping")).toBeVisible({ timeout: T_SHORT });

    // Wrap is a toggle: off removes CodeMirror's wrapping class, on restores it.
    const wrapToggle = panel.getByRole("button", { name: "Wrap long lines" });
    await expect(wrapToggle).toHaveAttribute("aria-pressed", "true");
    await wrapToggle.click();
    await expect(pane.locator(".cm-content.cm-lineWrapping")).toHaveCount(0, {
      timeout: T_SHORT,
    });
    await wrapToggle.click();
    await expect(pane.locator(".cm-content.cm-lineWrapping")).toBeVisible({ timeout: T_SHORT });

    await panel.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(pane.locator(".markdown-document h1")).toBeVisible({ timeout: T_MEDIUM });
  });

  test("file.openPanel reuses the panel for the same file and creates one for a new file", async () => {
    await dispatchAction(ctx.window, "file.openPanel", {
      path: path.join(fixtureDir, "spec.md").replace(/\\/g, "/"),
    });
    await expect(filePanes(ctx.window)).toHaveCount(1, { timeout: T_MEDIUM });

    await dispatchAction(ctx.window, "file.openPanel", { path: "README.md" });
    await expect(filePanes(ctx.window)).toHaveCount(2, { timeout: T_LONG });
  });

  test("file.openPanel opens non-markdown files as source, with no Rendered toggle", async () => {
    await dispatchAction(ctx.window, "file.openPanel", { path: "styles.css" });
    await expect(filePanes(ctx.window)).toHaveCount(3, { timeout: T_LONG });

    const cssPane = filePanes(ctx.window).nth(2);
    await expect(cssPane.locator(".cm-content")).toContainText("rebeccapurple", {
      timeout: T_LONG,
    });

    const cssPanel = ctx.window.locator(SEL.panel.gridPanel).filter({ has: cssPane });
    await expect(cssPanel.getByRole("button", { name: "Rendered", exact: true })).toHaveCount(0);
  });

  test("file.read action returns markdown content for the MCP surface", async () => {
    const result = await dispatchAction(ctx.window, "file.read", { path: "spec.md" });
    expect(JSON.stringify(result)).toContain("Markdown E2E Spec");
  });

  test("file panel moves to the dock, previews from the chip, and restores to the grid", async () => {
    const panel = ctx.window
      .locator(SEL.panel.gridPanel)
      .filter({ has: ctx.window.locator('[data-testid="file-pane-body"]') })
      .first();

    // The docked panel stays mounted in the offscreen parking container, so
    // count GRID membership rather than total pane instances.
    const gridFilePanels = ctx.window
      .locator(SEL.panel.gridPanel)
      .filter({ has: ctx.window.locator('[data-testid="file-pane-body"]') });

    await panel.locator('[data-testid="panel-move-to-dock"]').click();
    await expect(gridFilePanels).toHaveCount(2, { timeout: T_MEDIUM });

    // The chip carries the file name; clicking opens the dock popover with the
    // panel's live content relocated into it.
    const chip = ctx.window.locator("[data-dock-item]", { hasText: "spec.md" });
    await expect(chip).toBeVisible({ timeout: T_MEDIUM });
    await chip.click();
    await expect(
      ctx.window.locator('[data-dock-portal-target] [data-testid="file-pane-body"]')
    ).toBeVisible({ timeout: T_LONG });

    // Double-click restores the panel to the grid.
    await chip.dblclick();
    await expect(gridFilePanels).toHaveCount(3, { timeout: T_MEDIUM });
    await expect(chip).not.toBeVisible({ timeout: T_MEDIUM });
  });
});
