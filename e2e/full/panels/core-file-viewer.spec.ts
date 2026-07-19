import path from "path";
import { test, expect } from "@playwright/test";
import { launchApp, closeApp, type AppContext } from "../../helpers/launch";
import { createFixtureRepo } from "../../helpers/fixtures";
import { openAndOnboardProject } from "../../helpers/project";
import { SEL } from "../../helpers/selectors";
import { T_SHORT, T_MEDIUM, T_LONG } from "../../helpers/timeouts";

let ctx: AppContext;
let fixtureDir: string;
let fixtureCleanup: (() => void) | undefined;

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

    // Header should show the filename
    await expect(dialog.locator("text=logo.png")).toBeVisible({ timeout: T_SHORT });

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
