import path from "path";
import { writeFileSync, mkdirSync } from "fs";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

// One launch for the three file surfaces: the `file.view` dialog, file grid
// panels, and the worktree file browser (dialog and grid panel).

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

// Long enough to overflow the dialog's 85vh cap in both source and rendered
// mode. Blank-line separated so the rendered document is a tall stack of real
// <p> elements rather than one wrapped paragraph.
const VIEWER_TALL_MARKDOWN =
  "# Tall document\n\n" +
  Array.from(
    { length: 300 },
    (_, i) => `Paragraph ${String(i + 1).padStart(3, "0")} lorem ipsum dolor sit amet.`
  ).join("\n\n") +
  "\n\n## tall-doc-end\n";

// Tall enough to overflow the browser preview in both modes. The long unbroken
// line matters for source mode, where CodeViewer defaults `wrapLines` to false:
// it forces horizontal overflow, so the spec can prove which element owns that
// axis.
const BROWSER_TALL_MARKDOWN =
  "# Tall browser document\n\n" +
  `    const wide = "${"x".repeat(600)}";\n\n` +
  Array.from(
    { length: 300 },
    (_, i) => `Paragraph ${String(i + 1).padStart(3, "0")} lorem ipsum dolor sit amet.`
  ).join("\n\n") +
  "\n\n## file-browser-end\n";

const BROWSER_SHORT_MARKDOWN =
  "# Short browser document\n\nOne paragraph, nowhere near a screenful.\n";

interface DispatchResult {
  ok?: boolean;
  error?: { message?: string };
  result?: { worktrees?: Array<{ id: string; isMain?: boolean }>; panelId?: string };
}

async function dispatchAction(
  page: Page,
  actionId: string,
  args?: unknown
): Promise<DispatchResult> {
  return page.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => Promise<DispatchResult>;
        }
      ).__daintreeDispatchAction(id, a),
    [actionId, args] as const
  );
}

async function dispatchViewFile(page: Page, filePath: string) {
  // Normalize to forward slashes so the renderer's containment check works on
  // Windows. `file.view` resolves once the panel exists; a missing file
  // surfaces later as the pane's error state, so this does not reject for the
  // not-found case.
  await dispatchAction(page, "file.view", {
    path: filePath.replace(/\\/g, "/"),
    rootPath: fixtureDir.replace(/\\/g, "/"),
  });
}

function filePanes(page: Page) {
  return page.locator('[data-testid="file-pane-body"]');
}

async function waitForViewerDialog(page: Page) {
  const dialog = page.locator(SEL.fileViewer.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeViewerDialog(page: Page) {
  await page.locator(SEL.fileViewer.closeButton).click();
  await expect(page.locator(SEL.fileViewer.dialog)).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * Returns the app to an empty grid and dock with no dialog open, so each test
 * below starts from the same state regardless of what ran before it.
 */
async function resetSurfaces(page: Page) {
  const dialogs = page.locator(SEL.fileViewer.dialog);
  await expect(async () => {
    if ((await dialogs.count()) > 0) await page.keyboard.press("Escape");
    await expect(dialogs).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: T_MEDIUM });

  await dispatchAction(page, "terminal.closeAll");
  await expect(page.locator(SEL.panel.gridPanel)).toHaveCount(0, { timeout: T_MEDIUM });
  await expect(page.locator("[data-dock-item]")).toHaveCount(0, { timeout: T_MEDIUM });
}

/**
 * #11254: the pane body owns the scroll inside the dialog too. Without the
 * flex-item sizing contract on the panel root, the panel sizes to the file's
 * intrinsic height instead of the dialog body's, so the pane never overflows
 * internally (no scrollbar) and everything past the first screen is clipped.
 * Mirrors the grid-side proof below (#11024).
 */
async function expectScrollsWithinDialog(pane: Locator) {
  await expect
    .poll(
      () =>
        pane.evaluate((el) => {
          const dialogRect = el.closest('[data-testid="panel-dialog"]')?.getBoundingClientRect();
          return {
            scrollsInternally: el.scrollHeight > el.clientHeight,
            // A real scrollbar, not merely programmatic scrollability: an
            // `overflow: hidden` element still accepts a `scrollTop` write, so
            // the scroll check below would pass on a clipped pane.
            scrollable: ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
            // Bounded by the dialog surface rather than the window: a pane
            // taller than the 85vh dialog still fits the viewport while having
            // its bottom edge — and its scrollbar — clipped away.
            withinDialog:
              dialogRect !== undefined &&
              el.getBoundingClientRect().bottom <= dialogRect.bottom + 1,
          };
        }),
      { timeout: T_MEDIUM }
    )
    .toEqual({ scrollsInternally: true, scrollable: true, withinDialog: true });

  // Content past the first screen is reachable, and scrolling lands on the real
  // bottom rather than some intermediate clamp.
  const scroll = await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const reached = el.scrollTop;
    el.scrollTop = 0;
    return { reached, max: el.scrollHeight - el.clientHeight };
  });
  expect(scroll.reached).toBeGreaterThan(0);
  expect(scroll.reached).toBeGreaterThanOrEqual(scroll.max - 2);
}

// Scoped to the file browser's own marker rather than a bare `panel-dialog`:
// that host is shared, so an unrelated dialog must not satisfy this. Either
// column toggle identifies it — each one unmounts with the column it lives in,
// so neither alone survives every layout the panel can take (#11496).
const BROWSER_DIALOG =
  `${SEL.fileViewer.dialog}:has([data-testid="file-browser-sidebar-toggle"],` +
  ` [data-testid="file-browser-viewer-toggle"])`;

/**
 * The main worktree's id, polled rather than read once: the project's worktree
 * readiness gate is best-effort, so a loaded runner can briefly answer with an
 * empty list.
 */
async function mainWorktreeId(page: Page): Promise<string> {
  let worktreeId: string | undefined;
  await expect
    .poll(
      async () => {
        const listed = await dispatchAction(page, "worktree.list");
        worktreeId = (listed.result?.worktrees ?? []).find((w) => w.isMain)?.id;
        return worktreeId ?? null;
      },
      { timeout: T_MEDIUM }
    )
    .not.toBeNull();
  return worktreeId!;
}

/**
 * Opens the browser through the real action rather than driving the
 * virtualized tree: `revealPath` seeds the selection, so the preview renders
 * the file without a click that depends on row virtualization.
 */
async function openFileBrowser(page: Page, revealPath: string) {
  const worktreeId = await mainWorktreeId(page);

  const opened = await dispatchAction(page, "worktree.openFileBrowser", {
    worktreeId,
    revealPath,
    revealKind: "file",
  });
  if (opened.ok === false) {
    throw new Error(`openFileBrowser failed: ${opened.error?.message ?? "unknown"}`);
  }

  const dialog = page.locator(BROWSER_DIALOG);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

async function closeBrowserDialog(page: Page) {
  await page.locator(BROWSER_DIALOG).locator(SEL.fileViewer.closeButton).first().click();
  await expect(page.locator(BROWSER_DIALOG)).not.toBeVisible({ timeout: T_SHORT });
}

/**
 * Vertical scroll ownership: the element scrolls, and its scrollbar is on
 * screen.
 *
 * The containment check measures the dialog SURFACE, not `panel-dialog` — that
 * test id sits on AppDialog's inset-0 backdrop, so measuring against it would
 * only prove the pane ends before the window bottom. The bounded surface is the
 * backdrop's first child; without that, a pane clipped by the surface's own
 * overflow-hidden still passes.
 */
async function expectOwnsVerticalScroll(scrollOwner: Locator) {
  await expect
    .poll(
      () =>
        scrollOwner.evaluate((el) => {
          const surfaceRect = el
            .closest('[data-testid="panel-dialog"]')
            ?.firstElementChild?.getBoundingClientRect();
          const rect = el.getBoundingClientRect();
          return {
            // A collapsed root with overflowing content would otherwise satisfy
            // the overflow check below while showing nothing.
            hasHeight: el.clientHeight > 0,
            scrollsVertically: el.scrollHeight > el.clientHeight,
            // A real scrollbar, not merely programmatic scrollability: an
            // `overflow: hidden` element still accepts a `scrollTop` write.
            scrollable: ["auto", "scroll"].includes(getComputedStyle(el).overflowY),
            withinSurface:
              surfaceRect !== undefined &&
              rect.bottom <= surfaceRect.bottom + 1 &&
              rect.top >= surfaceRect.top - 1,
          };
        }),
      { timeout: T_MEDIUM }
    )
    .toEqual({
      hasHeight: true,
      scrollsVertically: true,
      scrollable: true,
      withinSurface: true,
    });

  // Content past the first screen is reachable, and scrolling lands on the real
  // bottom rather than some intermediate clamp. Reset afterwards so a later
  // assertion starts from a known position.
  const vertical = await scrollOwner.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const reached = el.scrollTop;
    el.scrollTop = 0;
    return { reached, max: el.scrollHeight - el.clientHeight };
  });
  expect(vertical.reached).toBeGreaterThan(0);
  expect(vertical.reached).toBeGreaterThanOrEqual(vertical.max - 2);
}

test.describe("Core: File surfaces", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "file-surfaces",
      withMultipleFiles: true,
      withImageFile: true,
      withUncommittedChanges: true,
    });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFileSync(path.join(dir, "spec.md"), SPEC_MARKDOWN);
    writeFileSync(path.join(dir, "styles.css"), STYLES_CSS);
    writeFileSync(path.join(dir, "tall.txt"), TALL_TEXT);
    writeFileSync(path.join(dir, "short.txt"), SHORT_TEXT);
    writeFileSync(path.join(dir, "viewer-tall.md"), VIEWER_TALL_MARKDOWN);
    writeFileSync(path.join(dir, "browser-tall.md"), BROWSER_TALL_MARKDOWN);
    writeFileSync(path.join(dir, "browser-short.md"), BROWSER_SHORT_MARKDOWN);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "File Surfaces");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  // One journey: the dialog's mode carries into the panel it is promoted to,
  // and file.openPanel then reuses that same panel.
  test.describe.serial("Markdown dialog promoted to a panel", () => {
    test.beforeAll(async () => {
      await resetSurfaces(ctx.window);
    });

    test("dialog opens markdown as source by default, with wrapping on", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "spec.md"));

      const dialog = await waitForViewerDialog(ctx.window);

      // Source-first: raw markdown in CodeMirror, including literal markers.
      await expect(dialog.locator(".cm-content")).toContainText("# Markdown E2E Spec", {
        timeout: T_LONG,
      });
      await expect(dialog.locator(SEL.fileViewer.metadataBar)).toBeVisible({ timeout: T_SHORT });

      // Markdown source wraps by default (EditorView.lineWrapping tags cm-content).
      await expect(dialog.locator(".cm-content.cm-lineWrapping")).toBeVisible({
        timeout: T_SHORT,
      });
    });

    test("Rendered mode renders the document with theme-token colors", async () => {
      const dialog = ctx.window.locator(SEL.fileViewer.dialog);
      await dialog.getByRole("radio", { name: "Rendered", exact: true }).click();

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
      await dialog.locator(SEL.fileViewer.openAsPanel).click();

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

      await panel.getByRole("radio", { name: "Source", exact: true }).click();
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

      await panel.getByRole("radio", { name: "Rendered", exact: true }).click();
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
  });

  test.describe("File viewer dialog", () => {
    test.beforeEach(async () => {
      await resetSurfaces(ctx.window);
    });

    test("a text file opens with its filename, content and metadata bar", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "src", "index.ts"));

      const dialog = await waitForViewerDialog(ctx.window);
      await expect(dialog.getByRole("heading", { name: /index\.ts/ })).toBeVisible({
        timeout: T_SHORT,
      });

      // On Windows CI the IPC file read can be very slow, so use a generous timeout.
      await expect(dialog).toContainText("console.log", { timeout: T_LONG });

      // Once content is loaded, the metadata bar is rendered from the same state
      const metadataBar = dialog.locator(SEL.fileViewer.metadataBar);
      await expect(metadataBar).toBeVisible({ timeout: T_MEDIUM });
      await expect(metadataBar).toContainText("lines", { timeout: T_SHORT });
      await expect(metadataBar).toContainText("UTF-8", { timeout: T_SHORT });

      await closeViewerDialog(ctx.window);
    });

    test("a file taller than the dialog scrolls internally in source and rendered mode", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "viewer-tall.md"));

      const dialog = await waitForViewerDialog(ctx.window);
      const pane = dialog.locator('[data-testid="file-pane-body"]');

      // Markdown opens as source first.
      await expect(dialog.locator(".cm-content")).toContainText("# Tall document", {
        timeout: T_LONG,
      });
      await expectScrollsWithinDialog(pane);

      // The issue reports both modes clipping, and rendered markdown is a
      // different content subtree, so it needs its own proof.
      await dialog.getByRole("radio", { name: "Rendered", exact: true }).click();
      await expect(dialog.locator(".markdown-document h1")).toHaveText("Tall document", {
        timeout: T_LONG,
      });
      await expectScrollsWithinDialog(pane);

      // The symptom in the issue was the tail of the document being unreachable,
      // so prove the last node actually comes into view. Rendered mode only:
      // CodeMirror virtualizes its line list, so the source-mode tail is not in
      // the DOM to assert against.
      await pane.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(dialog.locator(".markdown-document h2")).toBeInViewport({ timeout: T_SHORT });

      await closeViewerDialog(ctx.window);
    });

    test("image file opens in image preview mode", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "assets", "logo.png"));

      const dialog = await waitForViewerDialog(ctx.window);

      // Image mode renders an <img> element
      const img = dialog.locator(SEL.fileViewer.image);
      await expect(img).toBeVisible({ timeout: T_MEDIUM });

      // Verify the image actually loaded (naturalWidth > 0). The src is a
      // daintree-file:// custom protocol URL, so poll until the fetch resolves
      // and the browser finishes decoding rather than reading complete once.
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), {
          timeout: T_MEDIUM,
        })
        .toBe(true);

      // Header should show the filename. Scoped to the heading: the panel's own
      // toolbar also renders the path, so a bare text match is now ambiguous.
      await expect(dialog.getByRole("heading", { name: /logo\.png/ })).toBeVisible({
        timeout: T_SHORT,
      });

      await closeViewerDialog(ctx.window);
    });

    test("non-existent file shows error message", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "does-not-exist.txt"));

      const dialog = await waitForViewerDialog(ctx.window);
      const unavailable = dialog.getByTestId("file-pane-unavailable");
      await expect(unavailable).toBeVisible({ timeout: T_MEDIUM });
      await expect(unavailable).toContainText("This file was deleted");
      await expect(unavailable).toContainText("It's no longer on disk.");

      await closeViewerDialog(ctx.window);
    });

    test("modal closes via Escape key", async () => {
      await dispatchViewFile(ctx.window, path.join(fixtureDir, "src", "index.ts"));
      await waitForViewerDialog(ctx.window);

      await ctx.window.keyboard.press("Escape");
      await expect(ctx.window.locator(SEL.fileViewer.dialog)).not.toBeVisible({
        timeout: T_SHORT,
      });
    });
  });

  test.describe("File grid panels", () => {
    test.beforeEach(async () => {
      await resetSurfaces(ctx.window);
    });

    test("file.openPanel opens non-markdown files as source, with no Rendered toggle", async () => {
      await dispatchAction(ctx.window, "file.openPanel", { path: "styles.css" });
      await expect(filePanes(ctx.window)).toHaveCount(1, { timeout: T_LONG });

      const cssPane = filePanes(ctx.window).first();
      await expect(cssPane.locator(".cm-content")).toContainText("rebeccapurple", {
        timeout: T_LONG,
      });

      const cssPanel = ctx.window.locator(SEL.panel.gridPanel).filter({ has: cssPane });
      await expect(cssPanel.getByRole("radio", { name: "Rendered", exact: true })).toHaveCount(0);
    });

    test("file panel moves to the dock, previews from the chip, and restores to the grid", async () => {
      await dispatchAction(ctx.window, "file.openPanel", {
        path: path.join(fixtureDir, "spec.md").replace(/\\/g, "/"),
      });

      // The docked panel stays mounted in the offscreen parking container, so
      // count GRID membership rather than total pane instances.
      const gridFilePanels = ctx.window
        .locator(SEL.panel.gridPanel)
        .filter({ has: ctx.window.locator('[data-testid="file-pane-body"]') });
      await expect(gridFilePanels).toHaveCount(1, { timeout: T_LONG });

      await gridFilePanels.first().locator('[data-testid="panel-move-to-dock"]').click();
      await expect(gridFilePanels).toHaveCount(0, { timeout: T_MEDIUM });

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
      await expect(gridFilePanels).toHaveCount(1, { timeout: T_MEDIUM });
      await expect(chip).not.toBeVisible({ timeout: T_MEDIUM });
    });

    test("a file taller than its pane scrolls internally instead of blowing out the grid", async () => {
      await dispatchAction(ctx.window, "file.openPanel", { path: "tall.txt" });

      const tallPane = filePanes(ctx.window).filter({ hasText: "tall-line-001" });
      await expect(tallPane).toHaveCount(1, { timeout: T_LONG });
      // Only one file panel exists: the open must not have spawned extras.
      await expect(filePanes(ctx.window)).toHaveCount(1, { timeout: T_SHORT });
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

      const shortPane = filePanes(ctx.window).filter({ hasText: "short-line-1" });
      await expect(shortPane).toHaveCount(1, { timeout: T_LONG });
      // Only one file panel exists: the open must not have spawned extras.
      await expect(filePanes(ctx.window)).toHaveCount(1, { timeout: T_SHORT });
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
    // exercise Chromium's iframe origin/CSP).
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
          // connect-src 'none' must hold: a fetch to the legacy daintree-file://
          // arbitrary-read route must be blocked by the token-scoped preview CSP.
          // If the trusted app CSP had leaked onto this frame, this would resolve.
          "    t.setAttribute('data-fetch', 'pending');",
          "    fetch('daintree-file://load?path=/etc/passwd&root=/')",
          "      .then(function () { t.setAttribute('data-fetch', 'allowed'); })",
          "      .catch(function () { t.setAttribute('data-fetch', 'blocked'); });",
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
      // The token-scoped preview CSP (connect-src 'none') is authoritative — the
      // trusted app CSP is NOT overlaid onto the frame, so the legacy daintree-file
      // arbitrary-read route is unreachable.
      await expect(title).toHaveAttribute("data-fetch", "blocked", { timeout: T_MEDIUM });
    });
  });

  test.describe("File browser", () => {
    test.beforeEach(async () => {
      await resetSurfaces(ctx.window);
    });

    test("rendered markdown taller than the preview scrolls inside it", async () => {
      const dialog = await openFileBrowser(ctx.window, "browser-tall.md");

      // Rendered is the browser's default markdown mode.
      await expect(dialog.locator(".markdown-document")).toContainText("Paragraph 001", {
        timeout: T_LONG,
      });

      // #11441: MarkdownDocument brings no scroller of its own, so before the fix
      // nothing between the pane and the document was a scroll container.
      const scrollRoot = dialog.getByTestId("file-browser-markdown-scroll");
      await expectOwnsVerticalScroll(scrollRoot);

      // The document grows instead of clamping to the wrapper — restoring
      // `h-full` on the MarkdownViewer call fails right here.
      await expect
        .poll(
          () =>
            scrollRoot.evaluate((el) => {
              const doc = el.firstElementChild;
              return doc instanceof HTMLElement && doc.scrollHeight <= doc.clientHeight + 1;
            }),
          { timeout: T_MEDIUM }
        )
        .toBe(true);

      // The user-visible symptom: the tail of the document was unreachable.
      // ratio 1 — a single visible pixel of the heading is not "readable".
      await scrollRoot.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(dialog.getByRole("heading", { name: /file-browser-end/ })).toBeInViewport({
        ratio: 1,
        timeout: T_MEDIUM,
      });

      await closeBrowserDialog(ctx.window);
    });

    test("markdown source mode keeps one scrollport that owns both axes", async () => {
      const dialog = await openFileBrowser(ctx.window, "browser-tall.md");
      await expect(dialog.locator(".markdown-document")).toBeVisible({ timeout: T_LONG });

      await dialog.getByRole("radio", { name: "Source", exact: true }).click();
      await expect(dialog.locator(".cm-content")).toContainText("# Tall browser document", {
        timeout: T_LONG,
      });

      const wrapButton = dialog.getByRole("button", { name: "Wrap long lines" });
      if ((await wrapButton.getAttribute("aria-pressed")) === "true") {
        await wrapButton.click();
      }
      await expect(wrapButton).toHaveAttribute("aria-pressed", "false");

      // Source mode is deliberately left unwrapped: CodeViewer at pane height is
      // the single scrollport, which keeps its horizontal scrollbar on screen.
      // Handing the vertical axis to an outer wrapper would let this element grow
      // to content height, stranding the horizontal scrollbar below the fold.
      await expect(dialog.getByTestId("file-browser-markdown-scroll")).toHaveCount(0);

      // Resolved by walking up from the editor to the nearest scrollable
      // ancestor: the invariant is about whichever element actually owns the
      // scroll, not about a particular tag or test id.
      await expect
        .poll(
          () =>
            dialog.locator(".cm-editor").evaluate((cm) => {
              let owner = cm.parentElement;
              while (owner && !["auto", "scroll"].includes(getComputedStyle(owner).overflowY)) {
                owner = owner.parentElement;
              }
              if (!owner) return { found: false };
              const surfaceRect = owner
                .closest('[data-testid="panel-dialog"]')
                ?.firstElementChild?.getBoundingClientRect();
              const rect = owner.getBoundingClientRect();
              return {
                found: true,
                ownsVertical: owner.scrollHeight > owner.clientHeight,
                ownsHorizontal: owner.scrollWidth > owner.clientWidth,
                horizontalScrollable: ["auto", "scroll"].includes(
                  getComputedStyle(owner).overflowX
                ),
                withinSurface: surfaceRect !== undefined && rect.bottom <= surfaceRect.bottom + 1,
              };
            }),
          { timeout: T_MEDIUM }
        )
        .toEqual({
          found: true,
          ownsVertical: true,
          ownsHorizontal: true,
          horizontalScrollable: true,
          withinSurface: true,
        });

      await closeBrowserDialog(ctx.window);
    });

    test("a short markdown document fills the preview instead of stopping at its own height", async () => {
      const dialog = await openFileBrowser(ctx.window, "browser-short.md");
      await expect(dialog.locator(".markdown-document")).toContainText("One paragraph", {
        timeout: T_LONG,
      });

      // `min-h-full` rather than no class at all: the document reaches the bottom
      // of the preview so its background doesn't stop mid-pane — and rather than
      // `h-full`, which would clamp it and re-break the tall case above.
      await expect
        .poll(
          () =>
            dialog.getByTestId("file-browser-markdown-scroll").evaluate((el) => {
              const doc = el.firstElementChild;
              return {
                fillsPreview: doc instanceof HTMLElement && doc.offsetHeight >= el.clientHeight - 1,
                noSpuriousOverflow: el.scrollHeight <= el.clientHeight + 1,
              };
            }),
          { timeout: T_MEDIUM }
        )
        .toEqual({ fillsPreview: true, noSpuriousOverflow: true });

      await closeBrowserDialog(ctx.window);
    });

    // The dialog tests above are the other half of this contract: the reveal
    // action stays ephemeral even when handed an explicit worktreeId, and only
    // this separate action puts a browser in the grid (#11666).
    test("the panel action opens a grid browser and reuses it on a second press", async () => {
      const worktreeId = await mainWorktreeId(ctx.window);

      const opened = await dispatchAction(ctx.window, "worktree.openFileBrowserPanel", {
        worktreeId,
      });
      expect(opened.ok, opened.error?.message).toBe(true);
      const panelId = opened.result?.panelId;
      expect(panelId).toBeTruthy();

      const panel = ctx.window.locator(`[data-panel-id="${panelId}"]${SEL.panel.gridPanel}`);
      await expect(panel).toBeVisible({ timeout: T_MEDIUM });
      // A grid panel, not a modal — the whole point of the split.
      await expect(ctx.window.locator(BROWSER_DIALOG)).toHaveCount(0);

      // Pressing again focuses what's already open rather than stacking a second
      // browser onto the same folder.
      const reopened = await dispatchAction(ctx.window, "worktree.openFileBrowserPanel", {
        worktreeId,
      });
      expect(reopened.result?.panelId).toBe(panelId);
      await expect(
        ctx.window.locator(
          `${SEL.panel.gridPanel}:has([data-testid="file-browser-sidebar-toggle"])`
        )
      ).toHaveCount(1);

      await panel.locator(SEL.panel.close).first().click();
      await expect(panel).toHaveCount(0, { timeout: T_SHORT });
    });

    // #11917 — the browser used to opt out of the dock entirely, so its header
    // offered only maximize and close.
    test("the grid browser moves to the dock, previews from the chip, and restores", async () => {
      const worktreeId = await mainWorktreeId(ctx.window);

      const opened = await dispatchAction(ctx.window, "worktree.openFileBrowserPanel", {
        worktreeId,
      });
      expect(opened.ok, opened.error?.message).toBe(true);
      const panelId = opened.result?.panelId;
      const panel = ctx.window.locator(`[data-panel-id="${panelId}"]${SEL.panel.gridPanel}`);
      await expect(panel).toBeVisible({ timeout: T_MEDIUM });

      // The docked panel stays mounted in the offscreen parking container, so
      // count GRID membership rather than total pane instances.
      const gridBrowsers = ctx.window.locator(
        `${SEL.panel.gridPanel}:has([data-testid="file-browser-sidebar-toggle"])`
      );
      await expect(gridBrowsers).toHaveCount(1, { timeout: T_MEDIUM });

      await panel.locator('[data-testid="panel-move-to-dock"]').click();
      await expect(gridBrowsers).toHaveCount(0, { timeout: T_MEDIUM });

      // Anchored on this panel's own sortable wrapper rather than on the label:
      // dock titles are not unique, so a same-named terminal chip would otherwise
      // turn this into a strict-mode ambiguity instead of an assertion.
      const chip = ctx.window.locator(`[data-dock-item-id="${panelId}"] [data-dock-item]`);
      await expect(chip).toBeVisible({ timeout: T_MEDIUM });
      // The chip drops the composed title's "Files — " prefix, so what is left is
      // the branch that distinguishes this browser from another worktree's.
      // Exact, not a substring: "Files — main" is precisely what this trims.
      await expect(chip).toHaveText("main", { timeout: T_SHORT });
      await chip.click();
      await expect(
        ctx.window.locator('[data-dock-portal-target] [data-testid="file-browser-sidebar-toggle"]')
      ).toBeVisible({ timeout: T_LONG });

      // Double-click restores it to the grid, the same gesture docked file
      // panels answer to.
      await chip.dblclick();
      await expect(gridBrowsers).toHaveCount(1, { timeout: T_MEDIUM });
      await expect(chip).not.toBeVisible({ timeout: T_MEDIUM });

      await panel.locator(SEL.panel.close).first().click();
      await expect(panel).toHaveCount(0, { timeout: T_SHORT });
    });
  });
});
