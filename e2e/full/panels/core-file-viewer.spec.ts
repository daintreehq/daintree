import path from "path";
import { writeFileSync } from "fs";
import { test, expect, type Locator } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

// Long enough to overflow the dialog's 85vh cap in both source and rendered
// mode. Blank-line separated so the rendered document is a tall stack of real
// <p> elements rather than one wrapped paragraph.
const TALL_MARKDOWN =
  "# Tall document\n\n" +
  Array.from(
    { length: 300 },
    (_, i) => `Paragraph ${String(i + 1).padStart(3, "0")} lorem ipsum dolor sit amet.`
  ).join("\n\n") +
  "\n\n## tall-doc-end\n";

async function dispatchViewFile(ctx: AppContext, filePath: string, rootPath?: string) {
  // Normalize to forward slashes so the renderer's containment check works on Windows
  const normPath = filePath.replace(/\\/g, "/");
  const normRoot = (rootPath ?? fixtureDir).replace(/\\/g, "/");
  // `file.view` opens the panel dialog directly now, so drive the action rather
  // than the retired `daintree:view-file` window event. The action resolves once
  // the panel exists; a missing file surfaces later as the pane's error state,
  // so this does not reject for the not-found case.
  await ctx.window.evaluate(
    ([id, a]) =>
      (
        window as unknown as {
          __daintreeDispatchAction: (id: string, a?: unknown) => unknown;
        }
      ).__daintreeDispatchAction(id, a),
    ["file.view", { path: normPath, rootPath: normRoot }] as const
  );
}

async function waitForDialog(ctx: AppContext) {
  const dialog = ctx.window.locator(SEL.fileViewer.dialog);
  await expect(dialog).toBeVisible({ timeout: T_MEDIUM });
  return dialog;
}

/**
 * #11254: the pane body owns the scroll inside the dialog too. Without the
 * flex-item sizing contract on the panel root, the panel sizes to the file's
 * intrinsic height instead of the dialog body's, so the pane never overflows
 * internally (no scrollbar) and everything past the first screen is clipped.
 * Mirrors the grid-side proof in core-file-panel.spec.ts (#11024).
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

async function closeDialog(ctx: AppContext) {
  await ctx.window.locator(SEL.fileViewer.closeButton).click();
  await expect(ctx.window.locator(SEL.fileViewer.dialog)).not.toBeVisible({
    timeout: T_SHORT,
  });
}

test.describe.serial("Core: File Viewer Modal", () => {
  test.beforeAll(async () => {
    const { dir, cleanup } = createFixtureRepo({
      name: "file-viewer",
      withMultipleFiles: true,
      withImageFile: true,
      withUncommittedChanges: true,
    });
    fixtureDir = dir;
    fixtureCleanup = cleanup;
    writeFileSync(path.join(dir, "tall.md"), TALL_MARKDOWN);
    ctx = await launchApp();
    ctx.window = await openAndOnboardProject(ctx.app, ctx.window, fixtureDir, "File Viewer Test");
  });

  test.afterAll(async () => {
    if (ctx?.app) await closeApp(ctx.app);
    fixtureCleanup?.();
  });

  test("modal opens for a text file and shows filename in header", async () => {
    const filePath = path.join(fixtureDir, "src", "index.ts");
    await dispatchViewFile(ctx, filePath);

    const dialog = await waitForDialog(ctx);
    await expect(dialog.getByRole("heading", { name: /index\.ts/ })).toBeVisible({
      timeout: T_SHORT,
    });

    await closeDialog(ctx);
  });

  test("text file content is displayed in the code viewer", async () => {
    const filePath = path.join(fixtureDir, "src", "index.ts");
    await dispatchViewFile(ctx, filePath);

    const dialog = await waitForDialog(ctx);

    // Wait for the file content to load and appear in the dialog.
    // On Windows CI the IPC file read can be very slow, so use a generous timeout.
    await expect(dialog).toContainText("console.log", { timeout: T_LONG });

    // Once content is loaded, the metadata bar is rendered from the same state
    const metadataBar = dialog.locator(SEL.fileViewer.metadataBar);
    await expect(metadataBar).toBeVisible({ timeout: T_MEDIUM });
    await expect(metadataBar).toContainText("lines", { timeout: T_SHORT });
    await expect(metadataBar).toContainText("UTF-8", { timeout: T_SHORT });

    await closeDialog(ctx);
  });

  test("a file taller than the dialog scrolls internally in source and rendered mode", async () => {
    await dispatchViewFile(ctx, path.join(fixtureDir, "tall.md"));

    const dialog = await waitForDialog(ctx);
    const pane = dialog.locator('[data-testid="file-pane-body"]');

    // Markdown opens as source first.
    await expect(dialog.locator(".cm-content")).toContainText("# Tall document", {
      timeout: T_LONG,
    });
    await expectScrollsWithinDialog(pane);

    // The issue reports both modes clipping, and rendered markdown is a
    // different content subtree, so it needs its own proof.
    await dialog.getByRole("button", { name: "Rendered", exact: true }).click();
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

    await closeDialog(ctx);
  });

  test("image file opens in image preview mode", async () => {
    const filePath = path.join(fixtureDir, "assets", "logo.png");
    await dispatchViewFile(ctx, filePath);

    const dialog = await waitForDialog(ctx);

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

    await closeDialog(ctx);
  });

  test("non-existent file shows error message", async () => {
    const filePath = path.join(fixtureDir, "does-not-exist.txt");
    await dispatchViewFile(ctx, filePath);

    const dialog = await waitForDialog(ctx);
    await expect(dialog.locator("text=File no longer exists")).toBeVisible({
      timeout: T_MEDIUM,
    });

    await closeDialog(ctx);
  });

  test("modal closes via close button", async () => {
    const filePath = path.join(fixtureDir, "src", "index.ts");
    await dispatchViewFile(ctx, filePath);
    await waitForDialog(ctx);

    await ctx.window.locator(SEL.fileViewer.closeButton).click();
    await expect(ctx.window.locator(SEL.fileViewer.dialog)).not.toBeVisible({
      timeout: T_SHORT,
    });
  });

  test("modal closes via Escape key", async () => {
    const filePath = path.join(fixtureDir, "src", "index.ts");
    await dispatchViewFile(ctx, filePath);
    await waitForDialog(ctx);

    await ctx.window.keyboard.press("Escape");
    await expect(ctx.window.locator(SEL.fileViewer.dialog)).not.toBeVisible({
      timeout: T_SHORT,
    });
  });
});
