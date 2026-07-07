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

function markdownPanes(page: Page) {
  return page.locator('[data-testid="markdown-pane-body"]');
}

test.describe.serial("Core: Markdown viewer (dialog + panel)", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({ name: "markdown-viewer" });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFileSync(path.join(dir, "spec.md"), SPEC_MARKDOWN);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "Markdown Viewer");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("dialog opens markdown rendered by default (heading, table, highlighted fence)", async () => {
    await dispatchViewFile(ctx.window, path.join(fixtureDir, "spec.md"));

    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await expect(dialog).toBeVisible({ timeout: T_MEDIUM });

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
  });

  test("dialog Source mode shows the raw markdown, Rendered switches back", async () => {
    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await dialog.getByRole("button", { name: "Source", exact: true }).click();

    // Raw markdown source in CodeMirror, including literal markers.
    await expect(dialog.locator(".cm-content")).toContainText("# Markdown E2E Spec", {
      timeout: T_LONG,
    });
    await expect(dialog.locator(SEL.fileViewer.metadataBar)).toBeVisible({ timeout: T_SHORT });

    await dialog.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(dialog.locator(".markdown-document h1")).toBeVisible({ timeout: T_MEDIUM });
  });

  test("Open as panel promotes the dialog into a markdown grid panel", async () => {
    const dialog = ctx.window.locator(SEL.fileViewer.dialog);
    await dialog.locator('[data-testid="file-viewer-open-as-panel"]').click();

    await expect(dialog).not.toBeVisible({ timeout: T_MEDIUM });

    const pane = markdownPanes(ctx.window).first();
    await expect(pane).toBeVisible({ timeout: T_LONG });
    await expect(pane.locator(".markdown-document h1")).toHaveText("Markdown E2E Spec", {
      timeout: T_LONG,
    });
  });

  test("panel toolbar toggles between rendered and source", async () => {
    const pane = markdownPanes(ctx.window).first();
    const panel = ctx.window.locator(SEL.panel.gridPanel).filter({ has: pane });

    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await expect(pane.locator(".cm-content")).toContainText("# Markdown E2E Spec", {
      timeout: T_LONG,
    });

    await panel.getByRole("button", { name: "Rendered", exact: true }).click();
    await expect(pane.locator(".markdown-document h1")).toBeVisible({ timeout: T_MEDIUM });
  });

  test("markdown.openPanel reuses the panel for the same file and creates one for a new file", async () => {
    await dispatchAction(ctx.window, "markdown.openPanel", {
      path: path.join(fixtureDir, "spec.md").replace(/\\/g, "/"),
    });
    await expect(markdownPanes(ctx.window)).toHaveCount(1, { timeout: T_MEDIUM });

    await dispatchAction(ctx.window, "markdown.openPanel", { path: "README.md" });
    await expect(markdownPanes(ctx.window)).toHaveCount(2, { timeout: T_LONG });
    await expect(markdownPanes(ctx.window).nth(1).locator(".markdown-document h1")).toBeVisible({
      timeout: T_LONG,
    });
  });

  test("file.read action returns markdown content for the MCP surface", async () => {
    const result = await dispatchAction(ctx.window, "file.read", { path: "spec.md" });
    expect(JSON.stringify(result)).toContain("Markdown E2E Spec");
  });
});
