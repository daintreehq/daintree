import path from "path";
import { writeFileSync, mkdirSync } from "fs";
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

const TALL_TEXT =
  Array.from(
    { length: 400 },
    (_, i) => `tall-line-${String(i + 1).padStart(3, "0")} lorem ipsum dolor sit amet`
  ).join("\n") + "\n";

const SHORT_TEXT = "short-line-1\nshort-line-2\nshort-line-3\n";

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
    writeFileSync(path.join(dir, "tall.txt"), TALL_TEXT);
    writeFileSync(path.join(dir, "short.txt"), SHORT_TEXT);
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

    // #10991: a single docked file panel exposes the inline "Move to grid"
    // button in its header (matching docked terminals), not just the overflow
    // menu.
    await expect(
      ctx.window.locator('[data-dock-portal-target] [data-testid="panel-move-to-grid"]')
    ).toBeVisible({ timeout: T_SHORT });

    // Double-click restores the panel to the grid.
    await chip.dblclick();
    await expect(gridFilePanels).toHaveCount(3, { timeout: T_MEDIUM });
    await expect(chip).not.toBeVisible({ timeout: T_MEDIUM });
  });

  test("a file taller than its pane scrolls internally instead of blowing out the grid", async () => {
    await dispatchAction(ctx.window, "file.openPanel", { path: "tall.txt" });
    await expect(filePanes(ctx.window)).toHaveCount(4, { timeout: T_LONG });

    const tallPane = filePanes(ctx.window).filter({ hasText: "tall-line-001" }).first();
    await expect(tallPane.locator(".cm-content")).toBeVisible({ timeout: T_LONG });

    // #11024: the pane body owns the scroll. Without the grid-item min-height
    // fix the cell inflates to the file's intrinsic height, so the pane has no
    // internal scroll and its client height explodes past the window.
    await expect
      .poll(
        () =>
          tallPane.evaluate((el) => ({
            scrollsInternally: el.scrollHeight > el.clientHeight,
            paneBounded: el.clientHeight <= window.innerHeight,
          })),
        { timeout: T_MEDIUM }
      )
      .toEqual({ scrollsInternally: true, paneBounded: true });
  });

  test("a short file's editor surface stretches to fill the pane", async () => {
    await dispatchAction(ctx.window, "file.openPanel", { path: "short.txt" });
    await expect(filePanes(ctx.window)).toHaveCount(5, { timeout: T_LONG });

    const shortPane = filePanes(ctx.window).filter({ hasText: "short-line-1" }).first();
    await expect(shortPane.locator(".cm-content")).toBeVisible({ timeout: T_LONG });

    // The min-h-full column mirrors the file viewer dialog: the editor surface
    // reaches the bottom of the pane, and the pane background resolves to the
    // same color as the editor background so the fill is seamless.
    await expect
      .poll(
        () =>
          shortPane.evaluate((el) => {
            const column = el.firstElementChild;
            const editor = el.querySelector(".cm-editor");
            return {
              columnFillsPane:
                column instanceof HTMLElement && column.offsetHeight >= el.clientHeight - 1,
              backgroundsMatch:
                editor !== null &&
                getComputedStyle(el).backgroundColor === getComputedStyle(editor).backgroundColor,
            };
          }),
        { timeout: T_MEDIUM }
      )
      .toEqual({ columnFillsPane: true, backgroundsMatch: true });
  });

  // #11191: rendered HTML runs the page's own scripts, resolves its relative
  // assets via daintree-html://, and stays isolated from the app. This is the
  // only automated proof of the runtime security contract (unit tests can't
  // exercise Chromium's iframe origin/CSP). Located last, by content not count.
  test("rendered HTML runs its scripts + relative assets while staying sandboxed", async () => {
    const assetsDir = path.join(fixtureDir, "html-report", "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, "report.css"), "#title { color: rgb(12, 34, 56); }\n");
    writeFileSync(
      path.join(assetsDir, "report.js"),
      "document.getElementById('title').setAttribute('data-external-ran', 'yes');\n"
    );
    writeFileSync(
      path.join(fixtureDir, "html-report", "index.html"),
      [
        "<!doctype html>",
        "<html>",
        '<head><link rel="stylesheet" href="assets/report.css" /></head>',
        "<body>",
        '  <h1 id="title">Report</h1>',
        '  <script src="assets/report.js"></script>',
        "  <script>",
        "    var t = document.getElementById('title');",
        "    t.setAttribute('data-inline-ran', 'yes');",
        "    t.setAttribute('data-has-electron', String(typeof window.electron !== 'undefined'));",
        "    try { void window.parent.document; t.setAttribute('data-parent', 'reachable'); }",
        "    catch (e) { t.setAttribute('data-parent', 'blocked'); }",
        "  </script>",
        "</body>",
        "</html>",
      ].join("\n")
    );

    await dispatchAction(ctx.window, "file.openPanel", {
      path: path.join(fixtureDir, "html-report", "index.html").replace(/\\/g, "/"),
      viewMode: "rendered",
    });

    const frameEl = ctx.window.locator('[data-testid="html-preview-frame"]');
    await expect(frameEl).toBeVisible({ timeout: T_LONG });
    // Exactly allow-scripts — never allow-same-origin (that would let the page
    // escape its opaque origin back into the daintree-html:// partition).
    await expect(frameEl).toHaveAttribute("sandbox", "allow-scripts");

    const frame = ctx.window.frameLocator('[data-testid="html-preview-frame"]');
    const title = frame.locator("#title");

    // The page's own inline + relative external scripts execute.
    await expect(title).toHaveAttribute("data-inline-ran", "yes", { timeout: T_LONG });
    await expect(title).toHaveAttribute("data-external-ran", "yes", { timeout: T_MEDIUM });
    // Relative stylesheet resolved via daintree-html:// and applied.
    await expect
      .poll(() => title.evaluate((el) => getComputedStyle(el).color), { timeout: T_MEDIUM })
      .toBe("rgb(12, 34, 56)");

    // Isolation: no app bridge, and the opaque-origin frame can't reach the parent.
    await expect(title).toHaveAttribute("data-has-electron", "false");
    await expect(title).toHaveAttribute("data-parent", "blocked");
  });
});
